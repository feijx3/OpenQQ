'use strict';

const { fail, identifier, flag, integer, nativeId } = require('./common.cjs');
const { memberOf } = require('./admin.cjs');
const { getGroupFileUrl } = require('./group-file.cjs');

const absolutePath = value => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f]/.test(value)
  && /^(?:[A-Za-z]:[\\/]|\/)/.test(value) && !/^(?:\\\\|\/\/)/.test(value);

function text(value, name, max, fallback) {
  if (value === undefined || value === null) {
    if (fallback === undefined) throw fail(`${name} 不能为空`);
    return fallback;
  }
  if (typeof value !== 'string' || [...value].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw fail(`${name} 必须是不超过 ${max} 个字符的文本`);
  }
  return value;
}

function messageRef(value) {
  if (!value || typeof value !== 'object' || ![1, 2, 100].includes(value.chatType) || typeof value.peerUid !== 'string' || !value.peerUid
    || value.peerUid.length > 64 || !nativeId(value.msgId)) return null;
  return { chatType: value.chatType, peerUid: value.peerUid, msgId: value.msgId };
}

function mediaPath(value, expectedKind) {
  if (!value || typeof value !== 'object' || (expectedKind && value.kind !== expectedKind) || !absolutePath(value.path)) {
    throw fail('文件没有经过处理，或路径无效');
  }
  return value;
}

function outcome(result, what) {
  if (result === undefined || result === null || typeof result !== 'object') return result;
  const code = typeof result.errCode === 'number' ? result.errCode : typeof result.result === 'number' ? result.result : typeof result.retCode === 'number' ? result.retCode : 0;
  if (code !== 0) throw fail(`QQ 拒绝${what}：${result.errMsg || result.retMsg || code}`, 1500);
  return result;
}

// Standard QQ Web bkn / g_tk CSRF token algorithm.
function calcBkn(skey) {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) hash += (hash << 5) + skey.charCodeAt(i);
  return hash & 0x7fffffff;
}

function domainName(value) {
  const raw = value === undefined || value === null || value === '' ? 'qun.qq.com' : String(value).trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,128}$/.test(raw) || raw.startsWith('.') || raw.endsWith('.') || raw.includes('..')) {
    throw fail('domain 格式无效');
  }
  return raw;
}

function validate(request, params) {
  const group = () => identifier(params.group_id, 'group_id');
  const user = () => identifier(params.user_id, 'user_id');
  switch (request.action) {
    case 'mark_group_msg_as_read': return { kind: 'mark_read', chatType: 2, target: group() };
    case 'mark_private_msg_as_read': return { kind: 'mark_read', chatType: 1, target: user() };
    case 'group_poke': return { kind: 'send_poke', chatType: 2, group: group(), target: identifier(params.user_id ?? params.target_id, 'user_id') };
    case 'friend_poke': return { kind: 'send_poke', chatType: 1, target: identifier(params.user_id ?? params.target_id, 'user_id') };
    case 'send_poke': {
      const target = identifier(params.user_id ?? params.target_id, 'user_id');
      return params.group_id !== undefined ? { kind: 'send_poke', chatType: 2, group: group(), target } : { kind: 'send_poke', chatType: 1, target };
    }
    case 'mark_msg_as_read': {
      const ref = messageRef(params.openqq_ref);
      if (ref) return { kind: 'mark_read', ref };
      if (params.group_id !== undefined) return { kind: 'mark_read', chatType: 2, target: group() };
      if (params.user_id !== undefined) return { kind: 'mark_read', chatType: 1, target: user() };
      throw fail('mark_msg_as_read 需要 message_id、group_id 或 user_id');
    }
    case '_mark_all_as_read': return { kind: 'mark_all_read' };

    case 'fetch_emoji_like':
    case 'get_emoji_likes':
    case 'get_msg_emoji_likes': {
      const ref = messageRef(params.openqq_ref);
      if (!ref) throw fail('message_id 无效或已过期', 1404);
      const rawEmoji = params.emojiId ?? params.emoji_id;
      const emojiId = typeof rawEmoji === 'number' ? String(rawEmoji) : rawEmoji;
      if (typeof emojiId !== 'string' || !/^\d{1,10}$/.test(emojiId)) throw fail('emojiId 必须是数字');
      const rawType = params.emojiType ?? params.emoji_type ?? (emojiId.length > 3 ? '2' : '1');
      const emojiType = String(rawType);
      if (!['1', '2'].includes(emojiType)) throw fail('emojiType 必须为 1 或 2');
      const count = integer(params.count, 'count', 1, 50, 20);
      const cookie = text(params.cookie, 'cookie', 512, '');
      return { kind: 'fetch_emoji_like', ref, emojiId, emojiType, count, cookie };
    }
    case 'fetch_ptt_text':
    case 'get_ptt_text':
    case 'get_record_text': {
      const ref = messageRef(params.openqq_ref);
      if (!ref) throw fail('message_id 无效或已过期', 1404);
      return { kind: 'ptt_text', ref, timeout: 30000 };
    }

    case 'set_essence_msg':
    case 'delete_essence_msg': {
      const ref = messageRef(params.openqq_ref);
      if (!ref) throw fail('message_id 无效或已过期', 1404);
      if (ref.chatType !== 2) throw fail('只有群消息可以设置或移出精华');
      return { kind: request.action === 'set_essence_msg' ? 'set_essence' : 'delete_essence', ref };
    }
    case 'get_essence_msg_list':
      return { kind: 'essence_list', group: group(), pageStart: integer(params.page_start, 'page_start', 0, 1000, 0), pageLimit: integer(params.page_limit, 'page_limit', 1, 100, 20) };

    case 'set_group_kick_members': {
      const list = params.user_id;
      if (!Array.isArray(list) || list.length < 1 || list.length > 50) throw fail('user_id 必须是包含 1..50 个 QQ 号的数组');
      return { kind: 'group_kick_members', group: group(), users: list.map(u => identifier(u, 'user_id')), refuse: flag(params.reject_add_request, 'reject_add_request', false) };
    }
    case 'set_group_remark': return { kind: 'group_remark', group: group(), remark: text(params.remark, 'remark', 120, '') };
    case 'set_group_portrait': return { kind: 'group_portrait', group: group(), media: mediaPath(params.openqq_media, 'image'), timeout: 30000 };
    case 'get_group_at_all_remain': return { kind: 'group_at_all_remain', group: group() };
    case 'get_group_shut_list': return { kind: 'group_shut_list', group: group() };
    case 'get_group_honor_info': {
      const honorType = text(params.type, 'type', 32, 'all');
      if (!['all', 'talkative', 'performer', 'legend', 'strong_newbie', 'emotion'].includes(honorType)) throw fail('type 必须是 all/talkative/performer/legend/strong_newbie/emotion');
      return { kind: 'group_honor', group: group(), honorType };
    }
    case 'get_group_system_msg': return { kind: 'group_system_msg', count: integer(params.count, 'count', 1, 100, 50) };
    case 'get_group_detail_info':
    case 'get_group_info_ex': return { kind: 'group_detail_info', group: group() };
    case 'get_group_share_link': return { kind: 'group_share_link', group: group() };

    case '_get_group_notice': return { kind: 'group_notice_list', group: group() };
    case '_send_group_notice': {
      const content = text(params.content, 'content', 4000);
      if (!content.trim()) throw fail('content 不能为空');
      const media = params.openqq_media ? mediaPath(params.openqq_media, 'image') : null;
      return { kind: 'group_notice_send', group: group(), content, media, pinned: flag(params.pinned, 'pinned', false), timeout: 30000 };
    }
    case '_del_group_notice': {
      const noticeId = text(params.notice_id, 'notice_id', 128);
      if (!noticeId.trim()) throw fail('notice_id 不能为空');
      return { kind: 'group_notice_del', group: group(), noticeId: noticeId.trim() };
    }

    case 'get_group_file_system_info': return { kind: 'group_file_system_info', group: group() };
    case 'get_group_root_files':
      return { kind: 'group_file_list', group: group(), folderId: '', fileCount: integer(params.file_count, 'file_count', 1, 100, 50) };
    case 'get_group_files_by_folder': {
      const folderId = text(params.folder_id ?? params.folder, 'folder_id', 256);
      if (!folderId.trim()) throw fail('folder_id 不能为空');
      return { kind: 'group_file_list', group: group(), folderId: folderId.trim(), fileCount: integer(params.file_count, 'file_count', 1, 100, 50) };
    }
    case 'create_group_file_folder': {
      const name = text(params.name, 'name', 128);
      if (!name.trim()) throw fail('name 不能为空');
      return { kind: 'create_group_folder', group: group(), name: name.trim() };
    }
    case 'delete_group_folder':
    case 'delete_group_file_folder': {
      const folderId = text(params.folder_id, 'folder_id', 256);
      if (!folderId.trim()) throw fail('folder_id 不能为空');
      return { kind: 'delete_group_folder', group: group(), folderId: folderId.trim() };
    }
    case 'delete_group_file': {
      const fileId = text(params.file_id, 'file_id', 256);
      if (!fileId.trim()) throw fail('file_id 不能为空');
      return { kind: 'delete_group_file', group: group(), fileId: fileId.trim(), busid: integer(params.busid ?? params.bus_id, 'busid', 0, 10000, 102) };
    }
    case 'rename_group_file_folder': {
      const folderId = text(params.folder_id, 'folder_id', 256);
      const newName = text(params.new_folder_name ?? params.name, 'new_folder_name', 128);
      if (!folderId.trim() || !newName.trim()) throw fail('folder_id 和 new_folder_name 不能为空');
      return { kind: 'rename_group_folder', group: group(), folderId: folderId.trim(), newName: newName.trim() };
    }
    case 'trans_group_file': {
      const fileId = text(params.file_id, 'file_id', 256);
      if (!fileId.trim()) throw fail('file_id 不能为空');
      return { kind: 'trans_group_file', group: group(), fileId: fileId.trim() };
    }
    case 'get_group_file_url': {
      const fileId = text(params.file_id, 'file_id', 256);
      if (!fileId.trim()) throw fail('file_id 不能为空');
      return { kind: 'get_group_file_url', group: group(), fileId: fileId.trim(), busid: integer(params.busid ?? params.bus_id, 'busid', 0, 10000, 102) };
    }

    case 'get_friends_with_category': return { kind: 'friends_with_category', noCache: flag(params.no_cache, 'no_cache', false) };
    case 'set_friend_remark': return { kind: 'friend_remark', user: user(), remark: text(params.remark, 'remark', 60, '') };
    case 'delete_friend':
      return { kind: 'delete_friend', user: user(), tempBlock: flag(params.temp_block, 'temp_block', false), tempBothDel: flag(params.temp_both_del, 'temp_both_del', true) };
    case 'set_qq_profile': {
      const nickname = params.nickname !== undefined ? text(params.nickname, 'nickname', 60) : undefined;
      const personalNote = params.personal_note !== undefined ? text(params.personal_note, 'personal_note', 200)
        : params.longNick !== undefined ? text(params.longNick, 'longNick', 200) : undefined;
      const sex = params.sex !== undefined ? integer(params.sex, 'sex', 0, 2) : undefined;
      if (nickname === undefined && personalNote === undefined && sex === undefined) throw fail('至少需要提供 nickname、personal_note 或 sex 之一');
      return { kind: 'set_qq_profile', nickname, personalNote, sex };
    }
    case 'set_self_longnick': {
      const longNick = text(params.longNick ?? params.personal_note ?? params.content, 'longNick', 200);
      return { kind: 'set_qq_profile', personalNote: longNick };
    }
    case 'set_qq_avatar': return { kind: 'set_qq_avatar', media: mediaPath(params.openqq_media, 'image'), timeout: 30000 };
    case 'get_recent_contact': return { kind: 'recent_contact', count: integer(params.count, 'count', 1, 100, 10) };
    case 'fetch_custom_face': return { kind: 'custom_face', count: integer(params.count, 'count', 1, 200, 48) };
    case 'set_online_status': {
      const status = integer(params.status, 'status', 0, 1000);
      const extStatus = integer(params.ext_status ?? params.extStatus, 'ext_status', 0, 100000, 0);
      const batteryStatus = integer(params.battery_status ?? params.batteryStatus, 'battery_status', 0, 100, 0);
      return { kind: 'set_online_status', status, extStatus, batteryStatus };
    }

    case 'ArkSharePeer':
    case 'send_ark_share':
    case 'share_peer': {
      if (params.group_id !== undefined) return { kind: 'ark_share', shareType: 'group', target: group() };
      if (params.user_id !== undefined) return { kind: 'ark_share', shareType: 'user', target: user(), phone: text(params.phoneNumber ?? params.phone_number, 'phoneNumber', 32, '') };
      throw fail('需要 user_id 或 group_id');
    }
    case 'ArkShareGroup':
    case 'send_group_ark_share':
    case 'share_group_ex': return { kind: 'ark_share', shareType: 'group', target: group() };

    case 'get_clientkey': return { kind: 'get_clientkey' };
    case 'get_cookies': return { kind: 'get_cookies', domain: domainName(params.domain) };
    case 'get_csrf_token': return { kind: 'get_csrf_token', domain: domainName(params.domain) };
    case 'get_credentials': return { kind: 'get_credentials', domain: domainName(params.domain) };

    default: return null;
  }
}

const kinds = new Set([
  'mark_read', 'mark_all_read', 'send_poke', 'fetch_emoji_like', 'ptt_text',
  'set_essence', 'delete_essence', 'essence_list',
  'group_kick_members', 'group_remark', 'group_portrait', 'group_at_all_remain', 'group_shut_list',
  'group_honor', 'group_system_msg', 'group_detail_info', 'group_share_link',
  'group_notice_list', 'group_notice_send', 'group_notice_del',
  'group_file_system_info', 'group_file_list', 'create_group_folder', 'delete_group_folder',
  'delete_group_file', 'rename_group_folder', 'trans_group_file', 'get_group_file_url',
  'friends_with_category', 'friend_remark', 'delete_friend', 'set_qq_profile', 'set_qq_avatar',
  'recent_contact', 'custom_face', 'set_online_status', 'ark_share',
  'get_clientkey', 'get_cookies', 'get_csrf_token', 'get_credentials',
]);

async function fetchPskey(session, domain, ensure) {
  const tipOff = session.getTipOffService?.();
  if (typeof tipOff?.getPskey !== 'function') throw fail('当前 QQ 会话不支持获取 pskey', 1500);
  const res = outcome(await tipOff.getPskey([domain], true), '获取 pskey');
  ensure();
  const map = res?.domainPskeyMap;
  const pskey = map instanceof Map ? map.get(domain) : map && typeof map === 'object' ? map[domain] : '';
  return String(pskey ?? '');
}

async function lookupMsgRecord(session, ref, lookupRecent, ensure) {
  const cached = lookupRecent?.(ref);
  if (cached?.msgSeq && cached?.msgRandom) return cached;
  const service = session.getMsgService?.();
  if (typeof service?.getMsgsByMsgId !== 'function') throw fail('当前会话不支持读取消息', 1500);
  const peer = { chatType: ref.chatType, peerUid: ref.peerUid, guildId: '' };
  const found = (await service.getMsgsByMsgId(peer, [ref.msgId]))?.msgList?.find(item => String(item?.msgId) === ref.msgId);
  ensure();
  if (!found) throw fail('消息在 QQ 本地记录中找不到', 1404);
  return found;
}

async function run(action, ctx) {
  const { session, self, ensure, waitFor, lookupRecent, resolveUin } = ctx;
  const groups = () => session.getGroupService();
  const msgs = () => session.getMsgService();
  const rich = () => {
    const svc = session.getRichMediaService?.();
    if (!svc) throw fail('当前 QQ 会话不支持群文件服务', 1500);
    return svc;
  };

  switch (action.kind) {
    case 'mark_read': {
      let peer;
      if (action.ref) peer = { chatType: action.ref.chatType, peerUid: action.ref.peerUid, guildId: '' };
      else if (action.chatType === 2) peer = { chatType: 2, peerUid: action.target, guildId: '' };
      else peer = { chatType: 1, peerUid: await ctx.uidFor(action.target), guildId: '' };
      ensure();
      outcome(await msgs().setMsgRead(peer), '标记已读');
      return null;
    }
    case 'mark_all_read': {
      if (typeof msgs().setAllC2CAndGroupMsgRead !== 'function') throw fail('当前 QQ 版本不支持全部已读', 1500);
      outcome(await msgs().setAllC2CAndGroupMsgRead(), '全部标记已读');
      return null;
    }
    case 'send_poke': {
      if (typeof msgs().sendNudge !== 'function') throw fail('当前 QQ 版本不支持发送戳一戳', 1500);
      let peer;
      let chatUin;
      if (action.chatType === 2) {
        peer = { chatType: 2, peerUid: action.group, guildId: '' };
        chatUin = action.group;
      } else {
        const uid = await ctx.uidFor(action.target);
        ensure();
        peer = { chatType: 1, peerUid: uid, guildId: '' };
        chatUin = action.target;
      }
      outcome(await msgs().sendNudge(peer, action.target, chatUin), '发送戳一戳');
      return null;
    }
    case 'fetch_emoji_like': {
      const record = await lookupMsgRecord(session, action.ref, lookupRecent, ensure);
      const seq = String(record.msgSeq ?? '');
      if (!/^\d+$/.test(seq)) throw fail('消息缺少有效序号', 1404);
      const peer = { chatType: action.ref.chatType, peerUid: action.ref.peerUid, guildId: '' };
      if (typeof msgs().getMsgEmojiLikesList !== 'function') throw fail('当前 QQ 版本不支持查询表情回应列表', 1500);
      const res = outcome(await msgs().getMsgEmojiLikesList(peer, seq, action.emojiId, action.emojiType, action.cookie, false, action.count), '获取表情回应列表');
      ensure();
      const rawList = Array.isArray(res?.emojiLikesList) ? res.emojiLikesList : [];
      const emojiLikesList = [];
      for (const item of rawList) {
        let userId = item.tinyId ?? item.uin ?? '';
        if (!/^[1-9]\d*$/.test(String(userId)) && item.uid && typeof resolveUin === 'function') {
          try { userId = await resolveUin(item.uid); } catch { userId = '0'; }
        }
        emojiLikesList.push({ tinyId: String(userId || '0'), nickName: String(item.nickName ?? ''), headUrl: String(item.headUrl ?? '') });
      }
      return { emojiLikesList, cookie: String(res?.cookie ?? ''), isLastPage: Boolean(res?.isLastPage), isFirstPage: Boolean(res?.isFirstPage) };
    }
    case 'ptt_text': {
      const peer = { chatType: action.ref.chatType, peerUid: action.ref.peerUid, guildId: '' };
      const service = msgs();
      const found = (await service.getMsgsByMsgId(peer, [action.ref.msgId]))?.msgList?.find(item => String(item?.msgId) === action.ref.msgId);
      ensure();
      if (!found) throw fail('语音消息在 QQ 本地记录中找不到', 1404);
      const pttEl = (found.elements ?? []).find(el => el?.elementType === 4 && el.pttElement);
      if (!pttEl) throw fail('该消息不包含语音元素', 1400);
      if (typeof pttEl.pttElement.text === 'string' && pttEl.pttElement.text.trim()) {
        return { text: pttEl.pttElement.text };
      }
      if (typeof service.translatePtt2Text !== 'function') throw fail('当前 QQ 版本不支持语音转文字', 1500);
      const pending = waitFor ? waitFor('msg_update', list => Array.isArray(list) && list.some(m => String(m?.msgId) === action.ref.msgId && m.elements?.some(el => el?.pttElement?.text)), 25000) : null;
      const callRes = outcome(await service.translatePtt2Text(action.ref.msgId, peer, pttEl), '语音转文字');
      ensure();
      if (typeof callRes?.text === 'string' && callRes.text) return { text: callRes.text };
      if (!pending) throw fail('当前会话不支持等待语音转文字结果', 1500);
      const updated = await pending;
      ensure();
      const matched = updated.find(m => String(m?.msgId) === action.ref.msgId);
      const textResult = matched?.elements?.find(el => el?.pttElement?.text)?.pttElement?.text ?? '';
      return { text: String(textResult) };
    }
    case 'set_essence':
    case 'delete_essence': {
      const record = await lookupMsgRecord(session, action.ref, lookupRecent, ensure);
      const seq = Number(record.msgSeq);
      const random = Number(record.msgRandom ?? 0);
      if (!Number.isSafeInteger(seq) || seq <= 0) throw fail('消息缺少有效序号，无法操作精华消息', 1404);
      const method = action.kind === 'set_essence' ? 'addGroupEssence' : 'removeGroupEssence';
      if (typeof groups()[method] !== 'function') throw fail('当前 QQ 版本不支持精华消息操作', 1500);
      outcome(await groups()[method]({ groupCode: action.ref.peerUid, msgRandom: Number.isSafeInteger(random) ? random : 0, msgSeq: seq }), action.kind === 'set_essence' ? '设置精华消息' : '移出精华消息');
      return null;
    }
    case 'essence_list': {
      const svc = groups();
      let res;
      if (typeof svc.fetchGroupEssenceList === 'function') {
        res = outcome(await svc.fetchGroupEssenceList({ groupCode: action.group, pageStart: action.pageStart, pageLimit: action.pageLimit }, ''), '获取精华消息列表');
      } else if (typeof svc.getGroupLatestEssenceList === 'function') {
        res = outcome(await svc.getGroupLatestEssenceList(action.group), '获取精华消息列表');
      } else {
        throw fail('当前 QQ 版本不支持获取精华消息列表', 1500);
      }
      ensure();
      const items = Array.isArray(res?.result?.msgList) ? res.result.msgList
        : Array.isArray(res?.msgList) ? res.msgList
        : Array.isArray(res?.items) ? res.items : [];
      return items.map(item => ({
        sender_id: Number(item.senderUin ?? item.sender_uin ?? 0) || 0,
        sender_nick: String(item.senderNick ?? item.sender_nick ?? ''),
        sender_time: Number(item.senderTime ?? item.sender_time ?? 0) || 0,
        operator_id: Number(item.addDigestUin ?? item.operatorUin ?? 0) || 0,
        operator_nick: String(item.addDigestNick ?? item.operatorNick ?? ''),
        operator_time: Number(item.addDigestTime ?? item.operatorTime ?? 0) || 0,
        message_id: Number(item.msgSeq ?? 0) || 0,
        msg_seq: String(item.msgSeq ?? ''),
        msg_random: String(item.msgRandom ?? ''),
        content: Array.isArray(item.msgContent) ? item.msgContent : [],
      }));
    }
    case 'group_kick_members': {
      const uids = [];
      for (const u of action.users) {
        uids.push(await ctx.memberUid(action.group, u));
        ensure();
      }
      outcome(await groups().kickMember(action.group, uids, action.refuse, ''), '批量踢出成员');
      return null;
    }
    case 'group_remark': {
      if (typeof groups().modifyGroupRemark !== 'function') throw fail('当前 QQ 版本不支持修改群备注', 1500);
      outcome(await groups().modifyGroupRemark(action.group, action.remark), '修改群备注');
      return null;
    }
    case 'group_portrait': {
      if (typeof groups().setHeader !== 'function') throw fail('当前 QQ 版本不支持设置群头像', 1500);
      outcome(await groups().setHeader(action.media.path, action.group), '设置群头像');
      return null;
    }
    case 'group_at_all_remain': {
      if (typeof groups().getGroupRemainAtTimes !== 'function') throw fail('当前 QQ 版本不支持查询 @全体成员 剩余次数', 1500);
      const res = outcome(await groups().getGroupRemainAtTimes(action.group), '查询 @全体成员 次数');
      ensure();
      const info = res?.atInfo ?? {};
      return {
        can_at_all: Boolean(info.canAtAll),
        remain_at_all_count_for_group: Number(info.RemainAtAllCountForGroup ?? 0) || 0,
        remain_at_all_count_for_uin: Number(info.RemainAtAllCountForUin ?? 0) || 0,
      };
    }
    case 'group_shut_list': {
      const svc = groups();
      if (typeof svc.getGroupShutUpMemberList !== 'function') throw fail('当前 QQ 版本不支持查询群禁言列表', 1500);
      const pending = waitFor ? waitFor('group_shut_list', item => item.groupCode === action.group, 8000) : null;
      const res = outcome(await svc.getGroupShutUpMemberList(action.group), '获取群禁言列表');
      ensure();
      let list = Array.isArray(res?.memList) ? res.memList : Array.isArray(res?.members) ? res.members : null;
      if (!list && pending) {
        list = (await pending).members;
        ensure();
      }
      return (list ?? []).map(info => memberOf(action.group, info));
    }
    case 'group_honor': {
      const svc = groups();
      if (typeof svc.getGroupHonorList !== 'function') throw fail('当前 QQ 版本不支持获取群荣誉信息', 1500);
      const res = outcome(await svc.getGroupHonorList({ groupCodes: [action.group] }), '获取群荣誉信息');
      ensure();
      const base = { group_id: Number(action.group) };
      if (action.honorType === 'all' || action.honorType === 'talkative') base.talkative_list = Array.isArray(res?.talkativeList) ? res.talkativeList : [];
      if (action.honorType === 'all' || action.honorType === 'performer') base.performer_list = Array.isArray(res?.performerList) ? res.performerList : [];
      if (action.honorType === 'all' || action.honorType === 'legend') base.legend_list = Array.isArray(res?.legendList) ? res.legendList : [];
      if (action.honorType === 'all' || action.honorType === 'strong_newbie') base.strong_newbie_list = Array.isArray(res?.strongNewbieList) ? res.strongNewbieList : [];
      if (action.honorType === 'all' || action.honorType === 'emotion') base.emotion_list = Array.isArray(res?.emotionList) ? res.emotionList : [];
      return base;
    }
    case 'group_system_msg': {
      const svc = groups();
      if (typeof svc.getSingleScreenNotifies !== 'function') throw fail('当前 QQ 版本不支持获取群系统消息', 1500);
      const pending = waitFor ? waitFor('group_notifies', item => item.doubt === false, 8000) : null;
      const res = outcome(await svc.getSingleScreenNotifies(false, '', action.count), '获取群系统消息');
      ensure();
      let notifies = Array.isArray(res?.notifies) ? res.notifies : null;
      if (!notifies && pending) {
        notifies = (await pending).notifies;
        ensure();
      }
      const invited_requests = [];
      const join_requests = [];
      for (const item of notifies ?? []) {
        const groupId = Number(item.group?.groupCode ?? 0) || 0;
        const groupName = String(item.group?.groupName ?? '');
        const checked = item.status !== 1;
        const flagStr = `g:${item.group?.groupCode}:${item.type}:${item.seq}`;
        if (item.type === 1) {
          let invitor = 0;
          if (item.user2?.uid && typeof resolveUin === 'function') { try { invitor = Number(await resolveUin(item.user2.uid)); } catch { /* 0 */ } }
          invited_requests.push({ request_id: Number(item.seq) || 0, invitor_uin: invitor, invitor_nick: String(item.user2?.nickName ?? ''),
            group_id: groupId, group_name: groupName, checked, actor: invitor, flag: flagStr });
        } else if (item.type === 5 || item.type === 7) {
          let requester = 0;
          if (item.user1?.uid && typeof resolveUin === 'function') { try { requester = Number(await resolveUin(item.user1.uid)); } catch { /* 0 */ } }
          let actor = 0;
          if (item.actionUser?.uid && typeof resolveUin === 'function') { try { actor = Number(await resolveUin(item.actionUser.uid)); } catch { /* 0 */ } }
          join_requests.push({ request_id: Number(item.seq) || 0, requester_uin: requester, requester_nick: String(item.user1?.nickName ?? ''),
            message: String(item.postscript ?? ''), group_id: groupId, group_name: groupName, checked, actor, flag: flagStr });
        }
      }
      return { invited_requests, join_requests };
    }
    case 'group_detail_info': {
      const svc = groups();
      if (typeof svc.getGroupDetailInfo !== 'function') throw fail('当前 QQ 版本不支持获取群详细信息', 1500);
      const pending = waitFor ? waitFor('group_detail', item => String(item?.groupCode) === action.group, 8000) : null;
      const res = outcome(await svc.getGroupDetailInfo(action.group, 4), '获取群详细信息');
      ensure();
      let detail = res?.detail ?? (res?.groupCode ? res : null);
      if (!detail && pending) {
        detail = await pending;
        ensure();
      }
      if (!detail) throw fail('没有找到这个群的详细信息', 1404);
      return {
        group_id: Number(detail.groupCode ?? action.group),
        group_name: String(detail.groupName ?? ''),
        member_count: Number(detail.memberNum ?? detail.memberCount ?? 0) || 0,
        max_member_count: Number(detail.maxMemberNum ?? detail.maxMember ?? 0) || 0,
        owner_id: Number(detail.ownerUin ?? 0) || 0,
        group_memo: String(detail.groupMemo ?? detail.fingerMemo ?? ''),
        remark_name: String(detail.remarkName ?? ''),
        shut_up_all_timestamp: Number(detail.shutUpAllTimestamp ?? 0) || 0,
        shut_up_me_timestamp: Number(detail.shutUpMeTimestamp ?? 0) || 0,
      };
    }
    case 'group_share_link': {
      const svc = groups();
      if (typeof svc.getJoinGroupLink !== 'function') throw fail('当前 QQ 版本不支持获取加群链接', 1500);
      const res = outcome(await svc.getJoinGroupLink({ groupCode: action.group, srcId: 73, needShortUrl: true, additionalParam: '' }), '获取加群链接');
      ensure();
      return { url: String(res?.url ?? '') };
    }
    case 'group_notice_list': {
      const svc = groups();
      if (typeof svc.getGroupBulletinList !== 'function') throw fail('当前 QQ 版本不支持获取群公告', 1500);
      let pskey = '';
      try { pskey = await fetchPskey(session, 'qun.qq.com', ensure); } catch { /* try empty pskey */ }
      const pending = waitFor ? waitFor('group_bulletin', item => item.groupCode === action.group, 8000) : null;
      const res = outcome(await svc.getGroupBulletinList(action.group, pskey, '', { startIndex: -1, num: 20, needInstructionsForJoinGroup: 1, needPublisherInfo: 1 }), '获取群公告');
      ensure();
      let data = res?.feeds ? res : null;
      if (!data && pending) {
        data = (await pending).result;
        ensure();
      }
      const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
      return feeds.map(item => ({
        notice_id: String(item.feedId ?? ''),
        sender_id: Number(item.uin ?? 0) || 0,
        publish_time: Number(item.publishTime ?? 0) || 0,
        message: { text: String(item.msg?.text ?? ''), images: Array.isArray(item.msg?.pics) ? item.msg.pics.map(p => ({ id: String(p.id ?? ''), height: String(p.height ?? ''), width: String(p.width ?? '') })) : [] },
      }));
    }
    case 'group_notice_send': {
      const svc = groups();
      if (typeof svc.publishGroupBulletin !== 'function') throw fail('当前 QQ 版本不支持发布群公告', 1500);
      const pskey = await fetchPskey(session, 'qun.qq.com', ensure);
      let picInfo;
      if (action.media && typeof svc.uploadGroupBulletinPic === 'function') {
        const uploaded = outcome(await svc.uploadGroupBulletinPic(action.group, pskey, action.media.path), '上传群公告图片');
        ensure();
        picInfo = uploaded?.picInfo;
      }
      outcome(await svc.publishGroupBulletin(action.group, pskey, {
        text: action.content, ...(picInfo ? { picInfo } : {}), oldFeedsId: '', pinned: action.pinned ? 1 : 0, confirmRequired: 1,
      }), '发布群公告');
      return null;
    }
    case 'group_notice_del': {
      const svc = groups();
      if (typeof svc.deleteGroupBulletin !== 'function') throw fail('当前 QQ 版本不支持删除群公告', 1500);
      outcome(await svc.deleteGroupBulletin(action.group, '', action.noticeId), '删除群公告');
      return null;
    }
    case 'group_file_system_info': {
      const res = outcome(await rich().getGroupSpace(action.group), '获取群文件空间信息');
      ensure();
      const info = res?.groupSpaceResult ?? res ?? {};
      return {
        file_count: Number(info.allFileCount ?? info.fileCount ?? 0) || 0,
        limit_count: Number(info.limitCount ?? 1000) || 1000,
        used_space: Number(info.usedSpace ?? 0) || 0,
        total_space: Number(info.totalSpace ?? 0) || 0,
      };
    }
    case 'group_file_list': {
      const svc = rich();
      if (typeof svc.getGroupFileList !== 'function') throw fail('当前 QQ 版本不支持获取群文件列表', 1500);
      const params = { sortType: 1, fileCount: action.fileCount, startIndex: 0, sortOrder: 2, showOnlinedocFolder: 0, ...(action.folderId ? { folderId: action.folderId } : {}) };
      let reqId;
      const pending = waitFor ? waitFor('group_file_list', payload => reqId === undefined || payload?.reqId === reqId, 8000) : null;
      const res = await svc.getGroupFileList(action.group, params);
      ensure();
      let result = Array.isArray(res?.item) ? res : null;
      if (!result) {
        if (typeof res === 'number') reqId = res;
        else if (typeof res?.reqId === 'number') reqId = res.reqId;
        if (!pending) throw fail('当前会话不支持等待群文件列表回调', 1500);
        result = await pending;
        ensure();
      }
      outcome(result, '获取群文件列表');
      const files = [];
      const folders = [];
      for (const entry of result?.item ?? []) {
        if (entry?.fileInfo) {
          const f = entry.fileInfo;
          files.push({ group_id: Number(action.group), file_id: String(f.fileId ?? ''), file_name: String(f.fileName ?? ''), busid: Number(f.busId ?? 102) || 102,
            file_size: Number(f.fileSize ?? 0) || 0, upload_time: Number(f.uploadTime ?? 0) || 0, dead_time: Number(f.deadTime ?? 0) || 0,
            modify_time: Number(f.modifyTime ?? 0) || 0, download_times: Number(f.downloadTimes ?? 0) || 0,
            uploader: Number(f.uploaderUin ?? 0) || 0, uploader_name: String(f.uploaderName ?? '') });
        } else if (entry?.folderInfo) {
          const d = entry.folderInfo;
          folders.push({ group_id: Number(action.group), folder_id: String(d.folderId ?? ''), folder_name: String(d.folderName ?? ''),
            create_time: Number(d.createTime ?? 0) || 0, creator: Number(d.createUin ?? 0) || 0, creator_name: String(d.creatorName ?? ''),
            total_file_count: Number(d.totalFileCount ?? 0) || 0 });
        }
      }
      return { files, folders };
    }
    case 'create_group_folder': {
      const res = outcome(await rich().createGroupFolder(action.group, action.name), '创建群文件夹');
      ensure();
      return { folder_id: String(res?.resultWithGroupItem?.groupItem?.folderInfo?.folderId ?? res?.folderId ?? '') };
    }
    case 'delete_group_folder': {
      outcome(await rich().deleteGroupFolder(action.group, action.folderId), '删除群文件夹');
      return null;
    }
    case 'delete_group_file': {
      outcome(await rich().deleteGroupFile(action.group, [action.busid], [action.fileId]), '删除群文件');
      return null;
    }
    case 'rename_group_folder': {
      outcome(await rich().renameGroupFolder(action.group, action.folderId, action.newName), '重命名群文件夹');
      return null;
    }
    case 'trans_group_file': {
      const res = outcome(await rich().transGroupFile(action.group, action.fileId), '转存群文件');
      ensure();
      return { ok: true, result: res ?? null };
    }
    case 'get_group_file_url': {
      ensure();
      const cached = ctx.lookupMedia?.(action.fileId);
      if (typeof cached?.url === 'string' && /^https?:\/\//i.test(cached.url)) return { url: cached.url };
      return { url: await getGroupFileUrl(session, action, ensure, { sendPacket: ctx.sendPacket }) };
    }
    case 'friends_with_category': {
      if (typeof ctx.friendsWithCategory !== 'function') throw fail('当前会话不支持获取好友分组列表', 1500);
      return ctx.friendsWithCategory(action.noCache);
    }
    case 'friend_remark': {
      const uid = await ctx.uidFor(action.user);
      ensure();
      const buddy = session.getBuddyService?.();
      if (typeof buddy?.setBuddyRemark !== 'function') throw fail('当前 QQ 版本不支持修改好友备注', 1500);
      outcome(await buddy.setBuddyRemark({ uid, remark: action.remark }), '修改好友备注');
      return null;
    }
    case 'delete_friend': {
      const uid = await ctx.uidFor(action.user);
      ensure();
      const buddy = session.getBuddyService?.();
      if (typeof buddy?.delBuddy !== 'function') throw fail('当前 QQ 版本不支持删除好友', 1500);
      outcome(await buddy.delBuddy({ friendUid: uid, tempBlock: action.tempBlock, tempBothDel: action.tempBothDel }), '删除好友');
      return null;
    }
    case 'set_qq_profile': {
      const profile = session.getProfileService?.();
      if (!profile) throw fail('当前 QQ 会话不支持修改资料', 1500);
      let currentDetail = {};
      try { currentDetail = (await profile.getUserDetailInfoByUin?.(self.uin))?.detail?.simpleInfo ?? {}; } catch { /* ignore */ }
      ensure();
      const payload = {
        nick: action.nickname ?? currentDetail.coreInfo?.nick ?? '',
        longNick: action.personalNote ?? currentDetail.baseInfo?.longNick ?? '',
        sex: action.sex ?? currentDetail.baseInfo?.sex ?? 0,
        birthday: {
          birthday_year: String(currentDetail.baseInfo?.birthday_year ?? 0),
          birthday_month: String(currentDetail.baseInfo?.birthday_month ?? 0),
          birthday_day: String(currentDetail.baseInfo?.birthday_day ?? 0),
        },
        location: {},
      };
      if (typeof profile.modifySelfProfile === 'function') outcome(await profile.modifySelfProfile(payload), '修改个人资料');
      else if (typeof profile.modifyDesktopMiniProfile === 'function') outcome(await profile.modifyDesktopMiniProfile(payload), '修改个人资料');
      else throw fail('当前 QQ 版本不支持修改个人资料', 1500);
      return null;
    }
    case 'set_qq_avatar': {
      const profile = session.getProfileService?.();
      if (typeof profile?.setHeader !== 'function') throw fail('当前 QQ 版本不支持设置头像', 1500);
      outcome(await profile.setHeader(action.media.path), '设置头像');
      return null;
    }
    case 'recent_contact': {
      const svc = session.getRecentContactService?.();
      if (typeof svc?.getRecentContactListSnapShot !== 'function') throw fail('当前 QQ 版本不支持获取最近会话列表', 1500);
      const res = outcome(await svc.getRecentContactListSnapShot(action.count), '获取最近会话列表');
      ensure();
      const list = Array.isArray(res?.info?.changedList) ? res.info.changedList : Array.isArray(res?.changedList) ? res.changedList : [];
      return list.map(item => ({
        chatType: Number(item.chatType ?? 0),
        peerUid: String(item.peerUid ?? ''),
        peerUin: String(item.peerUin ?? ''),
        peerName: String(item.peerName ?? item.remark ?? ''),
        msgTime: Number(item.msgTime ?? 0) || 0,
        unreadCnt: Number(item.unreadCnt ?? 0) || 0,
      }));
    }
    case 'custom_face': {
      if (typeof msgs().fetchFavEmojiList !== 'function') throw fail('当前 QQ 版本不支持获取收藏表情', 1500);
      const res = outcome(await msgs().fetchFavEmojiList('', action.count, true, true), '获取收藏表情');
      ensure();
      const list = Array.isArray(res?.emojiInfoList) ? res.emojiInfoList : [];
      return list.map(item => String(item.url ?? '')).filter(Boolean);
    }
    case 'set_online_status': {
      if (typeof msgs().setStatus !== 'function') throw fail('当前 QQ 版本不支持设置在线状态', 1500);
      outcome(await msgs().setStatus({ status: action.status, extStatus: action.extStatus, batteryStatus: action.batteryStatus }), '设置在线状态');
      return null;
    }
    case 'ark_share': {
      if (action.shareType === 'group') {
        const res = outcome(await groups().getGroupRecommendContactArkJson(action.target), '获取群推荐卡片');
        ensure();
        return String(res?.arkJson ?? '');
      }
      const res = outcome(await session.getBuddyService().getBuddyRecommendContactArkJson(action.target, action.phone || '-'), '获取好友推荐卡片');
      ensure();
      return { arkJson: String(res?.arkMsg ?? ''), arkMsg: String(res?.arkMsg ?? '') };
    }
    case 'get_clientkey': {
      const ticket = session.getTicketService?.();
      if (typeof ticket?.forceFetchClientKey !== 'function') throw fail('当前 QQ 版本不支持获取 clientkey', 1500);
      const res = outcome(await ticket.forceFetchClientKey(''), '获取 clientkey');
      ensure();
      return { clientkey: String(res?.clientKey ?? '') };
    }
    case 'get_cookies': {
      const pskey = await fetchPskey(session, action.domain, ensure);
      const uin = 'o' + self.uin;
      return { cookies: `uin=${uin}; p_uin=${uin}; p_skey=${pskey}` };
    }
    case 'get_csrf_token': {
      const pskey = await fetchPskey(session, action.domain, ensure);
      return { token: calcBkn(pskey) };
    }
    case 'get_credentials': {
      const pskey = await fetchPskey(session, action.domain, ensure);
      const uin = 'o' + self.uin;
      return { cookies: `uin=${uin}; p_uin=${uin}; p_skey=${pskey}`, csrf_token: calcBkn(pskey) };
    }
    default:
      throw fail('尚未支持动作: ' + action.kind, 1404);
  }
}

module.exports = { validate, run, kinds, calcBkn };
