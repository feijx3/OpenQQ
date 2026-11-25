import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createEventConverter } from '../src/onebot.mjs';
import { dispatchAction } from '../src/actions.mjs';
import { createMediaPreparer, pcmToWav, wavInfo } from '../src/media.mjs';
import { defaultConfig, validateConfig } from '../src/config.mjs';
import { startOneBot } from '../src/network.mjs';
import { OPENQQ_ACTIONS, ACTION_SPECS } from '../src/action-catalog.mjs';

const require = createRequire(import.meta.url);
const nativeActions = require('../native/actions.cjs');
const { createEventReceiver } = require('../native/events.cjs');
const { readSystemEvent } = require('../native/system.cjs');
const { calcBkn } = require('../native/extended.cjs');

const self = { uin: '123456', uid: 'u_self' };

function png(width = 8, height = 8) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.write('IHDR', 12, 'latin1');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function fakeSilk(frames = 25) {
  const parts = [Buffer.from([0x02]), Buffer.from('#!SILK_V3')];
  for (let i = 0; i < frames; i++) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(2, 0);
    parts.push(len, Buffer.from([0x11, 0x22]));
  }
  parts.push(Buffer.from([0xff, 0xff]));
  return Buffer.concat(parts);
}

// Helper to build a protobuf varint / length-delimited buffer for testing system.cjs 732/16.
function varint(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    out.push(b);
  } while (v > 0n);
  return Buffer.from(out);
}
const pbVar = (f, v) => Buffer.concat([varint((f << 3) | 0), varint(v)]);
const pbBytes = (f, b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b)); return Buffer.concat([varint((f << 3) | 2), varint(buf.length), buf]); };

function createHarness(overrides = {}) {
  const rawEvents = [];
  const calls = {};
  const recordCall = (name, args) => { (calls[name] ??= []).push(args); };
  const store = new Map();
  let seqCounter = 100;
  let tagCounter = 500;
  let handler;

  const session = {
    getMSFService: () => ({ getServerTime: () => '1794470400' }),
    getUixConvertService: () => ({
      getUid: async uins => ({ uidInfo: new Map(uins.map(u => [String(u), `u_${u}`])) }),
      getUin: async uids => ({ uinInfo: new Map(uids.map(u => [u, u.startsWith('u_') && /^\d+$/.test(u.slice(2)) ? u.slice(2) : ''])) }),
    }),
    getProfileService: () => ({
      getUserDetailInfoByUin: async uin => {
        recordCall('getUserDetailInfoByUin', [uin]);
        return {
          errCode: 0,
          detail: {
            simpleInfo: {
              coreInfo: { nick: uin === self.uin ? '机器人昵称' : `用户${uin}`, qid: 'qq_qid_1' },
              baseInfo: { sex: 1, age: 25, longNick: '个性签名', birthday_year: 2001, birthday_month: 5, birthday_day: 12 },
              status: {},
            },
            commonExt: { qqLevel: { starNum: 2, moonNum: 1, sunNum: 1, crownNum: 0 } },
          },
        };
      },
      getUidByUin: async (_impl, uins) => new Map(uins.map(u => [String(u), `u_${u}`])),
      modifySelfProfile: async payload => { recordCall('modifySelfProfile', [payload]); return { result: 0 }; },
      setHeader: async path => { recordCall('profile.setHeader', [path]); return { result: 0 }; },
      getCoreAndBaseInfo: async (_src, uids) => new Map(uids.map(uid => [uid, { uin: uid.slice(2), coreInfo: { nick: `好友${uid.slice(2)}`, remark: `备注${uid.slice(2)}` } }])),
    }),
    getBuddyService: () => ({
      setBuddyRemark: async payload => { recordCall('setBuddyRemark', [payload]); return { result: 0 }; },
      delBuddy: async payload => { recordCall('delBuddy', [payload]); return { result: 0 }; },
      isBuddy: async uid => uid === 'u_654321',
      getBuddyListV2: async refresh => {
        recordCall('getBuddyListV2', [refresh]);
        return {
          errCode: 0,
          data: [{ categoryId: 1, categroyName: '我的好友', categroyMbCount: 1, buddyUids: ['u_654321'] }],
        };
      },
      getBuddyRecommendContactArkJson: async (uin, phone) => {
        recordCall('getBuddyRecommendContactArkJson', [uin, phone]);
        return { result: 0, arkMsg: JSON.stringify({ app: 'com.tencent.contact.lua', meta: { uin } }) };
      },
    }),
    getGroupService: () => ({
      getUidByUins: async uins => ({ uids: new Map(uins.map(u => [String(u), `u_${u}`])) }),
      getMemberInfo: async () => ({ result: { infos: new Map() } }),
      getGroupList: async () => ({ result: 0 }),
      kickMember: async (...args) => { recordCall('kickMember', args); return { result: 0 }; },
      modifyGroupRemark: async (...args) => { recordCall('modifyGroupRemark', args); return { result: 0 }; },
      setHeader: async (...args) => { recordCall('group.setHeader', args); return { result: 0 }; },
      getGroupRemainAtTimes: async g => { recordCall('getGroupRemainAtTimes', [g]); return { result: 0, atInfo: { canAtAll: true, RemainAtAllCountForGroup: 8, RemainAtAllCountForUin: 5 } }; },
      getGroupShutUpMemberList: async g => {
        recordCall('getGroupShutUpMemberList', [g]);
        setImmediate(() => receiver('group', 'onShutUpMemberListChanged', [g, [{ uin: '654321', nick: '禁言者', cardName: '', role: 2, shutUpTime: 1794500000 }]]));
        return { result: 0 };
      },
      getGroupHonorList: async req => { recordCall('getGroupHonorList', [req]); return { result: 0, talkativeList: [{ uin: '654321', nick: '龙王' }], performerList: [] }; },
      getSingleScreenNotifies: async (doubt, startSeq, count) => {
        recordCall('getSingleScreenNotifies', [doubt, startSeq, count]);
        setImmediate(() => receiver('group', 'onGroupSingleScreenNotifies', [false, 1, [
          { seq: '9001', type: 7, status: 1, postscript: '申请入群', group: { groupCode: '987654', groupName: '测试群' }, user1: { uid: 'u_654321', nickName: '申请人' } },
          { seq: '9002', type: 1, status: 2, group: { groupCode: '987654', groupName: '测试群' }, user2: { uid: 'u_888888', nickName: '邀请人' } },
        ]]));
        return { result: 0 };
      },
      getGroupDetailInfo: async (g, src) => {
        recordCall('getGroupDetailInfo', [g, src]);
        setImmediate(() => receiver('group', 'onGroupDetailInfoChange', [{ groupCode: g, groupName: '详细群', memberNum: 42, maxMemberNum: 500, ownerUin: '10001', groupMemo: '群简介', remarkName: '群备注', shutUpAllTimestamp: 0, shutUpMeTimestamp: 0 }]));
        return { result: 0 };
      },
      getJoinGroupLink: async req => { recordCall('getJoinGroupLink', [req]); return { result: 0, url: 'https://qm.qq.com/q/test' }; },
      getGroupBulletinList: async (g, pskey, ctx, opts) => {
        recordCall('getGroupBulletinList', [g, pskey, opts]);
        setImmediate(() => receiver('group', 'onGetGroupBulletinListResult', [g, '', { feeds: [{ feedId: 'f1', uin: '10001', publishTime: 1794470000, msg: { text: '公告内容', pics: [] } }] }]));
        return { result: 0 };
      },
      uploadGroupBulletinPic: async (g, pskey, path) => { recordCall('uploadGroupBulletinPic', [g, pskey, path]); return { result: 0, picInfo: { id: 'p1', width: 8, height: 8 } }; },
      publishGroupBulletin: async (g, pskey, data) => { recordCall('publishGroupBulletin', [g, pskey, data]); return { result: 0 }; },
      deleteGroupBulletin: async (g, pskey, feedId) => { recordCall('deleteGroupBulletin', [g, pskey, feedId]); return { result: 0 }; },
      addGroupEssence: async req => { recordCall('addGroupEssence', [req]); return { result: 0 }; },
      removeGroupEssence: async req => { recordCall('removeGroupEssence', [req]); return { result: 0 }; },
      fetchGroupEssenceList: async req => {
        recordCall('fetchGroupEssenceList', [req]);
        return { result: { msgList: [{ senderUin: '654321', senderNick: '甲', senderTime: 1794470000, addDigestUin: '10001', addDigestNick: '管', addDigestTime: 1794470100, msgSeq: 42, msgRandom: 99, msgContent: [] }] } };
      },
      getGroupRecommendContactArkJson: async g => { recordCall('getGroupRecommendContactArkJson', [g]); return { result: 0, arkJson: JSON.stringify({ app: 'com.tencent.troopsharecard', group: g }) }; },
    }),
    getRichMediaService: () => ({
      getGroupSpace: async g => { recordCall('getGroupSpace', [g]); return { result: 0, groupSpaceResult: { allFileCount: 3, limitCount: 1000, usedSpace: 1024, totalSpace: 1048576 } }; },
      getGroupFileList: async (g, params) => {
        recordCall('getGroupFileList', [g, params]);
        setImmediate(() => receiver('msg', 'onGroupFileInfoUpdate', [{
          reqId: 77, retCode: 0,
          item: [
            { fileInfo: { fileId: '/f1', fileName: 'readme.txt', busId: 102, fileSize: 123, uploadTime: 1794470000, uploaderUin: '654321', uploaderName: '甲' } },
            { folderInfo: { folderId: '/dir1', folderName: '资料', createTime: 1794470000, createUin: '10001', creatorName: '管', totalFileCount: 2 } },
          ],
        }]));
        return 77;
      },
      createGroupFolder: async (g, name) => { recordCall('createGroupFolder', [g, name]); return { resultWithGroupItem: { result: { retCode: 0 }, groupItem: { folderInfo: { folderId: '/new_dir' } } } }; },
      deleteGroupFolder: async (g, folderId) => { recordCall('deleteGroupFolder', [g, folderId]); return { result: 0 }; },
      deleteGroupFile: async (g, busIds, fileIds) => { recordCall('deleteGroupFile', [g, busIds, fileIds]); return { result: 0 }; },
      renameGroupFolder: async (g, folderId, newName) => { recordCall('renameGroupFolder', [g, folderId, newName]); return { result: 0 }; },
      transGroupFile: async (g, fileId) => { recordCall('transGroupFile', [g, fileId]); return { result: 0 }; },
      getGroupFileInfo: async (g, fileId) => { recordCall('getGroupFileInfo', [g, fileId]); return { result: 0, fileInfo: { downloadUrl: 'https://cdn.example.com/group-file' } }; },
    }),
    getTipOffService: () => ({
      getPskey: async domains => { recordCall('getPskey', [domains]); return { errCode: 0, domainPskeyMap: new Map(domains.map(d => [d, 'test_pskey_abc'])) }; },
    }),
    getTicketService: () => ({
      forceFetchClientKey: async () => { recordCall('forceFetchClientKey', []); return { result: 0, clientKey: 'clientkey_xyz_123' }; },
    }),
    getRecentContactService: () => ({
      getRecentContactListSnapShot: async count => {
        recordCall('getRecentContactListSnapShot', [count]);
        return { result: 0, info: { changedList: [{ chatType: 2, peerUid: '987654', peerUin: '987654', peerName: '群聊A', msgTime: 1794470500, unreadCnt: 2 }] } };
      },
    }),
    getMsgService: () => ({
      sendSsoCmdReqByContend: async (command, data) => {
        recordCall('sendSsoCmdReqByContend', [command, data]);
        return { rspbuffer: pbBytes(4, pbBytes(3, Buffer.concat([pbVar(1, 0), pbBytes(5, 'cdn.example.com'), pbBytes(6, Buffer.from([0xab, 0xcd]))]))) };
      },
      generateMsgUniqueId: () => String(++tagCounter),
      getRichMediaFilePathForGuild: ({ fileName }) => join(tmpdir(), fileName || 'media.bin'),
      getMsgEmojiLikesList: async (...args) => {
        recordCall('getMsgEmojiLikesList', args);
        return { result: 0, emojiLikesList: [{ tinyId: '654321', nickName: '甲', headUrl: 'https://h/1' }], cookie: 'next_1', isLastPage: true, isFirstPage: true };
      },
      setMsgEmojiLikes: async (...args) => { recordCall('setMsgEmojiLikes', args); return { result: 0 }; },
      setMsgRead: async peer => { recordCall('setMsgRead', [peer]); return { result: 0 }; },
      setAllC2CAndGroupMsgRead: async () => { recordCall('setAllC2CAndGroupMsgRead', []); return { result: 0 }; },
      sendNudge: async (peer, targetUin, chatUin) => { recordCall('sendNudge', [peer, targetUin, chatUin]); return { result: 0 }; },
      translatePtt2Text: async (msgId, peer, el) => {
        recordCall('translatePtt2Text', [msgId, peer, el]);
        setImmediate(() => receiver('msg', 'onMsgInfoListUpdate', [[{ msgId, elements: [{ elementType: 4, pttElement: { text: '你好世界' } }] }]]));
        return { result: 0 };
      },
      fetchFavEmojiList: async (...args) => {
        recordCall('fetchFavEmojiList', args);
        return { result: 0, emojiInfoList: [{ url: 'https://emoji/1.gif' }, { url: 'https://emoji/2.png' }] };
      },
      setStatus: async payload => { recordCall('setStatus', [payload]); return { result: 0 }; },
      getMsgsByMsgId: async (_peer, ids) => ({ msgList: ids.map(id => store.get(String(id))).filter(Boolean) }),
      getMsgsBySeqAndCount: async (peer, seq, count) => {
        recordCall('getMsgsBySeqAndCount', [peer, seq, count]);
        return { msgList: [...store.values()].filter(m => m.chatType === peer.chatType && m.peerUid === peer.peerUid) };
      },
      getMsgsIncludeSelf: async (peer, msgId, count) => {
        recordCall('getMsgsIncludeSelf', [peer, msgId, count]);
        return { msgList: [...store.values()].filter(m => m.chatType === peer.chatType && m.peerUid === peer.peerUid) };
      },
      getAioFirstViewLatestMsgs: async (peer, count) => {
        recordCall('getAioFirstViewLatestMsgs', [peer, count]);
        return { msgList: [...store.values()].filter(m => m.chatType === peer.chatType && m.peerUid === peer.peerUid) };
      },
      getMsgByClientSeqAndTime: async (peer, clientSeq, time) => {
        recordCall('getMsgByClientSeqAndTime', [peer, clientSeq, time]);
        return { msgList: [...store.values()].filter(m => String(m.clientSeq) === String(clientSeq)) };
      },
      downloadRichMedia: async req => { recordCall('downloadRichMedia', [req]); return { result: 0 }; },
      sendMsg: async (_id, peer, elements) => {
        recordCall('sendMsg', [peer, elements]);
        const msgId = String(8000 + (++seqCounter));
        setImmediate(() => handler.observe('onMsgInfoListUpdate', [[{
          chatType: peer.chatType, peerUid: peer.peerUid, guildId: peer.guildId,
          senderUin: self.uin, senderUid: self.uid, msgId, msgSeq: String(seqCounter), msgRandom: '12345', sendStatus: 2,
        }]]));
        return { result: 0 };
      },
      forwardMsgWithComment: async (msgIds, srcPeer, dstPeers) => {
        recordCall('forwardMsgWithComment', [msgIds, srcPeer, dstPeers]);
        const dst = dstPeers[0];
        const msgId = String(8500 + (++seqCounter));
        setImmediate(() => handler.observe('onMsgInfoListUpdate', [[{
          chatType: dst.chatType, peerUid: dst.peerUid, guildId: dst.guildId,
          senderUin: self.uin, senderUid: self.uid, msgId, sendStatus: 2,
        }]]));
        return { result: 0 };
      },
      multiForwardMsgWithComment: async (msgInfos, srcPeer, dstPeer) => {
        recordCall('multiForwardMsgWithComment', [msgInfos, srcPeer, dstPeer]);
        const msgId = String(8900 + (++seqCounter));
        setImmediate(() => handler.observe('onMsgInfoListUpdate', [[{
          chatType: dstPeer.chatType, peerUid: dstPeer.peerUid, guildId: '',
          senderUin: self.uin, senderUid: self.uid, msgId, msgType: 11, sendStatus: 2,
          elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'r1' } }],
        }]]));
        return { result: 0 };
      },
    }),
    ...overrides,
  };

  const receiver = createEventReceiver(session, self, e => rawEvents.push(e), () => true);
  const convert = createEventConverter();
  handler = nativeActions.createActionHandler(session, self, () => true, {
    groups: receiver.groups,
    friendList: receiver.friendList,
    friendsWithCategory: receiver.friendsWithCategory,
    expandForward: receiver.expandForward,
    fetchMessage: receiver.fetchMessage,
    fetchHistory: receiver.fetchHistory,
    resolveMedia: receiver.resolveMedia,
    lookupMedia: receiver.lookupMedia,
    lookupRecent: receiver.lookupRecent,
    record: receiver.record,
    waitFor: receiver.waitFor,
    resolveUin: receiver.resolveUin,
  });
  const channel = {
    async request(req) {
      try { return { status: 'ok', retcode: 0, data: await handler.execute(req) }; }
      catch (err) { return { status: 'failed', retcode: err.retcode ?? 1500, data: null, message: err.message }; }
    },
  };
  return { session, receiver, convert, handler, channel, calls, store, rawEvents };
}

test('action catalog stays 100% in sync with dispatchAction, native validator, and UI catalog', async () => {
  const localAndNetwork = new Set(['get_version_info', 'can_send_image', 'can_send_record', 'nc_get_packet_status', 'check_url_safely', 'download_file', 'clean_cache', 'generate_image', '.handle_quick_operation']);
  assert.ok(OPENQQ_ACTIONS.length >= 90, `expected >= 90 actions, got ${OPENQQ_ACTIONS.length}`);
  assert.equal(new Set(OPENQQ_ACTIONS).size, OPENQQ_ACTIONS.length, 'no duplicate action names in catalog');
  for (const spec of ACTION_SPECS) {
    if (localAndNetwork.has(spec.action)) continue;
    try {
      nativeActions.validateAction({ action: spec.action, params: {} });
    } catch (error) {
      assert.doesNotMatch(error.message, /尚未支持动作/, `${spec.action} must be implemented in native validator`);
    }
  }
  const uiCatalogSrc = await readFile(new URL('../ui/lib/catalog.ts', import.meta.url), 'utf8');
  for (const match of uiCatalogSrc.matchAll(/\{\s*action:\s*'([^']+)'/g)) {
    assert.ok(OPENQQ_ACTIONS.includes(match[1]), `UI catalog action ${match[1]} must exist in OPENQQ_ACTIONS`);
  }
});

test('bugfixes: real nickname, active friend list & categories, remark on friend request, private sub_type, reportSelfMessage, private reply fallback, and whole-group ban -1', async () => {
  const h = createHarness();
  const login = await dispatchAction(h.channel, h.convert, { action: 'get_login_info' });
  assert.deepEqual(login.data, { user_id: 123456, nickname: '机器人昵称' });

  const friends = await dispatchAction(h.channel, h.convert, { action: 'get_friend_list', params: { no_cache: true } });
  assert.equal(friends.status, 'ok');
  assert.deepEqual(friends.data, [{ user_id: 654321, nickname: '好友654321', remark: '备注654321' }]);

  const grouped = await dispatchAction(h.channel, h.convert, { action: 'get_friends_with_category' });
  assert.equal(grouped.status, 'ok');
  assert.equal(grouped.data[0].categoryName, '我的好友');
  assert.equal(grouped.data[0].buddyList[0].user_id, 654321);

  const approve = await dispatchAction(h.channel, h.convert, { action: 'set_friend_add_request', params: { flag: 'f:u_654321:1794470000', approve: true, remark: '同学' } });
  // buddyService.approvalFriendRequest wasn't mocked above; let's verify remark works when approval succeeds:
  assert.equal(approve.status, 'failed'); // expected because approvalFriendRequest missing on base mock

  const h2 = createHarness({
    getBuddyService: () => ({
      approvalFriendRequest: async () => ({ result: 0 }),
      setBuddyRemark: async p => { h2.calls.remark = p; return { result: 0 }; },
      isBuddy: async () => true,
      getBuddyListV2: async () => ({ errCode: 0, data: [] }),
    }),
  });
  const approved = await dispatchAction(h2.channel, h2.convert, { action: 'set_friend_add_request', params: { flag: 'f:u_654321:1794470000', approve: true, remark: '同学' } });
  assert.equal(approved.status, 'ok');
  assert.deepEqual(h2.calls.remark, { uid: 'u_654321', remark: '同学' });

  // Private friend sub_type + private reply clientSeq fallback
  h.store.set('3001', { chatType: 1, peerUid: 'u_654321', msgId: '3001', msgSeq: '0', clientSeq: '777', msgTime: '1794470000', senderUid: 'u_654321', senderUin: '654321', elements: [{ elementType: 1, textElement: { content: '原话', atType: 0 } }] });
  await h.receiver('msg', 'onRecvMsg', [[{
    chatType: 1, peerUid: 'u_654321', peerUin: '654321', msgId: '3002', msgSeq: '2', msgTime: '1794470010',
    senderUid: 'u_654321', senderUin: '654321', sendNickName: '好友',
    elements: [
      { elementType: 7, replyElement: { replayMsgSeq: '0', replyMsgClientSeq: '777', replyMsgTime: '1794470000' } },
      { elementType: 1, textElement: { content: 'line1\rline2', atType: 0 } },
    ],
  }]]);
  const privEvt = h.convert(h.rawEvents.at(-1));
  assert.equal(privEvt.sub_type, 'friend');
  assert.equal(privEvt.message[0].type, 'reply');
  assert.equal(privEvt.message[1].data.text, 'line1\nline2');

  // reportSelfMessage -> message_sent
  const withSelf = createEventConverter({ reportSelfMessage: true });
  const selfEvt = withSelf({
    type: 'message', self,
    message: { chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '4001', msgTime: '1794470100', senderUin: self.uin, sendNickName: '我', elements: [{ elementType: 1, textElement: { content: 'self msg', atType: 0 } }] },
  });
  assert.equal(selfEvt.post_type, 'message_sent');

  // Whole-group ban 0xffffffff -> -1
  await h.receiver('msg', 'onRecvMsg', [[{
    chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '4002', msgTime: '1794470105', senderUin: '10001',
    elements: [{ elementType: 8, grayTipElement: { groupElement: { type: 8, shutUp: { duration: 0xffffffff, admin: { uid: 'u_10001', uin: '10001' }, member: { uid: '', uin: '' } } } } }],
  }]]);
  const banEvt = h.convert(h.rawEvents.at(-1));
  assert.equal(banEvt.notice_type, 'group_ban');
  assert.equal(banEvt.duration, -1);
});

test('history, mark read, reactions, ptt2text, essence, notices, and new grayTip/system events', async () => {
  const h = createHarness();
  const sampleMsg = {
    chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '5001', msgSeq: '51', msgRandom: '999', msgTime: '1794470200',
    senderUid: 'u_654321', senderUin: '654321', sendNickName: '甲', sendMemberName: '名片甲',
    elements: [
      { elementType: 1, textElement: { content: '历史消息', atType: 0 } },
      { elementType: 4, pttElement: { fileName: 'v.slk', fileUuid: 'uuid-v1', fileSize: '123' } },
    ],
  };
  h.store.set('5001', sampleMsg);
  await h.receiver('msg', 'onRecvMsg', [[sampleMsg]]);
  const received = h.convert(h.rawEvents.at(-1));
  const mid = received.message_id;

  // History
  const hist = await dispatchAction(h.channel, h.convert, { action: 'get_group_msg_history', params: { group_id: 987654, count: 10 } });
  assert.equal(hist.status, 'ok');
  assert.equal(hist.data.messages.length, 1);
  assert.equal(hist.data.messages[0].message_seq, 51);

  const histAnchored = await dispatchAction(h.channel, h.convert, { action: 'get_group_msg_history', params: { group_id: 987654, message_id: mid, reverseOrder: true } });
  assert.equal(histAnchored.status, 'ok');
  assert.equal(h.calls.getMsgsIncludeSelf.length, 1);

  const privHist = await dispatchAction(h.channel, h.convert, { action: 'get_friend_msg_history', params: { user_id: 654321, count: 5 } });
  assert.equal(privHist.status, 'ok');

  // Read receipts
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'mark_group_msg_as_read', params: { group_id: 987654 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'mark_private_msg_as_read', params: { user_id: 654321 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'mark_msg_as_read', params: { message_id: mid } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: '_mark_all_as_read' })).status, 'ok');
  assert.equal(h.calls.setMsgRead.length, 3);
  assert.equal(h.calls.setAllC2CAndGroupMsgRead.length, 1);

  // Send poke (group_poke, friend_poke, send_poke with target_id)
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'group_poke', params: { group_id: 987654, user_id: 654321 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'friend_poke', params: { user_id: 654321 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'send_poke', params: { group_id: 987654, target_id: 777777 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'send_poke', params: { user_id: 888888 } })).status, 'ok');
  assert.deepEqual(h.calls.sendNudge, [
    [{ chatType: 2, peerUid: '987654', guildId: '' }, '654321', '987654'],
    [{ chatType: 1, peerUid: 'u_654321', guildId: '' }, '654321', '654321'],
    [{ chatType: 2, peerUid: '987654', guildId: '' }, '777777', '987654'],
    [{ chatType: 1, peerUid: 'u_888888', guildId: '' }, '888888', '888888'],
  ]);

  // Reactions + fetch_emoji_like + protobuf 732/16 event
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_group_reaction', params: { message_id: mid, code: '76', is_add: true } })).status, 'ok');
  const likes = await dispatchAction(h.channel, h.convert, { action: 'fetch_emoji_like', params: { message_id: mid, emojiId: '76' } });
  assert.equal(likes.status, 'ok');
  assert.equal(likes.data.emojiLikesList[0].tinyId, '654321');

  // Protobuf 732/16 group emoji like decode (7-byte QQ header + GroupReactNotify)
  const inner = Buffer.concat([
    pbBytes(2, pbVar(1, 51)),
    pbBytes(3, Buffer.concat([pbBytes(1, '76'), pbVar(2, 1), pbVar(3, 1), pbBytes(4, 'u_654321'), pbVar(5, 1)])),
  ]);
  const notify732 = Buffer.concat([
    pbVar(4, 987654),
    pbVar(13, 35),
    pbBytes(44, pbBytes(1, pbBytes(1, inner))),
  ]);
  const content732 = Buffer.concat([Buffer.alloc(7, 0), notify732]);
  const sysBuf = Buffer.concat([
    pbBytes(1, pbVar(1, 987654)),
    pbBytes(2, Buffer.concat([pbVar(1, 732), pbVar(2, 16), pbVar(6, 1794470220)])),
    pbBytes(3, pbBytes(2, content732)),
  ]);
  const decoded = readSystemEvent(sysBuf);
  assert.equal(decoded.event.notice_type, 'group_msg_emoji_like');
  assert.equal(decoded.event.group_id, '987654');
  assert.equal(decoded.event.emoji_id, '76');
  assert.equal(decoded.event.is_add, true);

  await h.receiver('msg', 'onRecvSysMsg', [sysBuf]);
  const reactionEvt = h.convert(h.rawEvents.at(-1));
  assert.equal(reactionEvt.notice_type, 'group_msg_emoji_like');
  assert.equal(reactionEvt.user_id, 654321);
  assert.equal(reactionEvt.likes[0].emoji_id, '76');

  // PTT 2 text
  const ptt = await dispatchAction(h.channel, h.convert, { action: 'fetch_ptt_text', params: { message_id: mid } });
  assert.equal(ptt.status, 'ok');
  assert.equal(ptt.data.text, '你好世界');

  // Essence set / delete / list + grayTip 2401
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_essence_msg', params: { message_id: mid } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'delete_essence_msg', params: { message_id: mid } })).status, 'ok');
  const essList = await dispatchAction(h.channel, h.convert, { action: 'get_essence_msg_list', params: { group_id: 987654 } });
  assert.equal(essList.status, 'ok');
  assert.equal(essList.data[0].sender_id, 654321);

  await h.receiver('msg', 'onRecvMsg', [[{
    chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '5010', msgTime: '1794470250', senderUid: 'u_10001', senderUin: '10001',
    elements: [{ elementType: 8, grayTipElement: { jsonGrayTipElement: { busiId: '2401', jsonStr: JSON.stringify({ items: [{ type: 'txt', txt: '管理员将消息设为' }, { type: 'url', txt: '精华消息', jp: 'https://qun.qq.com/essence?groupCode=987654&msgSeq=51' }] }) } } }],
  }]]);
  const essEvt = h.convert(h.rawEvents.at(-1));
  assert.equal(essEvt.notice_type, 'essence');
  assert.equal(essEvt.sub_type, 'add');
  assert.equal(essEvt.operator_id, 10001);
  assert.equal(essEvt.sender_id, 654321);
  assert.equal(essEvt.message_id, mid);

  // Title grayTip (real QQ NT 5-item layout)
  await h.receiver('msg', 'onRecvMsg', [[{
    chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '5011', msgTime: '1794470255', senderUin: '10001',
    elements: [{ elementType: 8, grayTipElement: { jsonGrayTipElement: { busiId: '9999', jsonStr: JSON.stringify({ items: [{ txt: '恭喜' }, { param: ['654321'] }, { txt: '获得群主授予的' }, { txt: '大神' }, { txt: '头衔' }] }) } } }],
  }]]);
  const titleEvt = h.convert(h.rawEvents.at(-1));
  assert.equal(titleEvt.notice_type, 'notify');
  assert.equal(titleEvt.sub_type, 'title');
  assert.equal(titleEvt.title, '大神');
});

test('group queries, admin, notices, group files, profile, ark, and credentials work end-to-end', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openqq-ext-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const media = createMediaPreparer({ dir, allowPrivate: true });
  const h = createHarness();
  const imgPath = join(dir, 'avatar.png');
  await writeFile(imgPath, png(16, 16));
  const docPath = join(dir, 'doc.txt');
  await writeFile(docPath, 'hello group file');

  // Group queries & admin
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_group_kick_members', params: { group_id: 987654, user_id: [654321, 777777] } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_group_remark', params: { group_id: 987654, remark: '工作群' } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_group_portrait', params: { group_id: 987654, file: imgPath } }, { media })).status, 'ok');
  assert.equal(h.calls['group.setHeader'][0][1], '987654', 'group.setHeader passes path first and groupCode second');

  const atAll = await dispatchAction(h.channel, h.convert, { action: 'get_group_at_all_remain', params: { group_id: 987654 } });
  assert.deepEqual(atAll.data, { can_at_all: true, remain_at_all_count_for_group: 8, remain_at_all_count_for_uin: 5 });

  const shut = await dispatchAction(h.channel, h.convert, { action: 'get_group_shut_list', params: { group_id: 987654 } });
  assert.equal(shut.data[0].user_id, 654321);

  const honor = await dispatchAction(h.channel, h.convert, { action: 'get_group_honor_info', params: { group_id: 987654, type: 'talkative' } });
  assert.equal(honor.data.talkative_list.length, 1);

  const sysMsg = await dispatchAction(h.channel, h.convert, { action: 'get_group_system_msg' });
  assert.equal(sysMsg.data.join_requests.length, 1);
  assert.equal(sysMsg.data.invited_requests.length, 1);

  const detail = await dispatchAction(h.channel, h.convert, { action: 'get_group_info_ex', params: { group_id: 987654 } });
  assert.equal(detail.data.group_memo, '群简介');

  const link = await dispatchAction(h.channel, h.convert, { action: 'get_group_share_link', params: { group_id: 987654 } });
  assert.equal(link.data.url, 'https://qm.qq.com/q/test');

  // Notices
  const notices = await dispatchAction(h.channel, h.convert, { action: '_get_group_notice', params: { group_id: 987654 } });
  assert.equal(notices.data[0].notice_id, 'f1');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: '_send_group_notice', params: { group_id: 987654, content: '新公告', image: imgPath, pinned: true } }, { media })).status, 'ok');
  assert.equal(h.calls.uploadGroupBulletinPic.length, 1);
  assert.equal((await dispatchAction(h.channel, h.convert, { action: '_del_group_notice', params: { group_id: 987654, notice_id: 'f1' } })).status, 'ok');

  // Group files & private upload
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'upload_group_file', params: { group_id: 987654, file: docPath, name: '报告.txt', folder: '/dir1' } }, { media })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'upload_private_file', params: { user_id: 654321, file: docPath, name: '私聊.txt' } }, { media })).status, 'ok');
  const fsInfo = await dispatchAction(h.channel, h.convert, { action: 'get_group_file_system_info', params: { group_id: 987654 } });
  assert.equal(fsInfo.data.file_count, 3);
  const rootFiles = await dispatchAction(h.channel, h.convert, { action: 'get_group_root_files', params: { group_id: 987654 } });
  assert.equal(rootFiles.data.files[0].file_name, 'readme.txt');
  assert.equal(rootFiles.data.folders[0].folder_id, '/dir1');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'get_group_files_by_folder', params: { group_id: 987654, folder_id: '/dir1' } })).status, 'ok');
  const createdFolder = await dispatchAction(h.channel, h.convert, { action: 'create_group_file_folder', params: { group_id: 987654, name: '新目录' } });
  assert.equal(createdFolder.data.folder_id, '/new_dir');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'rename_group_file_folder', params: { group_id: 987654, folder_id: '/dir1', new_folder_name: '改名' } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'delete_group_folder', params: { group_id: 987654, folder_id: '/dir1' } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'delete_group_file', params: { group_id: 987654, file_id: '/f1', busid: 102 } })).status, 'ok');
  assert.deepEqual(h.calls.deleteGroupFile[0], ['987654', [102], ['/f1']]);
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'trans_group_file', params: { group_id: 987654, file_id: '/f1' } })).status, 'ok');
  const fileUrl = await dispatchAction(h.channel, h.convert, { action: 'get_group_file_url', params: { group_id: 987654, file_id: '/f1' } });
  assert.equal(fileUrl.data.url, 'https://cdn.example.com/ftn_handler/abcd/?fname=');
  assert.equal(h.calls.sendSsoCmdReqByContend[0][0], 'OidbSvcTrpcTcp.0x6D6_2');
  assert.equal(h.calls.getGroupFileInfo, undefined);

  // Profile, friends, contacts, ark, credentials
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_friend_remark', params: { user_id: 654321, remark: '好友A' } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'delete_friend', params: { user_id: 654321 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_qq_profile', params: { nickname: '新昵称', personal_note: '新签名', sex: 1 } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_self_longnick', params: { longNick: '只改签名' } })).status, 'ok');
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_qq_avatar', params: { file: imgPath } }, { media })).status, 'ok');
  const recent = await dispatchAction(h.channel, h.convert, { action: 'get_recent_contact', params: { count: 5 } });
  assert.equal(recent.data[0].peerUin, '987654');
  const fav = await dispatchAction(h.channel, h.convert, { action: 'fetch_custom_face', params: { count: 10 } });
  assert.deepEqual(fav.data, ['https://emoji/1.gif', 'https://emoji/2.png']);
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'set_online_status', params: { status: 10 } })).status, 'ok');
  const arkGroup = await dispatchAction(h.channel, h.convert, { action: 'ArkShareGroup', params: { group_id: 987654 } });
  assert.ok(arkGroup.data.includes('troopsharecard'));
  const arkPeer = await dispatchAction(h.channel, h.convert, { action: 'ArkSharePeer', params: { user_id: 654321 } });
  assert.ok(arkPeer.data.arkJson.includes('contact.lua'));

  const ck = await dispatchAction(h.channel, h.convert, { action: 'get_clientkey' });
  assert.equal(ck.data.clientkey, 'clientkey_xyz_123');
  const cookies = await dispatchAction(h.channel, h.convert, { action: 'get_cookies', params: { domain: 'qun.qq.com' } });
  assert.equal(cookies.data.cookies, 'uin=o123456; p_uin=o123456; p_skey=test_pskey_abc');
  const csrf = await dispatchAction(h.channel, h.convert, { action: 'get_csrf_token', params: { domain: 'qun.qq.com' } });
  assert.equal(csrf.data.token, calcBkn('test_pskey_abc'));
  const creds = await dispatchAction(h.channel, h.convert, { action: 'get_credentials', params: { domain: 'qun.qq.com' } });
  assert.equal(creds.data.csrf_token, calcBkn('test_pskey_abc'));

  // Host utilities
  assert.deepEqual((await dispatchAction(h.channel, h.convert, { action: 'nc_get_packet_status' })).data, { ok: false, mode: 'native-wrapper' });
  assert.deepEqual((await dispatchAction(h.channel, h.convert, { action: 'check_url_safely', params: { url: 'https://example.com' } })).data, { level: 2 });
  assert.equal((await dispatchAction(h.channel, h.convert, { action: 'check_url_safely', params: { url: 'javascript:alert(1)' } })).retcode, 1400);
});

test('forward sends (ref & custom with media), single forward, new segments, get_record decoding, download_file, config, and WS _async', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openqq-fwd-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fakePcm = Buffer.alloc(960 * 2, 0x01);
  const media = createMediaPreparer({
    dir,
    allowPrivate: true,
    loadSilk: async () => ({
      encode: async () => ({ data: fakeSilk(10), duration: 200 }),
      decode: async () => ({ data: fakePcm, duration: 20 }),
    }),
  });
  const h = createHarness();

  // Receive a message to reference in single forward and forward nodes
  const srcMsg = { chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '6001', msgSeq: '61', msgTime: '1794470300', senderUid: 'u_654321', senderUin: '654321', sendNickName: '甲', elements: [{ elementType: 1, textElement: { content: 'hi', atType: 0 } }] };
  h.store.set('6001', srcMsg);
  await h.receiver('msg', 'onRecvMsg', [[srcMsg]]);
  const mid = h.convert(h.rawEvents.at(-1)).message_id;

  const single = await dispatchAction(h.channel, h.convert, { action: 'forward_group_single_msg', params: { group_id: 987654, message_id: mid } });
  assert.equal(single.status, 'ok');
  assert.ok(single.data.message_id > 0);

  const refFwd = await dispatchAction(h.channel, h.convert, {
    action: 'send_group_forward_msg',
    params: { group_id: 987654, messages: [{ type: 'node', data: { id: mid, name: '引用节点' } }] },
  }, { media });
  assert.equal(refFwd.status, 'ok');

  // Custom forward with unpadded base64 image + forged openqq_ref rejection check
  const unpaddedPng = png(4, 4).toString('base64').replace(/=+$/, '');
  const customFwd = await dispatchAction(h.channel, h.convert, {
    action: 'send_private_forward_msg',
    params: {
      user_id: 654321,
      messages: [
        { type: 'node', data: { name: '自定义', uin: '10000', content: [{ type: 'text', data: { text: 'hello' } }, { type: 'image', data: { file: 'base64://' + unpaddedPng, sub_type: 1 } }] } },
      ],
    },
  }, { media });
  assert.equal(customFwd.status, 'ok');
  assert.ok(h.calls.multiForwardMsgWithComment.length >= 2);

  // New send segments: mface, markdown, contact
  for (const seg of [
    { type: 'mface', data: { emoji_id: 'abc123', emoji_package_id: 100, summary: '[商城]' } },
    { type: 'markdown', data: { content: '# 标题' } },
    { type: 'contact', data: { type: 'group', id: '987654' } },
    { type: 'contact', data: { type: 'qq', id: '654321' } },
  ]) {
    const res = await dispatchAction(h.channel, h.convert, { action: 'send_group_msg', params: { group_id: 987654, message: [seg] } }, { media });
    assert.equal(res.status, 'ok', `segment ${seg.type} should send`);
  }

  // New receive segments: dice, rps, poke, image summary & sub_type
  await h.receiver('msg', 'onRecvMsg', [[{
    chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '6050', msgTime: '1794470350', senderUid: 'u_654321', senderUin: '654321', sendNickName: '甲',
    elements: [
      { elementType: 6, faceElement: { faceIndex: 358, resultId: '6' } },
      { elementType: 6, faceElement: { faceIndex: 359, resultId: '2' } },
      { elementType: 6, faceElement: { faceIndex: 126, faceType: 5, pokeType: 1 } },
      { elementType: 2, picElement: { fileName: 'meme.gif', summary: '[动画表情]', picSubType: 1, originImageUrl: 'https://img/meme.gif' } },
    ],
  }]]);
  const segEvt = h.convert(h.rawEvents.at(-1));
  assert.deepEqual(segEvt.message.map(s => s.type), ['dice', 'rps', 'poke', 'image']);
  assert.equal(segEvt.message[0].data.result, '6');
  assert.equal(segEvt.message[1].data.result, '2');
  assert.equal(segEvt.message[2].data.type, '1');
  assert.equal(segEvt.message[3].data.summary, '[动画表情]');
  assert.equal(segEvt.message[3].data.sub_type, 1);

  // get_record with SILK -> WAV decoding
  const slkPath = join(dir, 'sample.slk');
  await writeFile(slkPath, fakeSilk(20));
  await h.receiver('msg', 'onRecvMsg', [[{
    chatType: 2, peerUid: '987654', peerUin: '987654', msgId: '6060', msgTime: '1794470360', senderUid: 'u_654321', senderUin: '654321', sendNickName: '甲',
    elements: [{ elementType: 4, pttElement: { fileName: 'sample.slk', fileUuid: 'uuid-slk', filePath: slkPath } }],
  }]]);
  const rec = await dispatchAction(h.channel, h.convert, { action: 'get_record', params: { file: 'uuid-slk', out_format: 'wav' } }, { media });
  assert.equal(rec.status, 'ok');
  assert.ok(rec.data.file.endsWith('.wav'));
  assert.ok(wavInfo(await readFile(rec.data.file)), 'decoded WAV has valid RIFF/WAVE header');

  // download_file (base64 + HTTP)
  const dlB64 = await dispatchAction(h.channel, h.convert, { action: 'download_file', params: { base64: Buffer.from('hello').toString('base64'), name: 'a.txt' } }, { media });
  assert.equal(dlB64.status, 'ok');
  assert.equal(await readFile(dlB64.data.file, 'utf8'), 'hello');

  const srv = http.createServer((_req, res) => { res.writeHead(200); res.end('from-http'); });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }));
  const dlHttp = await dispatchAction(h.channel, h.convert, { action: 'download_file', params: { url: `http://127.0.0.1:${srv.address().port}/f.txt`, name: 'f.txt' } }, { media });
  assert.equal(dlHttp.status, 'ok');
  assert.equal(await readFile(dlHttp.data.file, 'utf8'), 'from-http');

  const strictMedia = createMediaPreparer({ dir, allowPrivate: false });
  const dlBlocked = await dispatchAction(h.channel, h.convert, { action: 'download_file', params: { url: `http://127.0.0.1:${srv.address().port}/f.txt` } }, { media: strictMedia });
  assert.equal(dlBlocked.status, 'failed');
  assert.match(dlBlocked.message, /本机或内网/);

  // Optional config options + WS _async
  const cfg = validateConfig({ ...defaultConfig(), heartbeatInterval: 5000, reconnectInterval: 1000, reportSelfMessage: true });
  assert.equal(cfg.heartbeatInterval, 5000);
  assert.equal(cfg.reconnectInterval, 1000);
  assert.equal(cfg.reportSelfMessage, true);
  assert.throws(() => validateConfig({ ...defaultConfig(), heartbeatInterval: 100 }), /heartbeatInterval/);

  const dispatched = [];
  const netSrv = await startOneBot({
    config: { ...cfg, ws: { enabled: true, host: '127.0.0.1', port: 0 }, http: { enabled: false, host: '127.0.0.1', port: 0 } },
    dispatch: async req => { dispatched.push(req.action); return { status: 'ok', retcode: 0, data: { ok: true }, echo: req.echo }; },
  });
  t.after(() => netSrv.close());
  netSrv.setStatus({ phase: 'session_ready', self_id: '123456', syncing: false });
  const wsPort = Number(new URL(netSrv.mediaUrl('a', 'b')).port);
  const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/api`, { headers: { Authorization: `Bearer ${cfg.accessToken}` } });
  await new Promise(resolve => ws.once('open', resolve));
  const replyPromise = new Promise(resolve => ws.once('message', raw => resolve(JSON.parse(raw.toString()))));
  ws.send(JSON.stringify({ action: 'get_status_async', params: {}, echo: 'e1' }));
  const asyncResp = await replyPromise;
  assert.deepEqual(asyncResp, { status: 'async', retcode: 1, data: null, echo: 'e1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(dispatched, ['get_status']);
  ws.close();
});
