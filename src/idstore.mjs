import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Keeps the OneBot message_id ↔ native reference mapping across restarts, so ids a bot stored, replies that quote an older message and
// get_msg / delete_msg keep working after OpenQQ is restarted. Only identifiers are written (chat, peer and message ids), never content.
// Writes are best effort: a failure must never get in the way of delivering messages.
const isRef = value => value !== null && typeof value === 'object' && ['message', 'forward'].includes(value.kind) && [1, 2, 100].includes(value.chatType)
  && typeof value.peerUid === 'string' && value.peerUid.length <= 64;

export function createIdStore(path, { limit = 10000, delayMs = 2000 } = {}) {
  let timer = null;
  let snapshot = null;

  function load() {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      if (data?.version !== 1 || !Number.isSafeInteger(data.nextId) || data.nextId < 1 || !Array.isArray(data.entries)) throw new Error('unexpected shape');
      const entries = [];
      let highest = 0;
      for (const item of data.entries) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || item[0].length > 300 || !Number.isSafeInteger(item[1]) || item[1] < 1) continue;
        entries.push([item[0], item[1], isRef(item[2]) ? item[2] : undefined]);
        highest = Math.max(highest, item[1]);
      }
      return { nextId: Math.max(data.nextId, highest + 1), entries: entries.slice(-limit) };
    } catch { return { nextId: 1, entries: [] }; }
  }

  function write() {
    timer = null;
    const take = snapshot;
    snapshot = null;
    if (!take) return;
    const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp';
    try {
      const { nextId, entries } = take();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temp, JSON.stringify({ version: 1, nextId, entries: entries.slice(-limit) }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
    } catch { /* best effort */ }
    // 清理临时文件也是 best-effort：父目录不是目录时 rmSync 会抛 ENOTDIR，
    // 而它在 finally 里 —— 不吞掉就会盖掉上面真正的失败原因，把「写失败被忽略」
    // 变成「flush 抛异常」，把一个刻意容错的路径变成会把异常抛进消息投递的路径。
    finally { try { rmSync(temp, { force: true }); } catch { /* best effort */ } }
  }

  return {
    load,
    // `take` builds { nextId, entries: [[key, id, ref]] } and is only called when the write happens, so a burst of messages costs one write.
    schedule(take) {
      snapshot = take;
      if (!timer) { timer = setTimeout(write, delayMs); timer.unref?.(); }
    },
    flush() { if (timer) clearTimeout(timer); write(); },
  };
}
