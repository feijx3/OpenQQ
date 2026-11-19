'use strict';

const { fail, identifier, nativeId } = require('./common.cjs');
const { parseCQ } = require('./cq.cjs');
const admin = require('./admin.cjs');
const { createElementBuilder } = require('./elements.cjs');

const MiB = 1024 * 1024;
const sendActions = ['send_private_msg', 'send_group_msg', 'send_msg'];
const exclusiveTypes = ['json', 'record', 'video', 'file'];
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
  if (!sendActions.includes(request?.action) || !params || typeof params !== 'object' || Array.isArray(params)) return request;
  if (typeof params.message !== 'string' || (params.auto_escape !== undefined && params.auto_escape !== false)) return request;
  return { ...request, params: { ...params, message: parseCQ(params.message) } };
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
        if (!ref) throw fail('reply 段的 id 无效或引用的消息已过期', 1404);
        return { type: 'reply', ref };
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
      case 'image': return { type: 'image', media: mediaRef(data.openqq_media, 'image'), summary: typeof data.summary === 'string' ? data.summary.slice(0, 64) : '' };
      case 'record': case 'video': case 'file': return { type: segment.type, media: mediaRef(data.openqq_media, segment.type) };
      default:
        throw fail(`当前发送支持 text、at、face、image、record、video、file、reply、json、dice、rps 消息段，暂不支持 ${typeof segment?.type === 'string' ? segment.type : '该消息段'}`);
    }
  });
  if (parts.filter(part => part.type === 'reply').length > 1) throw fail('一条消息最多引用一条消息');
  // QQ treats these as the whole message: they cannot carry text, a quote or other segments alongside.
  const exclusive = parts.find(part => exclusiveTypes.includes(part.type));
  if (exclusive && parts.length !== 1) throw fail(`${exclusive.type} 段必须单独发送，不能与其他消息段混合`);
  const texts = parts.filter(part => part.type === 'text').map(part => part.text);
  const json = parts.find(part => part.type === 'json');
  if (!parts.some(part => part.type === 'text' ? part.text.length > 0 : part.type !== 'reply')) throw fail('消息不能为空或超过 64 KiB');
  if (Buffer.byteLength(texts.join('') + (json?.data ?? '')) > 65536) throw fail('消息不能为空或超过 64 KiB');
  const mediaBytes = parts.reduce((total, part) => total + (part.media ? part.media.size + (part.media.thumb?.size ?? 0) : 0), 0);
  // Uploads finish before QQ reports success, so larger files get more time (never less than the text default).
  return { parts, texts, timeout: Math.min(300000, 15000 + Math.ceil(mediaBytes / MiB) * 4000) };
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
  if (request.action === 'get_image') {
    const raw = params.file ?? params.file_id;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) {
      throw fail('get_image 需要有效的 file 或 file_id');
    }
    return { kind: 'get_image', key: raw.trim() };
  }
  const managed = admin.validate(request, params);
  if (managed) return managed;
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
  let disposed = false;

  function observe(name, args) {
    const records = name === 'onMsgInfoListUpdate' ? args[0] : name === 'onAddSendMsg' ? [args[0]] : [];
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!record || (String(record.senderUin) !== self.uin && !(self.uid && record.senderUid === self.uid))) continue;
      const task = waiting.get(String(record.guildId)) ?? waiting.get(String(record.msgId));
      if (!task || record.chatType !== task.peer.chatType || String(record.peerUid) !== task.peer.peerUid || ![0, 2].includes(record.sendStatus)) continue;
      // Remember our own sends so a later reply to them can be quoted without a lookup.
      if (record.sendStatus === 2) try { options.record?.(record, self.uin); } catch { /* best effort */ }
      task.resolve(record);
    }
  }

  async function execute(request) {
    const action = validateAction(request);
    const operation = { active: true };
    const ensure = () => { if (disposed || !current() || !operation.active) throw fail('原生会话已失效，动作未继续执行', 1502); };
    ensure();
    let timer;
    let tag;
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
    try {
      return await Promise.race([cancelled, (async () => {
        if (action.kind === 'get_login_info') return { user_id: Number(self.uin), nickname: '' };
        if (action.kind === 'get_status') return { online: true, good: true };
        if (action.kind === 'forward') {
          if (typeof options.expandForward !== 'function') throw fail('当前会话不支持获取合并转发', 1500);
          const messages = await options.expandForward(action.ref);
          ensure();
          return { self, forward: { ref: action.ref, messages } };
        }
        if (action.kind === 'get_image') {
          if (typeof options.resolveMedia !== 'function') throw fail('当前会话不支持获取图片', 1500);
          const media = await options.resolveMedia(action.key, 'image');
          ensure();
          return media;
        }
        if (admin.kinds.has(action.kind)) {
          return await admin.run(action, {
            session, ensure, groupList,
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
        const time = session.getMSFService().getServerTime();
        if (typeof time !== 'string' || !/^[1-9]\d{0,19}$/.test(time)) throw fail('原生服务器时间无效，未调用发送', 1500);
        tag = service.generateMsgUniqueId(action.chatType, time);
        if (typeof tag !== 'string' || !/^[1-9]\d*$/.test(tag) || waiting.has(tag)) throw fail('原生发送关联标识无效或重复，未调用发送', 1500);
        // QQ preserves the caller's guildId tag on ordinary-chat send updates.
        const peer = { chatType: action.chatType, peerUid, guildId: tag };
        const acknowledged = new Promise(resolve => waiting.set(tag, { peer, resolve }));
        const elements = [];
        const reply = action.parts.find(part => part.type === 'reply');
        if (reply) {
          // Quoting across conversations is not possible in QQ; refuse before sending anything.
          if (reply.ref.chatType !== action.chatType || reply.ref.peerUid !== peerUid) throw fail('只能引用同一会话中的消息；未调用发送', 1400);
          let quoted = options.lookupRecent?.(reply.ref);
          if (!quoted?.msgSeq) {
            try {
              const found = (await service.getMsgsByMsgId({ chatType: reply.ref.chatType, peerUid, guildId: '' }, [reply.ref.msgId]))?.msgList
                ?.find(item => String(item.msgId) === reply.ref.msgId);
              if (found) quoted = { msgId: String(found.msgId), msgSeq: String(found.msgSeq ?? ''), clientSeq: String(found.clientSeq ?? ''), senderUin: String(found.senderUin ?? '') };
            } catch { /* reported below */ }
            ensure();
          }
          if (!quoted?.msgSeq) throw fail('引用的消息在 QQ 本地记录中找不到；未调用发送', 1404);
          // QQ requires the quote to be the first element.
          elements.push({ elementType: 7, elementId: '', replyElement: { replayMsgSeq: quoted.msgSeq, replayMsgId: quoted.msgId,
            senderUin: quoted.senderUin, senderUinStr: quoted.senderUin, replyMsgClientSeq: quoted.clientSeq } });
        }
        const build = createElementBuilder({ session, ensure, groupCode: action.target, memberName,
          memberUid: (_group, uin) => needUid(uin, ['group', 'convert', 'profile'], '无法把 @ 的 QQ 号转换为 UID；未调用发送') });
        for (const part of action.parts) {
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
        return { self, message: { chatType: peer.chatType, peerUid, msgId: String(record.msgId) } };
      })()]);
    } finally {
      operation.active = false;
      clearTimeout(timer);
      operations.delete(operation);
      if (tag && waiting.has(tag)) { waiting.get(tag).resolve({ sendStatus: 0 }); waiting.delete(tag); }
    }
  }
  function dispose() {
    disposed = true;
    for (const operation of operations) operation.cancel();
  }
  return { execute, observe, dispose };
}

module.exports = { validateAction, createActionHandler, normalizeParams };
