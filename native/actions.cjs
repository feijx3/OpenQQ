'use strict';

const { fail, identifier, flag, integer, nativeId } = require('./common.cjs');
const { parseCQ } = require('./cq.cjs');
const admin = require('./admin.cjs');
const extended = require('./extended.cjs');
const { createElementBuilder } = require('./elements.cjs');

const MiB = 1024 * 1024;
const sendActions = ['send_private_msg', 'send_group_msg', 'send_msg'];
const forwardSendActions = ['send_group_forward_msg', 'send_private_forward_msg', 'send_forward_msg'];
const exclusiveTypes = ['json', 'record', 'video', 'file', 'contact'];
const absolutePath = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
  && /^(?:[A-Za-z]:[\\/]|\/)/.test(value) && !/^(?:\\\\|\/\/)/.test(value);
const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;

// Native references are attached by the main process, which owns the OneBot message_id ↔ QQ msgId mapping.
function nativeRef(value, forward = false) {
  if (!value || typeof value !== 'object' || ![1, 2, 100].includes(value.chatType)
    || typeof value.peerUid !== 'string' || !value.peerUid || value.peerUid.length > 64) return null;
  if (forward) return nativeId(value.root) && nativeId(value.parent)
    ? { chatType: value.chatType, peerUid: value.peerUid, root: value.root, parent: value.parent } : null;
  return nativeId(value.msgId) ? { chatType: value.chatType, peerUid: value.peerUid, msgId: value.msgId } : null;
}

// Media descriptions are produced by the main process (src/media.mjs) after it has fetched and inspected the file.
function mediaRef(value, kind) {
  const bad = () => fail(`${kind} 段的文件没有经过处理，或描述无效`);
  if (!value || typeof value !== 'object' || value.kind !== kind || !absolutePath(value.path) || typeof value.name !== 'string' || !value.name
    || value.name.length > 255 || /[\u0000-\u001f\\/]/.test(value.name) || !positive(value.size, 2 ** 40)) throw bad();
  const media = { kind, path: value.path, name: value.name, size: value.size };
  if (kind === 'image' || kind === 'video') {
    if (!positive(value.width, 65535) || !positive(value.height, 65535) || typeof value.format !== 'string') throw bad();
    Object.assign(media, { width: value.width, height: value.height, format: value.format });
  }
  if (kind === 'image' && !['png', 'jpeg', 'gif', 'webp', 'bmp'].includes(value.format)) throw bad();
  if (kind === 'record' || kind === 'video') {
    if (!positive(value.duration, 86400)) throw bad();
    media.duration = value.duration;
  }
  if (kind === 'video') {
    const thumb = value.thumb;
    if (!['mp4', 'mov'].includes(value.format) || !thumb || typeof thumb !== 'object' || !absolutePath(thumb.path) || !positive(thumb.size, 2 ** 40)
      || !positive(thumb.width, 65535) || !positive(thumb.height, 65535)) throw bad();
    media.thumb = { path: thumb.path, size: thumb.size, width: thumb.width, height: thumb.height, format: String(thumb.format ?? '') };
  }
  return media;
}

function segmentsOf(params) {
  if (params.auto_escape !== undefined && typeof params.auto_escape !== 'boolean') throw fail('auto_escape 必须为布尔值');
  if (typeof params.message === 'string') return params.auto_escape ? [{ type: 'text', data: { text: params.message } }] : parseCQ(params.message);
  if (Array.isArray(params.message) && params.message.length <= 100) return params.message;
  throw fail('message 必须为文本、CQ 码字符串或最多 100 个消息段');
}

// A CQ-code string becomes a segment array up front, so the main process can resolve references and media before validation.
function normalizeParams(request) {
  const params = request?.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return request;
  if (sendActions.includes(request?.action)) {
    // auto_escape: false means the same as leaving it out, so the CQ string is still parsed (and its media prepared); other values stay for validation.
    if (typeof params.message !== 'string' || (params.auto_escape !== undefined && params.auto_escape !== false)) return request;
    return { ...request, params: { ...params, message: parseCQ(params.message) } };
  }
  if (forwardSendActions.includes(request?.action) && Array.isArray(params.messages)) {
    const messages = params.messages.map(node => {
      if (!node || typeof node !== 'object' || node.type !== 'node' || !node.data || typeof node.data !== 'object') return node;
      if (typeof node.data.content === 'string') return { ...node, data: { ...node.data, content: parseCQ(node.data.content) } };
      if (node.data.content === undefined && typeof node.data.message === 'string') return { ...node, data: { ...node.data, content: parseCQ(node.data.message) } };
      return node;
    });
    return { ...request, params: { ...params, messages } };
  }
  return request;
}

function messageParts(params, chatType) {
  const parts = segmentsOf(params).map(segment => {
    const data = segment?.data && typeof segment.data === 'object' && !Array.isArray(segment.data) ? segment.data : {};
    switch (segment?.type) {
      case 'text':
        if (typeof data.text !== 'string') throw fail('text 段需要 data.text');
        return { type: 'text', text: data.text };
      case 'reply': {
        const ref = nativeRef(data.openqq_ref);
        if (ref) return { type: 'reply', ref };
        if (data.seq !== undefined && /^[1-9]\d*$/.test(String(data.seq))) return { type: 'reply', seq: String(data.seq) };
        throw fail('reply 段的 id 无效或引用的消息已过期', 1404);
      }
      case 'json': {
        const raw = typeof data.data === 'string' ? data.data : data.data && typeof data.data === 'object' ? JSON.stringify(data.data) : undefined;
        try { if (typeof raw !== 'string' || !JSON.parse(raw) || typeof JSON.parse(raw) !== 'object') throw new Error(); }
        catch { throw fail('json 段的 data 必须是 JSON 对象或其字符串'); }
        return { type: 'json', data: raw };
      }
      case 'at': {
        if (chatType !== 2) throw fail('私聊不能使用 at 段');
        if (String(data.qq) === 'all') return { type: 'at', target: 'all' };
        const name = data.name === undefined ? '' : String(data.name);
        if (name.length > 64 || /[\u0000-\u001f]/.test(name)) throw fail('at 段的 name 过长或包含控制字符');
        return { type: 'at', target: identifier(data.qq, 'at.qq'), name };
      }
      case 'face': {
        const id = typeof data.id === 'string' && /^\d+$/.test(data.id) ? Number(data.id) : data.id;
        if (!Number.isSafeInteger(id) || id < 0 || id > 100000) throw fail('face 段的 id 必须是非负整数');
        return { type: 'face', id };
      }
      case 'dice': case 'rps': return { type: segment.type };
      case 'image': {
        const subType = data.sub_type !== undefined ? integer(data.sub_type, 'image.sub_type', 0, 100, 0) : 0;
        return { type: 'image', media: mediaRef(data.openqq_media, 'image'), summary: typeof data.summary === 'string' ? data.summary.slice(0, 64) : '', subType };
      }
      case 'record': case 'video': case 'file': return { type: segment.type, media: mediaRef(data.openqq_media, segment.type) };
      case 'mface': {
        const emojiId = typeof data.emoji_id === 'string' && data.emoji_id.trim() ? data.emoji_id.trim() : '';
        const pkgId = integer(data.emoji_package_id, 'mface.emoji_package_id', 1, 0x7fffffff);
        const key = typeof data.key === 'string' ? data.key : '';
        if (!emojiId || emojiId.length > 128) throw fail('mface 段需要有效的 emoji_id');
        return { type: 'mface', emojiId, emojiPackageId: pkgId, key, summary: typeof data.summary === 'string' ? data.summary.slice(0, 64) : '' };
      }
      case 'markdown': {
        if (typeof data.content !== 'string' || !data.content) throw fail('markdown 段需要 data.content');
        return { type: 'markdown', content: data.content };
      }
      case 'contact': {
        const contactType = data.type === 'group' ? 'group' : data.type === 'qq' ? 'qq' : '';
        if (!contactType) throw fail('contact 段的 type 必须是 qq 或 group');
        return { type: 'contact', contactType, id: identifier(data.id, 'contact.id') };
      }
      default:
        throw fail(`当前发送支持 text、at、face、image、record、video、file、reply、json、dice、rps、mface、markdown、contact 消息段，暂不支持 ${typeof segment?.type === 'string' ? segment.type : '该消息段'}`);
    }
  });
  if (parts.filter(part => part.type === 'reply').length > 1) throw fail('一条消息最多引用一条消息');
  // QQ treats these as the whole message: they cannot carry text, a quote or other segments alongside.
  const exclusive = parts.find(part => exclusiveTypes.includes(part.type));
  if (exclusive && parts.length !== 1) throw fail(`${exclusive.type} 段必须单独发送，不能与其他消息段混合`);
  const texts = parts.filter(part => part.type === 'text').map(part => part.text);
  const json = parts.find(part => part.type === 'json');
  const md = parts.find(part => part.type === 'markdown');
  if (!parts.some(part => part.type === 'text' ? part.text.length > 0 : part.type !== 'reply')) throw fail('消息不能为空或超过 64 KiB');
  if (Buffer.byteLength(texts.join('') + (json?.data ?? '') + (md?.content ?? '')) > 65536) throw fail('消息不能为空或超过 64 KiB');
  const mediaBytes = parts.reduce((total, part) => total + (part.media ? part.media.size + (part.media.thumb?.size ?? 0) : 0), 0);
  // Uploads finish before QQ reports success, so larger files get more time (never less than the text default).
  return { parts, texts, timeout: Math.min(300000, 15000 + Math.ceil(mediaBytes / MiB) * 4000) };
}

function forwardNodes(rawMessages, chatType) {
  if (!Array.isArray(rawMessages) || rawMessages.length < 1 || rawMessages.length > 100) {
    throw fail('messages 必须是包含 1..100 个 node 的数组');
  }
  let totalMediaBytes = 0;
  const nodes = rawMessages.map(item => {
    if (!item || typeof item !== 'object' || item.type !== 'node' || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
      throw fail('合并转发的每个元素必须是 node 消息段');
    }
    const data = item.data;
    if (data.openqq_ref) {
      const ref = nativeRef(data.openqq_ref);
      if (!ref) throw fail('合并转发节点引用的消息 id 无效或已过期', 1404);
      const name = typeof data.name === 'string' ? data.name.slice(0, 64) : typeof data.nickname === 'string' ? data.nickname.slice(0, 64) : '';
      return { mode: 'ref', ref, name };
    }
    if (data.id !== undefined) throw fail('合并转发节点引用的消息 id 无效或已过期', 1404);
    const content = data.content ?? data.message;
    if (content === undefined || content === null) throw fail('自定义合并转发节点缺少 content');
    const parsed = messageParts({ message: content }, 1);
    totalMediaBytes += parsed.parts.reduce((sum, p) => sum + (p.media ? p.media.size + (p.media.thumb?.size ?? 0) : 0), 0);
    const name = typeof data.name === 'string' ? data.name.slice(0, 64) : typeof data.nickname === 'string' ? data.nickname.slice(0, 64) : '';
    const uin = data.uin !== undefined || data.user_id !== undefined ? identifier(data.uin ?? data.user_id, 'node.uin') : '';
    return { mode: 'custom', name, uin, parts: parsed.parts };
  });
  return { nodes, timeout: Math.min(300000, 20000 + nodes.length * 1000 + Math.ceil(totalMediaBytes / MiB) * 4000) };
}

function validateAction(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.action !== 'string') throw fail('需要 {action, params, echo?} 动作对象');
  const params = request.params ?? {};
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw fail('params 必须为对象');
  if (['get_login_info', 'get_status'].includes(request.action)) return { kind: request.action };
  if (request.action === 'set_input_status') {
    if (!Number.isInteger(params.event_type) || params.event_type < 0 || params.event_type > 0x7fffffff) throw fail('event_type 必须是非负 int32');
    return { kind: 'input', target: identifier(params.user_id, 'user_id'), eventType: params.event_type };
  }
  if (request.action === 'get_forward_msg') {
    const ref = nativeRef(params.openqq_ref, true);
    if (!ref) throw fail('合并转发 id 无效或已过期（仅支持本次运行期间收到的消息）', 1404);
    return { kind: 'forward', ref };
  }
  if (request.action === 'get_msg') {
    const ref = nativeRef(params.openqq_ref);
    if (!ref) throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过或被引用的消息）', 1404);
    return { kind: 'get_msg', ref };
  }
  if (request.action === 'get_group_msg_history' || request.action === 'get_friend_msg_history') {
    const isGroup = request.action === 'get_group_msg_history';
    const target = identifier(isGroup ? params.group_id : params.user_id, isGroup ? 'group_id' : 'user_id');
    const count = integer(params.count, 'count', 1, 100, 20);
    const reverseOrder = flag(params.reverseOrder ?? params.reverse_order, 'reverseOrder', false);
    const ref = params.openqq_ref ? nativeRef(params.openqq_ref) : null;
    const rawSeq = params.message_seq;
    let msgSeq;
    if (!ref && rawSeq !== undefined && rawSeq !== null && String(rawSeq) !== '' && String(rawSeq) !== '0') {
      if (!/^[1-9]\d{0,23}$/.test(String(rawSeq))) throw fail('message_seq 必须是非负整数');
      msgSeq = String(rawSeq);
    }
    return { kind: 'msg_history', chatType: isGroup ? 2 : 1, target, ref, msgSeq, count, reverseOrder };
  }
  if (request.action === 'get_image' || request.action === 'get_record' || request.action === 'get_file') {
    const raw = params.file ?? params.file_id;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) {
      throw fail(`${request.action} 需要有效的 file 或 file_id`);
    }
    const outFormat = request.action === 'get_record' && typeof params.out_format === 'string' && params.out_format.trim()
      ? params.out_format.trim().toLowerCase() : '';
    if (outFormat && !['silk', 'amr', 'wav', 'pcm', 'mp3', 'ogg', 'flac', 'm4a'].includes(outFormat)) {
      throw fail('out_format 仅支持 silk、amr、wav、pcm、mp3、ogg、flac、m4a');
    }
    return { kind: request.action, key: raw.trim(), ...(outFormat ? { outFormat } : {}) };
  }
  if (request.action === 'upload_group_file' || request.action === 'upload_private_file') {
    const isGroup = request.action === 'upload_group_file';
    const target = identifier(isGroup ? params.group_id : params.user_id, isGroup ? 'group_id' : 'user_id');
    const media = mediaRef(params.openqq_media, 'file');
    const folderId = isGroup && typeof (params.folder ?? params.folder_id) === 'string' ? String(params.folder ?? params.folder_id).slice(0, 256) : '';
    const timeout = Math.min(300000, 15000 + Math.ceil(media.size / MiB) * 4000);
    return { kind: 'send', chatType: isGroup ? 2 : 1, target, parts: [{ type: 'file', media, folderId }], texts: [], timeout };
  }
  if (request.action === 'forward_group_single_msg' || request.action === 'forward_friend_single_msg') {
    const isGroup = request.action === 'forward_group_single_msg';
    const target = identifier(isGroup ? params.group_id : params.user_id, isGroup ? 'group_id' : 'user_id');
    const ref = nativeRef(params.openqq_ref);
    if (!ref) throw fail('message_id 无效或已过期', 1404);
    return { kind: 'forward_single', chatType: isGroup ? 2 : 1, target, ref };
  }
  if (forwardSendActions.includes(request.action)) {
    let type = request.action === 'send_private_forward_msg' ? 'private' : request.action === 'send_group_forward_msg' ? 'group' : params.message_type;
    if (!type) {
      if ((params.user_id !== undefined) === (params.group_id !== undefined)) throw fail('send_forward_msg 需要明确 message_type 或唯一的目标');
      type = params.user_id !== undefined ? 'private' : 'group';
    }
    if (!['private', 'group'].includes(type)) throw fail('message_type 仅支持 private/group');
    const target = identifier(type === 'private' ? params.user_id : params.group_id, type === 'private' ? 'user_id' : 'group_id');
    const chatType = type === 'private' ? 1 : 2;
    return { kind: 'send_forward', chatType, target, ...forwardNodes(params.messages, chatType) };
  }
  const managed = admin.validate(request, params);
  if (managed) return managed;
  const extra = extended.validate(request, params);
  if (extra) return extra;
  if (!sendActions.includes(request.action)) throw fail('尚未支持动作: ' + request.action, 1404);
  let type = request.action === 'send_private_msg' ? 'private' : request.action === 'send_group_msg' ? 'group' : params.message_type;
  if (!type) {
    if ((params.user_id !== undefined) === (params.group_id !== undefined)) throw fail('send_msg 需要明确 message_type 或唯一的目标');
    type = params.user_id !== undefined ? 'private' : 'group';
  }
  if (!['private', 'group'].includes(type)) throw fail('message_type 仅支持 private/group');
  const target = identifier(type === 'private' ? params.user_id : params.group_id, type === 'private' ? 'user_id' : 'group_id');
  const chatType = type === 'private' ? 1 : 2;
  return { kind: 'send', chatType, target, ...messageParts(params, chatType) };
}

function createActionHandler(session, self, current, options = {}) {
  const operations = new Set();
  const waiting = new Map();
  const multiWaiting = new Set();
  let selfNickname;
  let disposed = false;

  function observe(name, args) {
    const records = name === 'onMsgInfoListUpdate' ? args[0] : name === 'onAddSendMsg' ? [args[0]] : [];
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!record || (String(record.senderUin) !== self.uin && !(self.uid && record.senderUid === self.uid))) continue;
      const task = waiting.get(String(record.guildId)) ?? waiting.get(String(record.msgId));
      if (task && record.chatType === task.peer.chatType && String(record.peerUid) === task.peer.peerUid && [0, 2].includes(record.sendStatus)) {
        // Remember our own sends so a later reply to them can be quoted without a lookup.
        if (record.sendStatus === 2) try { options.record?.(record, self.uin); } catch { /* best effort */ }
        task.resolve(record);
        continue;
      }
      if (multiWaiting.size && [0, 2].includes(record.sendStatus)) {
        for (const entry of [...multiWaiting]) {
          if (record.chatType !== entry.peer.chatType || String(record.peerUid) !== entry.peer.peerUid) continue;
          const isForwardCard = record.msgType === 11 || record.msgType === 8
            || (Array.isArray(record.elements) && record.elements.some(el => el?.elementType === 16 || (el?.elementType === 10 && String(el.arkElement?.bytesData ?? '').includes('com.tencent.multimsg'))));
          if (record.sendStatus === 0 || isForwardCard) {
            if (record.sendStatus === 2) try { options.record?.(record, self.uin); } catch { /* best effort */ }
            multiWaiting.delete(entry);
            entry.resolve(record);
            break;
          }
        }
      }
    }
  }

  async function resolveSelfNickname() {
    if (typeof selfNickname === 'string' && selfNickname) return selfNickname;
    const profile = session.getProfileService?.();
    if (typeof profile?.getUserDetailInfoByUin === 'function') {
      try {
        const res = await profile.getUserDetailInfoByUin(self.uin);
        const nick = String(res?.detail?.simpleInfo?.coreInfo?.nick ?? res?.detail?.nick ?? '');
        if (nick) { selfNickname = nick; return nick; }
      } catch { /* fallback below */ }
    }
    return '';
  }

  async function execute(request) {
    const action = validateAction(request);
    const operation = { active: true };
    const ensure = () => { if (disposed || !current() || !operation.active) throw fail('原生会话已失效，动作未继续执行', 1502); };
    ensure();
    let timer;
    const tags = [];
    const multiEntries = [];
    const cancelled = new Promise((_, reject) => {
      operation.cancel = () => { operation.active = false; reject(fail('会话或连接已关闭；已提交的发送结果未确认，请先查看 QQ，勿自动重试', 1502)); };
      timer = setTimeout(() => { operation.active = false; reject(fail('动作超时，已提交的发送结果未确认；请先查看 QQ，勿自动重试', 1501)); }, action.timeout ?? 15000);
    });
    operations.add(operation);
    const uidSteps = {
      convert: async uin => (await session.getUixConvertService().getUid([uin]))?.uidInfo?.get(uin),
      profile: async uin => (await session.getProfileService().getUidByUin('FriendsServiceImpl', [uin]))?.get(uin),
      group: async uin => (await session.getGroupService().getUidByUins([uin]))?.uids?.get(uin),
    };
    // Tries each source in turn and skips one that throws. Non-friends (group members, temp-chat peers) are often only known to the group service.
    const findUid = async (uin, order) => {
      for (const name of order) {
        ensure();
        let uid;
        try { uid = await uidSteps[name](uin); } catch { uid = undefined; }
        if (/^u_[\w-]+$/.test(uid ?? '')) return uid;
      }
      return undefined;
    };
    const needUid = async (uin, order, message) => {
      const uid = await findUid(uin, order);
      if (!uid) throw fail(message, 1500);
      return uid;
    };
    const memberName = async (group, uid) => {
      const infos = (await session.getGroupService().getMemberInfo(group, [uid], false))?.result?.infos;
      const info = infos instanceof Map ? infos.get(uid) : undefined;
      return info ? String(info.cardName || info.nick || '') : '';
    };
    // Group list entries arrive through the group listener; ask QQ to refresh, then wait for the update it triggers.
    const groupList = async refresh => {
      const cache = options.groups;
      if (!cache) throw fail('当前会话不支持获取群列表', 1500);
      if (refresh || cache.map.size === 0) {
        const since = cache.version;
        const result = await session.getGroupService().getGroupList(true);
        ensure();
        if (typeof result?.result === 'number' && result.result !== 0) throw fail('QQ 拒绝获取群列表：' + (result.errMsg || result.result), 1500);
        if (cache.version === since) await cache.waitForUpdate(since, 5000);
        ensure();
      }
      return [...cache.map.values()];
    };
    const sendOnce = async (chatType, peerUid, parts, targetCode) => {
      const service = session.getMsgService();
      const time = session.getMSFService().getServerTime();
      if (typeof time !== 'string' || !/^[1-9]\d{0,19}$/.test(time)) throw fail('原生服务器时间无效，未调用发送', 1500);
      const localTag = service.generateMsgUniqueId(chatType, time);
      if (typeof localTag !== 'string' || !/^[1-9]\d*$/.test(localTag) || waiting.has(localTag)) throw fail('原生发送关联标识无效或重复，未调用发送', 1500);
      tags.push(localTag);
      // QQ preserves the caller's guildId tag on ordinary-chat send updates.
      const peer = { chatType, peerUid, guildId: localTag };
      const acknowledged = new Promise(resolve => waiting.set(localTag, { peer, resolve }));
      const elements = [];
      const reply = parts.find(part => part.type === 'reply');
      if (reply) {
        let quoted;
        if (reply.ref) {
          // Quoting across conversations is not possible in QQ; refuse before sending anything.
          if (reply.ref.chatType !== chatType || reply.ref.peerUid !== peerUid) throw fail('只能引用同一会话中的消息；未调用发送', 1400);
          quoted = options.lookupRecent?.(reply.ref);
          if (!quoted?.msgSeq) {
            try {
              const found = (await service.getMsgsByMsgId({ chatType: reply.ref.chatType, peerUid, guildId: '' }, [reply.ref.msgId]))?.msgList
                ?.find(item => String(item.msgId) === reply.ref.msgId);
              if (found) quoted = { msgId: String(found.msgId), msgSeq: String(found.msgSeq ?? ''), clientSeq: String(found.clientSeq ?? ''), senderUin: String(found.senderUin ?? '') };
            } catch { /* reported below */ }
            ensure();
          }
        } else if (reply.seq && typeof service.getMsgsBySeqAndCount === 'function') {
          try {
            const found = (await service.getMsgsBySeqAndCount({ chatType, peerUid, guildId: '' }, reply.seq, 1, true, true))?.msgList
              ?.find(item => String(item.msgSeq) === reply.seq);
            if (found) quoted = { msgId: String(found.msgId), msgSeq: String(found.msgSeq ?? ''), clientSeq: String(found.clientSeq ?? ''), senderUin: String(found.senderUin ?? '') };
          } catch { /* reported below */ }
          ensure();
        }
        if (!quoted?.msgSeq) throw fail('引用的消息在 QQ 本地记录中找不到；未调用发送', 1404);
        // QQ requires the quote to be the first element.
        elements.push({ elementType: 7, elementId: '', replyElement: { replayMsgSeq: quoted.msgSeq, replayMsgId: quoted.msgId,
          senderUin: quoted.senderUin, senderUinStr: quoted.senderUin, replyMsgClientSeq: quoted.clientSeq } });
      }
      const build = createElementBuilder({ session, ensure, groupCode: targetCode, memberName,
        memberUid: (_group, uin) => needUid(uin, ['group', 'convert', 'profile'], '无法把 @ 的 QQ 号转换为 UID；未调用发送') });
      for (const part of parts) {
        if (part.type === 'text' && part.text.length) elements.push({ elementType: 1, elementId: '',
          textElement: { content: part.text, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } });
        else if (part.type === 'json') elements.push({ elementType: 10, elementId: '', arkElement: { bytesData: part.data, linkInfo: null, subElementType: null } });
        else if (typeof build[part.type] === 'function') elements.push(await build[part.type](part));
      }
      ensure();
      const result = await service.sendMsg('0', peer, elements, new Map());
      ensure();
      if (result?.result !== 0) throw fail('QQ 未接受发送: ' + (result?.errMsg ?? result?.result ?? '缺少结果'), 1500);
      const record = await acknowledged;
      ensure();
      if (record.sendStatus !== 2) throw fail('QQ 报告发送失败', 1500);
      if (!/^\d+$/.test(String(record.msgId)) || (typeof record.msgId === 'number' && !Number.isSafeInteger(record.msgId))) throw fail('QQ 回执消息 ID 无效，发送结果需在客户端确认', 1500);
      return { peer, record };
    };
    try {
      return await Promise.race([cancelled, (async () => {
        if (action.kind === 'get_login_info') {
          const nickname = await resolveSelfNickname();
          ensure();
          return { user_id: Number(self.uin), nickname };
        }
        if (action.kind === 'get_status') return { online: true, good: true };
        if (action.kind === 'forward') {
          if (typeof options.expandForward !== 'function') throw fail('当前会话不支持获取合并转发', 1500);
          const messages = await options.expandForward(action.ref);
          ensure();
          return { self, forward: { ref: action.ref, messages } };
        }
        if (action.kind === 'get_msg') {
          if (typeof options.fetchMessage !== 'function') throw fail('当前会话不支持读取消息', 1500);
          const message = await options.fetchMessage(action.ref);
          ensure();
          return { self, message };
        }
        if (action.kind === 'msg_history') {
          if (typeof options.fetchHistory !== 'function') throw fail('当前会话不支持获取历史消息', 1500);
          const peerUid = action.chatType === 2 ? action.target : await needUid(action.target, ['convert', 'profile', 'group'], '无法把目标 QQ 号转换为 UID；未调用获取历史消息');
          ensure();
          if (action.ref && (action.ref.chatType !== action.chatType || action.ref.peerUid !== peerUid)) {
            throw fail('锚点 message_id 不属于该会话', 1400);
          }
          const messages = await options.fetchHistory({ chatType: action.chatType, peerUid }, {
            msgId: action.ref?.msgId, msgSeq: action.msgSeq, count: action.count, reverseOrder: action.reverseOrder,
          });
          ensure();
          return { self, messages };
        }
        if (action.kind === 'get_image' || action.kind === 'get_record' || action.kind === 'get_file') {
          if (typeof options.resolveMedia !== 'function') throw fail('当前会话不支持获取媒体文件', 1500);
          const mediaKind = action.kind === 'get_image' ? 'image' : action.kind === 'get_record' ? 'record' : 'any';
          const media = await options.resolveMedia(action.key, mediaKind);
          ensure();
          return media;
        }
        if (admin.kinds.has(action.kind)) {
          return await admin.run(action, {
            session, ensure, groupList,
            friendList: async noCache => {
              if (typeof options.friendList !== 'function') throw fail('当前会话不支持获取好友列表', 1500);
              const list = await options.friendList(noCache);
              ensure();
              return list;
            },
            uidFor: uin => needUid(uin, ['convert', 'profile', 'group'], '无法把 QQ 号转换为 UID；未调用 QQ'),
            memberUid: (_group, uin) => needUid(uin, ['group', 'convert', 'profile'], '无法把 QQ 号转换为 UID；未调用 QQ'),
          });
        }
        if (extended.kinds.has(action.kind)) {
          return await extended.run(action, {
            session, self, ensure, groupList,
            waitFor: options.waitFor,
            lookupRecent: options.lookupRecent,
            lookupMedia: options.lookupMedia,
            sendPacket: options.sendPacket,
            resolveUin: options.resolveUin,
            friendsWithCategory: options.friendsWithCategory,
            uidFor: uin => needUid(uin, ['convert', 'profile', 'group'], '无法把 QQ 号转换为 UID；未调用 QQ'),
            memberUid: (_group, uin) => needUid(uin, ['group', 'convert', 'profile'], '无法把 QQ 号转换为 UID；未调用 QQ'),
          });
        }
        let peerUid = action.target;
        if (action.chatType !== 2) peerUid = await needUid(action.target, ['convert', 'profile', 'group'], '无法把目标 QQ 号转换为 UID；未调用发送');
        ensure();
        const service = session.getMsgService();
        if (action.kind === 'input') {
          const result = await service.sendShowInputStatusReq(1, action.eventType, peerUid);
          ensure();
          if (result?.result !== undefined && result.result !== 0) throw fail('QQ 拒绝输入状态通知: ' + (result.errMsg ?? result.result), 1500);
          return null;
        }
        if (action.kind === 'forward_single') {
          if (typeof service.forwardMsgWithComment !== 'function') throw fail('当前 QQ 版本不支持单条转发', 1500);
          const time = session.getMSFService().getServerTime();
          if (typeof time !== 'string' || !/^[1-9]\d{0,19}$/.test(time)) throw fail('原生服务器时间无效，未调用转发', 1500);
          const localTag = service.generateMsgUniqueId(action.chatType, time);
          if (typeof localTag !== 'string' || !/^[1-9]\d*$/.test(localTag) || waiting.has(localTag)) throw fail('原生转发关联标识无效或重复', 1500);
          tags.push(localTag);
          const srcPeer = { chatType: action.ref.chatType, peerUid: action.ref.peerUid, guildId: '' };
          const dstPeer = { chatType: action.chatType, peerUid, guildId: localTag };
          const acknowledged = new Promise(resolve => waiting.set(localTag, { peer: dstPeer, resolve }));
          const result = await service.forwardMsgWithComment([action.ref.msgId], srcPeer, [dstPeer], [], new Map());
          ensure();
          if (result?.result !== undefined && result.result !== 0) throw fail('QQ 拒绝单条转发: ' + (result.errMsg ?? result.result), 1500);
          const record = await acknowledged;
          ensure();
          if (record.sendStatus !== 2) throw fail('QQ 报告转发失败', 1500);
          return { self, message: { chatType: dstPeer.chatType, peerUid, msgId: String(record.msgId) } };
        }
        if (action.kind === 'send_forward') {
          if (typeof service.multiForwardMsgWithComment !== 'function') throw fail('当前 QQ 版本不支持发送合并转发', 1500);
          const defaultName = (await resolveSelfNickname()) || self.uin;
          ensure();
          const allRefs = action.nodes.every(n => n.mode === 'ref');
          let srcPeer;
          const msgInfos = [];
          if (allRefs) {
            const first = action.nodes[0].ref;
            if (action.nodes.some(n => n.ref.chatType !== first.chatType || n.ref.peerUid !== first.peerUid)) {
              throw fail('引用已有消息合并转发时，所有节点必须来自同一会话', 1400);
            }
            srcPeer = { chatType: first.chatType, peerUid: first.peerUid, guildId: '' };
            for (const node of action.nodes) {
              msgInfos.push({ msgId: node.ref.msgId, senderShowName: node.name || defaultName });
            }
          } else {
            if (!self.uid) throw fail('缺少自身 UID，无法构造自定义合并转发节点', 1500);
            srcPeer = { chatType: 1, peerUid: self.uid, guildId: '' };
            for (const node of action.nodes) {
              if (node.mode === 'ref') {
                // Stage referenced message into self-chat so mixed ref + custom nodes share one source peer.
                const fetched = options.fetchMessage ? await options.fetchMessage(node.ref) : null;
                ensure();
                if (!fetched) throw fail('找不到引用的消息', 1404);
                const textFallback = (fetched.elements ?? []).filter(el => el.elementType === 1 && el.textElement?.content).map(el => el.textElement.content).join('') || '[消息]';
                const staged = await sendOnce(1, self.uid, [{ type: 'text', text: textFallback }], self.uin);
                msgInfos.push({ msgId: String(staged.record.msgId), senderShowName: node.name || String(fetched.sendNickName || defaultName) });
              } else {
                const staged = await sendOnce(1, self.uid, node.parts, self.uin);
                msgInfos.push({ msgId: String(staged.record.msgId), senderShowName: node.name || node.uin || defaultName });
              }
            }
          }
          const dstPeer = { chatType: action.chatType, peerUid, guildId: '' };
          const acknowledged = new Promise(resolve => {
            const entry = { peer: dstPeer, resolve };
            multiEntries.push(entry);
            multiWaiting.add(entry);
          });
          const result = await service.multiForwardMsgWithComment(msgInfos, srcPeer, dstPeer, [], new Map());
          ensure();
          if (result?.result !== undefined && result.result !== 0) throw fail('QQ 拒绝合并转发: ' + (result.errMsg ?? result.result), 1500);
          const record = await acknowledged;
          ensure();
          if (record.sendStatus !== 2) throw fail('QQ 报告合并转发失败', 1500);
          return { self, message: { chatType: dstPeer.chatType, peerUid, msgId: String(record.msgId) } };
        }
        const { peer, record } = await sendOnce(action.chatType, peerUid, action.parts, action.target);
        return { self, message: { chatType: peer.chatType, peerUid, msgId: String(record.msgId) } };
      })()]);
    } finally {
      operation.active = false;
      clearTimeout(timer);
      operations.delete(operation);
      for (const localTag of tags) {
        if (waiting.has(localTag)) { waiting.get(localTag).resolve({ sendStatus: 0 }); waiting.delete(localTag); }
      }
      for (const entry of multiEntries) {
        if (multiWaiting.has(entry)) { multiWaiting.delete(entry); entry.resolve({ sendStatus: 0 }); }
      }
    }
  }
  function dispose() {
    disposed = true;
    for (const operation of operations) operation.cancel();
  }
  return { execute, observe, dispose };
}

module.exports = { validateAction, createActionHandler, normalizeParams };
