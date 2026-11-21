'use strict';

const { fail, identifier, integer, nativeId } = require('./common.cjs');
const { parseCQ } = require('./cq.cjs');
const admin = require('./admin.cjs');
const { createElementBuilder } = require('./elements.cjs');

// download_file 只接受公网 http(s)。允许任意 URL 会让这个动作变成 SSRF 跳板：打到内网、
// 127.0.0.1、链路本地地址，或者云环境的元数据地址（169.254.169.254）。
const PRIVATE_V4 = [
  [/^0\./, '0.0.0.0/8'],
  [/^10\./, '10.0.0.0/8'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, '100.64.0.0/10'],
  [/^127\./, '127.0.0.0/8'],
  [/^169\.254\./, '169.254.0.0/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16.0.0/12'],
  [/^192\.168\./, '192.168.0.0/16'],
];
const PRIVATE_V6 = [/^::$/, /^::1$/, /^f[cd]/, /^fe[89ab]/, /^::ffff:/];

function assertPublicHttpUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { throw fail('download_file 的 url 不是合法地址'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('download_file 只支持 http/https');
  if (url.username || url.password) throw fail('download_file 不接受带账号密码的 url');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw fail('download_file 的 url 没有主机名');
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) {
    throw fail(`download_file 拒绝本机或内网主机名：${host}`);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    for (const [pattern, range] of PRIVATE_V4) {
      if (pattern.test(host)) throw fail(`download_file 拒绝内网地址（${range}）：${host}`);
    }
  } else if (host.includes(':')) {
    for (const pattern of PRIVATE_V6) {
      if (pattern.test(host)) throw fail(`download_file 拒绝内网 IPv6 地址：${host}`);
    }
  }
  return url;
}

// 文件名只留安全字符：basename 挡不住 '..'，而 '..' 会让落盘路径跳出 data/downloads。
function safeDownloadName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 100);
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : '';
}

// 只拦会被 fetch 用来改变连接目标的头，其余（Referer / Authorization 等）原样保留。
const BLOCKED_DOWNLOAD_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te']);
function sanitizeDownloadHeaders(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (BLOCKED_DOWNLOAD_HEADERS.has(key.trim().toLowerCase())) continue;
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    out[key.trim()] = String(value).slice(0, 2000);
  }
  return Object.keys(out).length ? out : null;
}

// 边读边算，超过上限立刻停 —— 一次性 arrayBuffer 会把整份响应读进内存。
async function readBodyCapped(response, maxBytes) {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节上限`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}



// 原生方法直调表（一期只收只读动作）：动作名 → service 名 + 方法名 + 参数个数。
// 加一个动作只加一行。写入类动作单独分期，避免一次 PR 里混着有副作用的路径。
const NATIVE_OPS = {
  get_profile_like: { service: 'ProfileLike', method: 'getBuddyProfileLike', arity: 1, build: p => [Number(p.user_id)] },
  get_online_clients: { service: 'OnlineStatus', method: 'getOnlineFrdStatusInfos', arity: 0, build: () => [] },
  get_recent_contact: { service: 'RecentContact', method: 'getRecentContactList', arity: 0, build: () => [] },
  get_group_tags: { service: 'Group', method: 'getGroupTagRecords', arity: 1, build: p => [String(p.group_id ?? '')] },
  list_filesets: { service: 'FlashTransfer', method: 'getFileSetList', arity: 1, build: p => [{ pageCount: Number(p.count ?? 20), pageIndex: Number(p.index ?? 0) }] },
  get_clientkey: { service: 'Ticket', method: 'forceFetchClientKey', arity: 1, build: p => [String(p.cmd ?? '')] },
  get_msg_emoji_likes: { service: 'msg', method: 'getMsgEmojiLikesList', arity: 7, build: p => {
    const peer = (p.openqq_ref && typeof p.openqq_ref === 'object' && p.openqq_ref.peerUid)
      ? { chatType: Number(p.openqq_ref.chatType ?? 2), peerUid: String(p.openqq_ref.peerUid), guildId: String(p.openqq_ref.guildId ?? '') }
      : { chatType: p.group_id ? 2 : 1, peerUid: String(p.group_id ?? p.user_id ?? ''), guildId: '' };
    return [peer, String(p.msg_id ?? p.message_id ?? ''), String(p.emoji_id ?? ''), Number(p.count ?? 20), String(p.cookie ?? ''), 0, false];
  } },
  fetch_emoji_like: { service: 'msg', method: 'getMsgEmojiLikesList', arity: 7, build: p => {
    const peer = (p.openqq_ref && typeof p.openqq_ref === 'object' && p.openqq_ref.peerUid)
      ? { chatType: Number(p.openqq_ref.chatType ?? 2), peerUid: String(p.openqq_ref.peerUid), guildId: String(p.openqq_ref.guildId ?? '') }
      : { chatType: p.group_id ? 2 : 1, peerUid: String(p.group_id ?? p.user_id ?? ''), guildId: '' };
    return [peer, String(p.msg_id ?? p.message_id ?? ''), String(p.emoji_id ?? ''), Number(p.count ?? 20), String(p.cookie ?? ''), 0, false];
  } },
  get_ai_record: { service: 'Group', method: 'listAllAIVoice', arity: 1, build: p => [{ groupCode: String(p.group_id ?? '') }] },
  get_recent_emoji: { service: 'msg', method: 'getRecentUseEmojiList', arity: 0, build: () => [] },
  fetch_group_essence_list: { service: 'Group', method: 'getGroupLatestEssenceList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  fetch_group_essence_list_legacy: { service: 'Group', method: 'getGroupLatestEssenceList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  query_cached_essence: { service: 'Group', method: 'queryCachedEssenceMsg', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  get_group_bulletin_list: { service: 'Group', method: 'getGroupBulletinList', arity: 4, cbIndex: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), pageStart: Number(p.page ?? 0), pageLimit: Number(p.count ?? 20) }, Number(p.page ?? 0), Number(p.count ?? 20), {}];
  } },
  get_group_bulletin_read_users: { service: 'Group', method: 'getGroupBulletinReadUsers', arity: 6, cbIndex: 5, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), String(p.bulletin_id ?? p.feed_id ?? ''), Number(p.page ?? 0), Number(p.count ?? 20), '', null];
  } },
  get_group_tag_list: { service: 'Group', method: 'getGroupTagListByCategory', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? '') }];
  } },
  list_ai_voice: { service: 'Group', method: 'listAllAIVoice', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? '') }];
  } },
  get_group_member_level_info: { service: 'Group', method: 'getGroupMemberLevelInfo', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? '') }];
  } },
  get_group_shutup_list: { service: 'Group', method: 'queryGroupMuteMemberList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  get_group_shutup_list_legacy: { service: 'Group', method: 'queryGroupMuteMemberList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  get_transferable_group_list: { service: 'Group', method: 'getTransferableGroupList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  get_buddy_req: { service: 'Buddy', method: 'getBuddyReq', arity: 0, build: () => [] },
  get_like_list: { service: 'OnlineStatus', method: 'getLikeList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [Number(p.count ?? 20)];
  } },
  get_group_file_list: { service: 'RichMedia', method: 'getGroupFileList', arity: 2, cbIndex: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), pageStart: Number(p.page ?? 0), pageLimit: Number(p.count ?? 20) }, null];
  } },
  get_concern_weather: { service: 'NodeMisc', method: 'getConcernWeather', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{}];
  } },
  get_cities_weather: { service: 'NodeMisc', method: 'getCommonlyUsedCitiesWeather', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{}];
  } },
  get_bottom_emoji_table: { service: 'msg', method: 'getRecentUsedFaceList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{}];
  } },
  get_bottom_emoji_table_legacy: { service: 'msg', method: 'getRecentUsedFaceList', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{}];
  } },
  get_keyword_emoji: { service: 'msg', method: 'fetchGetHitEmotionsByWord', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    // 实测：参数必须是对象且带 word 字段（传字符串会回 words:"" 并返回全量，传 {word:'哈哈'} 才按词命中）
    return [{ word: String(p.word ?? p.keyword ?? p.text ?? '') }];
  } },
  get_keyword_emoji_legacy: { service: 'msg', method: 'fetchGetHitEmotionsByWord', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ word: String(p.word ?? p.keyword ?? p.text ?? '') }];
  } },
  fetch_group_notify: { service: 'Group', method: 'fetchGroupNotify', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), reqType: Number(p.req_type ?? 0) }];
  } },
  get_group_notifies_unread: { service: 'Group', method: 'getGroupNotifiesUnreadCount', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  get_single_screen_notifies: { service: 'Group', method: 'getSingleScreenNotifies', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [Boolean(p.doubt ?? false), Number(p.count ?? 20), String(p.cookie ?? '')];
  } },
  get_single_screen_notifies_v2: { service: 'Group', method: 'getSingleScreenNotifiesV2', arity: 4, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [Boolean(p.doubt ?? false), Number(p.count ?? 20), String(p.cookie ?? ''), Number(p.filter ?? 0)];
  } },
  get_group_invite_limit: { service: 'Group', method: 'getGroupInviteNoAuthLimitNum', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? '')];
  } },
  get_buddy_req_unread: { service: 'Buddy', method: 'getBuddyReqUnreadCnt', arity: 0, build: () => [] },
  get_add_friend_blocked_list: { service: 'Buddy', method: 'getAddFriendBlockedList', arity: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [Number(p.page ?? 0), Number(p.count ?? 20)];
  } },
  search_sys_faces: { service: 'Msg', method: 'fetchMarketEmoticonFaceImages', arity: 1, cbIndex: 0, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.keyword ?? p.word ?? '')];
  } },
  nc_get_user_status: { service: 'Profile', method: 'getStatus', arity: 2, cbIndex: 1, build: (p) => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    const id = String(p.uid ?? p.user_id ?? p.uin ?? '');
    return [{ uids: [id] }, null];
  } },
  nc_get_packet_status: { service: 'MSF', method: 'getMsfStatus', arity: 0, build: () => [] },

  // ── 写入类动作 ──
  delete_custom_face: { service: 'msg', method: 'deleteFavEmoji', arity: 1, build: p => [String(p.emoji_id ?? p.face_id ?? p.id ?? '')] },
  check_url_safely: { service: 'msg', method: 'checkMsgWithUrl', arity: 1, build: p => [{ url: String(p.url ?? p.text ?? '') }] },
  translate_en2zh: { service: 'RichMedia', method: 'translateEnWordToZn', arity: 1, build: p => [String(p.text ?? p.words ?? '')] },
  set_qq_profile: { service: 'Profile', method: 'setNickName', arity: 1, build: p => [String(p.nickname ?? p.nick ?? '')] },
  set_self_longnick: { service: 'Profile', method: 'setLongNick', arity: 1, build: p => [String(p.longNick ?? p.long_nick ?? p.sign ?? p.longnick ?? '')] },
  set_group_remark: { service: 'Group', method: 'modifyGroupRemark', arity: 2, build: p => [String(p.group_id ?? ''), String(p.remark ?? p.card ?? p.name ?? '')] },
  send_flash_msg: { service: 'FlashTransfer', method: 'sendFlashTransferMsg', arity: 1, build: p => {
      const heads = Array.isArray(p.heads) ? p.heads : [];
      const peer = p.peer_uid ?? p.peerUid ?? '';
      if (!heads.length && !peer) return [{}];
      return [{ MsgHeads: heads.length ? heads : [{ peerUid: String(peer), chatType: Number(p.group_id ? 2 : 1) }] }];
    } },
  delete_flash_file: { service: 'FlashTransfer', method: 'removeFolderFiles', arity: 2, build: p => [String(p.file_set_id ?? p.fileset ?? ''), Array.isArray(p.files) ? p.files : []] },
  send_to_new_members: { service: 'Group', method: 'publishInstructionForNewcomers', arity: 3, build: p => [String(p.group_id ?? ''), String(p.content ?? p.message ?? p.text ?? ''), Array.isArray(p.at) ? p.at : []] },
  mark_msg_as_read: { service: 'msg', method: 'setMsgRead', arity: 1, build: p => [{ chatType: Number(p.group_id ? 2 : 1), peerUid: String(p.group_id ?? p.user_id ?? ''), guildId: '' }] },
  mark_group_msg_as_read: { service: 'msg', method: 'setMsgRead', arity: 1, build: p => [{ chatType: 2, peerUid: String(p.group_id ?? ''), guildId: '' }] },
  mark_private_msg_as_read: { service: 'msg', method: 'setMsgRead', arity: 1, build: p => [{ chatType: 1, peerUid: String(p.user_id ?? ''), guildId: '' }] },
  set_msg_emoji_like: { service: 'msg', method: 'setMsgEmojiLikes', arity: 5, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    // `message_id` 是 OneBot 自增序号，不是 QQ 真 msgId（见 src/onebot.mjs 的 nextId++）。
    // 真 msgId + peerUid 要从 `openqq_ref` 拿 —— 和 reply 段、get_forward_msg、forward_* 完全同一套机制。
    const ref = nativeRef(p.openqq_ref);
    const msgId = ref ? String(ref.msgId) : String(p.message_id ?? p.msg_id ?? '');
    const peer = ref ? String(ref.peerUid) : nativePeerOf(p);
    const isSet = p.is_set === undefined ? true : Boolean(p.is_set);
    return [peer, msgId, String(p.emoji_id ?? p.emoji ?? ''), isSet ? 1 : 0, null];
  } },
  click_inline_button: { service: 'msg', method: 'clickInlineKeyboardButton', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ peer: nativePeerOf(p), msgId: String(p.message_id ?? ''), buttonId: String(p.button_id ?? p.id ?? '') }];
  } },
  click_tofu_button: { service: 'msg', method: 'clickTofuActionButton', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [nativePeerOf(p), String(p.message_id ?? ''), String(p.button_id ?? p.id ?? '')];
  } },
  set_mark_unread: { service: 'msg', method: 'setMarkUnreadFlag', arity: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [nativePeerOf(p), Boolean(p.unread ?? true)];
  } },
  like_or_dislike_report: { service: 'msg', method: 'likeOrDislikeReportForMsg', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [nativePeerOf(p), String(p.message_id ?? ''), Number(p.like ?? 1)];
  } },
  translate_ptt_to_text: { service: 'msg', method: 'translatePtt2Text', arity: 3, cbIndex: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [nativePeerOf(p), String(p.message_id ?? ''), {}];
  } },
  recall_nudge: { service: 'msg', method: 'recallNudge', arity: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [nativePeerOf(p), String(p.message_id ?? '')];
  } },
  add_group_essence: { service: 'Group', method: 'addGroupEssence', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), msgSeq: String(p.message_seq ?? p.msg_seq ?? ''), msgRandom: String(p.message_random ?? p.msg_random ?? '') }];
  } },
  remove_group_essence: { service: 'Group', method: 'removeGroupEssence', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), msgSeq: String(p.message_seq ?? p.msg_seq ?? ''), msgRandom: String(p.message_random ?? p.msg_random ?? '') }];
  } },
  publish_group_bulletin: { service: 'Group', method: 'publishGroupBulletin', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), content: String(p.content ?? p.text ?? '') }, String(p.content ?? p.text ?? ''), {}];
  } },
  delete_group_bulletin: { service: 'Group', method: 'deleteGroupBulletin', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), String(p.bulletin_id ?? p.feed_id ?? ''), null];
  } },
  remind_group_bulletin_read: { service: 'Group', method: 'remindGroupBulletinRead', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), String(p.bulletin_id ?? p.feed_id ?? ''), null];
  } },
  add_group_tag: { service: 'Group', method: 'addGroupTagToCategory', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    // 实测：字段名必须是 name（传 tag / tagName / tags 一律回 200012 "tag name is empty"）
    return [{ groupCode: String(p.group_id ?? ''), name: String(p.name ?? p.tag ?? '') }];
  } },
  remove_group_tag: { service: 'Group', method: 'removeGroupTagFromCategory', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), name: String(p.name ?? p.tag ?? '') }];
  } },
  save_ai_voice: { service: 'Group', method: 'saveAIVoice', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), voiceId: String(p.voice_id ?? ''), voiceName: String(p.voice_name ?? '') }];
  } },
  approval_friend_request: { service: 'Buddy', method: 'approvalFriendRequest', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ friendUid: String(p.uid ?? p.user_id ?? p.uin ?? ''), reqTime: String(p.flag ?? p.req_time ?? ''), accept: Boolean(p.approve ?? true) }];
  } },
  approval_doubt_buddy: { service: 'Buddy', method: 'approvalDoubtBuddyReq', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.uin ?? p.user_id ?? ''), Boolean(p.approve ?? true), null];
  } },
  del_buddy: { service: 'Buddy', method: 'delBuddy', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ friendUid: String(p.user_id ?? p.uin ?? '') }];
  } },
  set_buddy_remark: { service: 'Buddy', method: 'setBuddyRemark', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ uid: String(p.user_id ?? p.uin ?? ''), remark: String(p.remark ?? '') }];
  } },
  req_to_add_friends: { service: 'Buddy', method: 'reqToAddFriends', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ uin: String(p.user_id ?? p.uin ?? ''), msg: String(p.comment ?? p.message ?? '') }];
  } },
  set_like_status: { service: 'OnlineStatus', method: 'setLikeStatus', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ uin: String(p.user_id ?? p.uin ?? ''), status: Number(p.status ?? 0) }];
  } },
  check_like_status: { service: 'OnlineStatus', method: 'checkLikeStatus', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ uin: String(p.user_id ?? p.uin ?? '') }];
  } },
  do_qun_like: { service: 'Album', method: 'doQunLike', arity: 5, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), String(p.uin ?? ''), Number(p.count ?? 1), String(p.cookie ?? ''), null];
  } },
  trans_group_file: { service: 'RichMedia', method: 'transGroupFile', arity: 2, cbIndex: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), fileId: String(p.file_id ?? ''), busId: Number(p.bus_id ?? 102) }, null];
  } },
  rename_group_file: { service: 'RichMedia', method: 'renameGroupFile', arity: 5, cbIndex: 4, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), String(p.file_id ?? ''), String(p.new_name ?? p.name ?? ''), Number(p.bus_id ?? 102), null];
  } },
  image_translate: { service: 'RichMedia', method: 'imageTranslate', arity: 3, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.image_path ?? p.file ?? ''), String(p.source_lang ?? 'auto'), String(p.target_lang ?? 'zh')];
  } },
  clear_group_notifies: { service: 'Group', method: 'clearGroupNotifies', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), reqType: Number(p.req_type ?? 0) }];
  } },
  operate_sys_notify: { service: 'Group', method: 'operateSysNotify', arity: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ groupCode: String(p.group_id ?? ''), notifySeq: String(p.seq ?? p.flag ?? ''), accept: Boolean(p.approve ?? true) }, {}];
  } },
  invite_to_group: { service: 'Group', method: 'inviteToGroup', arity: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), Array.isArray(p.user_ids) ? p.user_ids.map(String) : [String(p.user_id ?? '')]];
  } },
  del_buddy_req: { service: 'Buddy', method: 'delBuddyReq', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ friendUid: String(p.uid ?? p.user_id ?? ''), reqTime: String(p.flag ?? '') }];
  } },
  set_block: { service: 'Buddy', method: 'setBlock', arity: 2, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.uid ?? p.user_id ?? ''), Boolean(p.block ?? true)];
  } },
  is_blocked: { service: 'Buddy', method: 'isBlocked', arity: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.uid ?? p.user_id ?? '')];
  } },
  upload_file_stream: { service: 'RichMedia', method: 'onlyUploadFile', arity: 2, cbIndex: 1, build: p => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ filePath: String(p.file ?? p.path ?? ''), fileName: String(p.name ?? '') }, null];
  } },
  add_custom_face_legacy: { service: 'Msg', method: 'addFavEmoji', arity: 1, build: (p) => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{ emojiId: String(p.emoji_id ?? p.emoji ?? p.file_id ?? ''), isOrigin: 1 }];
  } },
  set_group_portrait: { service: 'Avatar', method: 'forceDownloadGroupPortrait', arity: 3, cbIndex: 2, build: (p) => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [String(p.group_id ?? ''), { width: Number(p.width ?? 100), height: Number(p.height ?? 100) }, null];
  } },
  create_collection: { service: 'Collection', method: 'addCollection', arity: 1, build: (p) => {
    if (Array.isArray(p.raw_args)) return p.raw_args;
    return [{}];
  } },
};

// 不可撤回且影响他人的原生动作：默认只构造不发送，必须显式 confirm_danger。
// 判据是「发出去就撤不回来、也没有可读回的原值」——改备注、标记已读、点赞不在此列。
const IRREVERSIBLE = new Set([
  'del_buddy',
  'set_block',
  'del_buddy_req',
  'req_to_add_friends',
  'invite_to_group',
  'remove_group_essence',
  'delete_group_bulletin',
  'remove_group_tag',
  'delete_flash_file',
  'send_to_new_members',
  'publish_group_bulletin',
  'approval_friend_request',
  'approval_doubt_buddy',
]);

function nativeRefusal(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 2) return null;
  for (const key of NATIVE_FAIL_KEYS) {
    const text = value[key];
    if (typeof text === 'string' && text.trim() && NATIVE_FAIL_RE.test(text)) return text.trim().slice(0, 200);
  }
  // 只下钻这几个已知的包裹层（FlashTransfer 把结果放在 rsp 里），不扫整棵对象以免误伤。
  for (const key of ['rsp', 'value', 'data', 'info']) {
    const nested = nativeRefusal(value[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

// SSO 命令表：一个动作一行，加动作只加一行。
const oidb = require('./oidb-actions.cjs');

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
  // auto_escape: false means the same as leaving it out, so the CQ string is still parsed (and its media prepared); other values stay for validation.
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
  if (request.action === 'sso_pipe_status') return { kind: 'sso_pipe', action: 'sso_pipe_status' };
  if (request.action === 'sso_pipe_send') {
    const cmd = String(params.cmd ?? '').trim();
    if (!cmd) throw fail('sso_pipe_send 需要 cmd', 1400);
    if (cmd.length > 200) throw fail('sso_pipe_send 的 cmd 太长（>200）', 1400);
    const hex = String(params.hex ?? params.body_hex ?? '').replace(/\s+/g, '');
    if (hex && !/^[0-9a-fA-F]+$/.test(hex)) throw fail('sso_pipe_send 的 hex 不是合法十六进制', 1400);
    if (hex.length % 2 !== 0) throw fail('sso_pipe_send 的 hex 长度必须是偶数', 1400);
    if (hex.length / 2 > 16 * 1024 * 1024) throw fail('sso_pipe_send 的 body 超过 16MB', 1400);
    return { kind: 'sso_pipe', action: 'sso_pipe_send', cmd, body: Buffer.from(hex, 'hex') };
  }

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
  if (request.action === 'get_image') {
    const raw = params.file ?? params.file_id;
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024 || /[\u0000-\u001f]/.test(raw)) {
      throw fail('get_image 需要有效的 file 或 file_id');
    }
    return { kind: 'get_image', key: raw.trim() };
  }
  const managed = admin.validate(request, params);
  if (managed) return managed;
  // ── OIDB 动作 ────────────────────────────────────────────────────────
  // 放在 admin.validate 之后：已经有精确实现的动作（set_group_name / delete_group_file /
  // 群信息 / 好友事件）先拿到机会，不会被这张表抢走路由。这里只补「JS 层根本没有对应
  // 方法」的缺口（群设置、待办、管理员权限、闪传改名）。
  // 危险动作（danger:true，不可撤回且影响他人）默认只构造不发送，必须显式传 confirm_danger。
  if (oidb.OIDB_ACTIONS[request.action]) {
    const act = oidb.OIDB_ACTIONS[request.action];
    let body;
    try { body = oidb.buildOidbBody(request.action, params); }
    catch (e) { throw fail(`${request.action} 参数无效: ${e && e.message ? e.message : e}`, 1400); }
    if (act.danger && params.confirm_danger !== true) {
      return {
        kind: 'oidb_dryrun', action: request.action, cmd: act.wire,
        bodyHex: body.toString('hex'), bodyLen: body.length,
        note: '危险动作（不可撤回且影响他人）：默认只构造不发送。确认要真发时传 confirm_danger: true',
      };
    }
    return { kind: 'sso_pipe', action: request.action, cmd: act.wire, body };
  }
  if (NATIVE_OPS[request.action]) {
    const op = NATIVE_OPS[request.action];
    let args;
    try { args = op.build(params); }
    catch (error) { throw fail(`${request.action} 参数无效: ${error && error.message ? error.message : error}`, 1400); }
    if (!Array.isArray(args)) throw fail(`${request.action} 的参数构造没有返回数组`, 1400);
    // arity 是实测的原生 argc。个数不对时 C++ 只在日志里断言、OneBot 侧只看到一个没头没尾的 1500，
    // 所以这里提前拦下，把「实际几个 / 应该几个」直接说清楚。
    if (Number.isSafeInteger(op.arity) && args.length !== op.arity) {
      throw fail(`${request.action} 需要 ${op.arity} 个原生参数，实际构造了 ${args.length} 个`, 1400);
    }
    // 不可撤回的动作默认只构造不发送：这些一旦发出去就撤不回来。
    if (IRREVERSIBLE.has(request.action) && params.confirm_danger !== true) {
      return { kind: 'native_dryrun', action: request.action, service: op.service, method: op.method, args,
        note: '不可撤回的动作：默认只构造不发送。确认要真发时传 confirm_danger: true' };
    }
    return { kind: 'native_op', action: request.action, canonical: request.action, service: op.service, method: op.method, args, cbIndex: op.cbIndex };
  }
  if (request.action === 'native_call') {
    const method = String(params.method ?? '');
    if (!/^[A-Za-z][A-Za-z0-9_]{1,60}$/.test(method)) throw fail('native_call 需要 method', 1400);
    return { kind: 'native_op', action: 'native_call', service: String(params.service ?? 'msg'), method,
      args: Array.isArray(params.args) ? params.args.slice(0, 12) : [] };
  }
  if (request.action === 'download_file') {
    const url = String(params.url ?? '').trim();
    const b64 = String(params.base64 ?? '').trim();
    if (!url && !b64) throw fail('download_file 需要 url 或 base64', 1400);
    if (url) assertPublicHttpUrl(url);
    return {
      kind: 'download_file', action: 'download_file',
      url, base64: b64,
      name: safeDownloadName(params.name),
      headers: sanitizeDownloadHeaders(params.headers),
      maxBytes: integer(params.max_bytes, 'max_bytes', 1, 64 * 1024 * 1024, 32 * 1024 * 1024),
    };
  }
  if (request.action === 'forward_friend_single_msg' || request.action === 'forward_group_single_msg') {
    const ref = nativeRef(params.openqq_ref);
    if (!ref) throw fail(request.action + ' 的 message_id 无效或引用的消息已过期（仅支持本次运行期间收到的消息）', 1404);
    const isGroup = request.action === 'forward_group_single_msg';
    const target = String((isGroup ? params.group_id : params.user_id) ?? '').trim();
    if (!target) throw fail(request.action + ' 需要 ' + (isGroup ? 'group_id' : 'user_id'), 1400);
    return { kind: 'forward_send', action: request.action, source: ref, targetUin: target, targetChatType: isGroup ? 2 : 1 };
  }
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

  // ── 自研 SSO 发包（不依赖任何第三方注入组件）─────────────────────────
  // bootstrap 在 QQ 进程内把一次 std::string 构造的跳转目标改到我们这（4 字节 + 12 字节跳板），
  // 我们只负责告诉它"这一次 body 用我的字节"（arm），然后调 QQ 自己的
  // Msg.sendSsoCmdReqByContend —— 包由 QQ 发、回包也由 QQ 收，不做任何内存扫描。
  // 同一条命令在两个服务名前缀下可达性不同（有的会静默丢包），空回包时换另一个前缀再试一次。
  const namesOf = value => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return [];
    const set = new Set();
    for (let o = value; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor') set.add(n);
    }
    return Array.from(set).sort();
  };
  const serviceOf = name => {
    const key = String(name ?? '');
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) return null;
    const camel = key.charAt(0).toUpperCase() + key.slice(1);
    for (const getter of ['get' + camel + 'Service', 'get' + camel, key]) {
      if (typeof session[getter] !== 'function') continue;
      try { const svc = session[getter](); if (svc) return svc; } catch { /* 换下一个名字 */ }
    }
    return null;
  };

  async function selfSsoSend(cmd, bodyBuf) {
    const armFn = globalThis.__openqqSsoBodyConv;
    if (typeof armFn !== 'function') {
      return { ok: false, status: -1, note: '__openqqSsoBodyConv 不存在：需要新 bootstrap' };
    }
    const st = armFn('status', '');
    if (!st || !st.patched) {
      return { ok: false, status: -1, note: 'body 代劳补丁未安装（bootstrap 启动时应自动装；失败说明 wrapper.node 版本不符）' };
    }
    const bytes = Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.from(bodyBuf || []);

    const once = async (name) => {
      const arm = armFn('arm', bytes.toString('hex'));
      if (!arm || !arm.ok) return { ok: false, status: -1, note: 'arm 失败：' + JSON.stringify(arm || null) };
      const t0 = Date.now();
      let res;
      try {
        const svc = session.getMsgService();
        // 占位串只用来触发转换，内容随后由 native 覆盖成真 body。
        res = await Promise.resolve(svc.sendSsoCmdReqByContend(name, 'A'.repeat(bytes.length || 1)));
      } catch (error) {
        return { ok: false, status: -1, ms: Date.now() - t0,
          note: 'sendSsoCmdReqByContend 抛错：' + String((error && error.message) || error).slice(0, 180) };
      }
      const ms = Date.now() - t0;

      let resp = Buffer.alloc(0);
      if (res instanceof Uint8Array) resp = Buffer.from(res);
      else if (typeof res === 'string') resp = Buffer.from(res, 'latin1');
      else if (res && typeof res === 'object') {
        const raw = res.rsp ?? res.body ?? res.data;
        if (raw instanceof Uint8Array) resp = Buffer.from(raw);
        else if (typeof raw === 'string') resp = Buffer.from(raw, 'latin1');
      }

      // 解 OidbBase：1=command 2=subCommand 3=errorCode 4=body 5=errorMsg
      const ob = {};
      {
        let i = 0;
        const rv = () => { let v = 0n, s = 0n, c; do { if (i >= resp.length) throw new Error('eof'); c = resp[i++]; v |= BigInt(c & 0x7f) << s; s += 7n; } while (c & 0x80); return v; };
        while (i < resp.length) {
          let t; try { t = Number(rv()); } catch { break; }
          const field = t >>> 3, wire = t & 7;
          if (wire === 0) { try { ob[field] = Number(rv()); } catch { break; } }
          else if (wire === 2) { const n = Number(rv()); ob[field] = resp.subarray(i, i + n); i += n; }
          else if (wire === 5) i += 4;
          else if (wire === 1) i += 8;
          else break;
        }
      }
      // ⚠️ proto3 省略零值：errorCode==0 时 field3 根本不存在，不能拿 -1 当失败。
      // 另外 trpc 回包（群相册那类）没有 OidbBase 外壳，field3 可能是 bytes 而不是 varint ——
      // 这时它不是错误码，按 0 处理，否则会把成功显示成 errorCode=[object Object]。
      const errorCode = typeof ob[3] === 'number' ? ob[3] : 0;
      return {
        ok: errorCode === 0 && resp.length > 0,
        status: errorCode,
        errorCode,
        // field4 在正常回包里是 bytes，但也见过是 varint 的（这时 ob[4] 是 Number）。
        // 统一成 Buffer，否则下游 .subarray/.length 会抛（get_pskey 就因此报过
        // `body.subarray is not a function`）。
        body: Buffer.isBuffer(ob[4]) ? ob[4] : Buffer.alloc(0),
        errorMsg: ob[5] ? Buffer.from(ob[5]).toString('utf8') : '',
        response: resp,
        ms,
        cmdUsed: name,
        note: resp.length ? '' : '空回包',
      };
    };

    const first = await once(cmd);
    // 有回包（哪怕是业务错误码）就用它 —— 那是服务端的真实答复。
    if (first.response && first.response.length) return first;
    // arm 都失败（补丁没装等）就没必要重试第二个前缀。
    if (!first.ms && first.status === -1) return first;
    const alt = altSsoCmdName(cmd);
    if (!alt) return first;
    const second = await once(alt);
    if (second.response && second.response.length) {
      return { ...second, fallbackFrom: cmd, note: '' };
    }
    return { ...first, note: '两个前缀都没回包（' + cmd + ' / ' + alt + '）' };
  }

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
        if (action.kind === 'native_dryrun') {
      // 只回报将要调用的方法和参数，不发 —— sent:false 就是没有副作用。
      return { status: 'failed', retcode: 1404, data: {
        action: action.action, service: action.service, method: action.method,
        args: action.args, sent: false, note: action.note,
      } };
    }
    if (action.kind === 'native_op') {
      const svc = serviceOf(action.service);
      if (!svc) return { status: 'failed', retcode: 1404, data: { service: action.service }, message: '找不到 service ' + action.service };
      const fn = svc[action.method];
      if (typeof fn !== 'function') return { status: 'failed', retcode: 1404, data: { service: action.service, method: action.method }, message: 'service 上没有这个方法' };
      // 回调桥：内核里有一批方法（精华列表 / 群公告列表 / 群文件列表…）不 return，结果只从最后一个
      // 参数建成的回调里给出。IPC 传过来的 args 已经被 JSON 序列化过，函数在那种表示里活不下来，
      // 所以回调位置在**执行侧**注入（cbIndex 指向第几个参数），并把回调实参当作返回值上报。
      const callArgs = Array.isArray(action.args) ? action.args.slice() : [];
      const cbIndex = Number.isSafeInteger(action.cbIndex) ? action.cbIndex : -1;
      let cbValue; let cbCalled = false;
      if (cbIndex >= 0 && cbIndex < callArgs.length) {
        callArgs[cbIndex] = (...cbArgs) => { cbCalled = true; cbValue = cbArgs.length <= 1 ? cbArgs[0] : cbArgs; };
      }
      try {
        // 有些方法既不 return 也不回调（参数形状不对时内核会把调用吞掉），
        // 不设上限就会把这一次动作永久挂住，所以给一个有回调的等久一点、没回调的等短一点。
        const waitMs = cbIndex >= 0 ? 12000 : 6000;
        const value = await Promise.race([
          Promise.resolve(fn.apply(svc, callArgs)),
          new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('原生调用超时：该方法既没有同步返回也没有触发回调')), waitMs); if (t.unref) t.unref(); }),
        ]);
        const effective = (value === undefined || value === null) && cbCalled ? cbValue : value;
        let out = effective;
        try { out = JSON.parse(JSON.stringify(effective === undefined ? null : effective)); } catch { out = String(effective); }
        const nativeData = { action: action.action, service: action.service, method: action.method, argc: callArgs.length, via: cbCalled && (value === undefined || value === null) ? 'callback' : 'return', value: out };
        const refusal = nativeRefusal(out);
        if (refusal) return { status: 'failed', retcode: 1500, data: nativeData, message: 'QQ 拒绝' + action.action + '：' + refusal };
        return { status: 'ok', retcode: 0, data: nativeData };
      } catch (error) {
        return { status: 'failed', retcode: 1500, data: { action: action.action, service: action.service, method: action.method, argc: callArgs.length, cbCalled },
          message: String(error && error.message ? error.message : error).slice(0, 300) };
      }
    }
    if (action.kind === 'download_file') {
      // 落盘到 <openqq>/data/downloads/：这个目录只存下载结果，不会被当成代码或配置加载。
      const fsMod = require('node:fs');
      const pathMod = require('node:path');
      const dir = pathMod.join(__dirname, '..', 'data', 'downloads');
      fsMod.mkdirSync(dir, { recursive: true });
      const dest = pathMod.join(dir, action.name || ('download-' + Date.now() + '.bin'));
      let buf;
      if (action.base64) {
        buf = Buffer.from(String(action.base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (buf.length > action.maxBytes) {
          return { status: 'failed', retcode: 1400, data: { action: 'download_file', size: buf.length },
            message: `base64 内容超过 ${action.maxBytes} 字节上限` };
        }
      } else {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 60000);
        if (timer.unref) timer.unref();
        try {
          // redirect: 'manual' —— 跟随重定向会让一个公网地址 302 到内网，绕过 validateAction 里的主机检查。
          const res = await fetch(action.url, { headers: action.headers || {}, signal: ac.signal, redirect: 'manual' });
          if (res.status >= 300 && res.status < 400) {
            return { status: 'failed', retcode: 1400, data: { action: 'download_file', url: action.url, http: res.status },
              message: '下载失败：目标返回重定向，download_file 不跟随（避免被导向内网）' };
          }
          if (!res.ok) {
            return { status: 'failed', retcode: 1500, data: { action: 'download_file', url: action.url, http: res.status },
              message: '下载失败：HTTP ' + res.status };
          }
          buf = await readBodyCapped(res, action.maxBytes);
        } catch (error) {
          return { status: 'failed', retcode: 1500, data: { action: 'download_file', url: action.url },
            message: '下载失败：' + String(error && error.message ? error.message : error).slice(0, 160) };
        } finally { clearTimeout(timer); }
      }
      fsMod.writeFileSync(dest, buf);
      return { status: 'ok', retcode: 0, data: { action: 'download_file', file: dest, name: pathMod.basename(dest), size: buf.length } };
    }
    if (action.kind === 'forward_send') {
      // 源消息：来自主进程附加的 openqq_ref，里面有真 msgId + 源会话的 peerUid（nativeRef 已校验格式）
      const src = action.source;
      // 目标会话：把 targetUin（QQ 号/群号）换成 peerUid。getUserDetailInfoByUin 是 argc==1 + 异步，必须 await。
      let targetUid = '';
      try {
        const profileSvc = session.getProfileService();
        const det = await profileSvc.getUserDetailInfoByUin(action.targetUin);
        targetUid = String((det && det.detail && (det.detail.uid || (det.detail.simpleInfo && det.detail.simpleInfo.uid))) || '');
      } catch (e) {
        return { status: 'failed', retcode: 1500, data: { action: action.action, targetUin: action.targetUin },
          message: 'getUserDetailInfoByUin 抛错：' + String(e && e.message ? e.message : e).slice(0, 140) };
      }
      if (!targetUid) {
        return { status: 'failed', retcode: 1404, data: { action: action.action, targetUin: action.targetUin },
          message: '拿不到目标 peerUid（getUserDetailInfoByUin 返回空 uid）' };
      }
      const msgSvc = session.getMsgService();
      if (!msgSvc || typeof msgSvc.forwardMsg !== 'function') {
        return { status: 'failed', retcode: 1404, data: { action: action.action }, message: 'Msg.forwardMsg 不可用' };
      }
      // QQ NT 的 forwardMsg(msgInfos, target, options, callback)。
      // msgInfos 每项要 {msgId, msgSeq}；源消息的 peerUid/chatType 来自 openqq_ref。
      const msgInfos = [{
        msgId: String(src.msgId),
        msgSeq: String(src.msgId),
        peerUid: String(src.peerUid),
        chatType: Number(src.chatType),
      }];
      const target = { chatType: action.targetChatType, peerUid: targetUid, guildId: '' };
      const cbOut = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ __timeout: true }), 15000);
        if (timer.unref) timer.unref();
        try {
          msgSvc.forwardMsg(msgInfos, target, {}, (...a) => { clearTimeout(timer); resolve(a.length <= 1 ? a[0] : a); });
        } catch (e) {
          clearTimeout(timer);
          resolve({ __throw: String(e && e.message ? e.message : e).slice(0, 200) });
        }
      });
      const ok = Boolean(cbOut) && !cbOut.__timeout && !cbOut.__throw && Number(cbOut.result ?? 0) === 0;
      return {
        status: ok ? 'ok' : 'failed', retcode: ok ? 0 : 1500,
        data: { action: action.action, sourceMsgId: String(src.msgId), targetUin: action.targetUin,
          targetChatType: action.targetChatType, callback: cbOut },
        ...(ok ? {} : { message: cbOut && cbOut.__timeout ? 'forwardMsg 15 秒无回调（内核没触发）'
          : (cbOut && cbOut.__throw ? 'forwardMsg 抛错：' + cbOut.__throw : 'forwardMsg 回执非 0') }),
      };
    }
        if (action.kind === 'forward') {
          if (typeof options.expandForward !== 'function') throw fail('当前会话不支持获取合并转发', 1500);
          const messages = await options.expandForward(action.ref);
          ensure();
          return { self, forward: { ref: action.ref, messages } };
        }
    if (action.kind === 'oidb_dryrun') {
      // 只回报将要发送的字节，不发 —— 调用方看 sent:false 就知道没有副作用。
      return { status: 'failed', retcode: 1404, data: {
        action: action.action, cmd: action.cmd, bodyHex: action.bodyHex,
        bodyLen: action.bodyLen, sent: false, note: action.note,
      } };
    }
    if (action.kind === 'sso_pipe') {
      // 判据：status 0 + 有 body = 服务端真回了；status 非 0 时 note 是服务端原文。
      if (action.action === 'sso_pipe_status') {
        // 探活 = 问一次补丁装没装。装上了才算通道就绪。
        const armFn = globalThis.__openqqSsoBodyConv;
        const st = typeof armFn === 'function' ? (armFn('status', '') || {}) : { patched: false };
        const ok = Boolean(st && st.patched);
        return {
          status: ok ? 'ok' : 'failed', retcode: ok ? 0 : 1500,
          data: { channel: 'self', patched: Boolean(st && st.patched), ...st },
          ...(ok ? {} : { message: 'body 代劳补丁未安装：需要配套的 openqq-bootstrap（wrapper.node 版本不符时会装不上）' }),
        };
      }
      // 失败用 throw 表达：调用方那一层（session.cjs）只在 reject 时才写 retcode，
      // 返回 {status:'failed'} 会被当成成功包进 data 里，调用方看不出错。
      const r = await selfSsoSend(action.cmd, action.body);
      if (r.status !== 0) throw fail(r.note || ('SSO 发送失败，status=' + r.status), 1500);
      if (!r.body || !r.body.length) throw fail(r.note || '服务端没有回包（命令名或前缀可能不对）', 1500);
      return {
        cmd: action.cmd,
        status: r.status,
        responseLen: r.body.length,
        responseHex: r.body.subarray(0, 65536).toString('hex'),
      };
    }
    if (action.kind === 'get_login_info') return { user_id: Number(self.uin), nickname: '' };
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
        if (action.kind === 'get_image') {
          if (typeof options.resolveMedia !== 'function') throw fail('当前会话不支持获取图片', 1500);
          const media = await options.resolveMedia(action.key, 'image');
          ensure();
          return media;
        }
        if (admin.kinds.has(action.kind)) {
          return await admin.run(action, {
            session, ensure, groupList,
            friendList: async () => {
              if (typeof options.friendList !== 'function') throw fail('当前会话不支持获取好友列表', 1500);
              const list = await options.friendList();
              ensure();
              return list;
            },
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
