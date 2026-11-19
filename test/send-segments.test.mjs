import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import nativeActions from '../native/actions.cjs';
import cq from '../native/cq.cjs';
import { createEventConverter } from '../src/onebot.mjs';
import { createMediaPreparer } from '../src/media.mjs';
import { dispatchAction } from '../src/actions.mjs';
import { startNativeFixture } from './native-support.mjs';

const self = { uin: '123456', uid: 'u_self' };
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

async function fixture(t, { memberInfos = new Map() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openqq-send-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let serial = 9007199254740993n;
  const sends = [];
  const requested = [];
  const service = {
    generateMsgUniqueId() { return String(serial++); },
    async sendMsg(id, peer, elements) { sends.push({ id, peer, elements }); return { result: 0 }; },
    getRichMediaFilePathForGuild(request) {
      requested.push(request);
      return join(root, 'QQ', 'nt_data', request.elementType === 5 ? 'Video' : 'Pic', '2026-11', 'Ori', request.md5HexStr + extname(request.fileName));
    },
  };
  const session = {
    getMsgService: () => service,
    getMSFService: () => ({ getServerTime: () => '1794470400' }),
    getUixConvertService: () => ({ getUid: async uins => ({ uidInfo: new Map(uins.map(uin => [uin, 'u_' + uin])) }) }),
    getGroupService: () => ({
      getUidByUins: async uins => ({ uids: new Map(uins.map(uin => [uin, 'u_' + uin])) }),
      getMemberInfo: async () => ({ result: { infos: memberInfos } }),
    }),
  };
  const handler = nativeActions.createActionHandler(session, self, () => true);
  t.after(() => handler.dispose());
  const put = async (name, bytes) => { const path = join(root, name); await writeFile(path, bytes); return path; };
  // Starts an action, waits for QQ to be handed the message, then reports a successful send.
  const run = async request => {
    const before = sends.length;
    const pending = handler.execute(request);
    // Staging a file is real disk I/O, so wait on the clock rather than on a fixed number of ticks.
    for (let i = 0; i < 400 && sends.length === before; i++) await delay(5);
    assert.equal(sends.length, before + 1, 'the message reached QQ');
    const sent = sends[before];
    handler.observe('onMsgInfoListUpdate', [[{ ...sent.peer, msgId: '9007199254741999', senderUin: self.uin, sendStatus: 2 }]]);
    await pending;
    return sent;
  };
  return { root, sends, requested, handler, put, run };
}

const group = message => ({ action: 'send_group_msg', params: { group_id: '555000', message } });
const media = (kind, fields) => ({ kind, name: 'x', size: 1, ...fields });
const pngMedia = (path, extra = {}) => media('image', { path, name: 'pic.png', size: 6, format: 'png', width: 64, height: 32, ...extra });

test('CQ codes decode escapes, keep malformed codes as text and round-trip through escapeText', () => {
  assert.deepEqual(cq.parseCQ('hi [CQ:at,qq=123] &amp;&#91;x&#93; [CQ:image,file=a&#44;b.png,url=http://x/y?a=1&amp;b=2]!'), [
    { type: 'text', data: { text: 'hi ' } }, { type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' &[x] ' } },
    { type: 'image', data: { file: 'a,b.png', url: 'http://x/y?a=1&b=2' } }, { type: 'text', data: { text: '!' } }]);
  assert.deepEqual(cq.parseCQ('[CQ:at,qq=1'), [{ type: 'text', data: { text: '[CQ:at,qq=1' } }]);
  assert.deepEqual(cq.parseCQ('[CQ:dice]'), [{ type: 'dice', data: {} }]);
  assert.deepEqual(cq.parseCQ(''), []);
  const raw = 'a [b] & c, d';
  assert.deepEqual(cq.parseCQ(cq.escapeText(raw)), [{ type: 'text', data: { text: raw } }]);
  assert.throws(() => cq.parseCQ(5), TypeError);
});

test('string messages are parsed as CQ code unless auto_escape is set', () => {
  const converted = nativeActions.normalizeParams({ action: 'send_group_msg', params: { group_id: 1, message: 'a &amp; b [CQ:at,qq=all]' } });
  assert.deepEqual(converted.params.message, [{ type: 'text', data: { text: 'a & b ' } }, { type: 'at', data: { qq: 'all' } }]);
  const explicitFalse = nativeActions.normalizeParams({ action: 'send_group_msg', params: { group_id: 1, message: 'a [CQ:at,qq=all]', auto_escape: false } });
  assert.deepEqual(explicitFalse.params.message, [{ type: 'text', data: { text: 'a ' } }, { type: 'at', data: { qq: 'all' } }]);
  const literal = { action: 'send_group_msg', params: { group_id: 1, message: '[CQ:at,qq=all]', auto_escape: true } };
  assert.equal(nativeActions.normalizeParams(literal), literal);
  assert.deepEqual(nativeActions.validateAction(literal).texts, ['[CQ:at,qq=all]']);
  const nonBoolean = { action: 'send_group_msg', params: { group_id: 1, message: '[CQ:at,qq=all]', auto_escape: null } };
  assert.equal(nativeActions.normalizeParams(nonBoolean), nonBoolean);
  assert.throws(() => nativeActions.validateAction(nonBoolean), /auto_escape 必须为布尔值/);
  const array = { action: 'send_group_msg', params: { group_id: 1, message: [{ type: 'text', data: { text: 'x' } }] } };
  assert.equal(nativeActions.normalizeParams(array), array);
  assert.equal(nativeActions.normalizeParams({ action: 'get_status' }).action, 'get_status');
  // validation alone also understands CQ strings
  assert.equal(nativeActions.validateAction({ action: 'send_group_msg', params: { group_id: 1, message: 'x[CQ:face,id=14]' } }).parts[1].id, 14);
});

test('at, face, dice and rps become the right native elements', async t => {
  const f = await fixture(t, { memberInfos: new Map([['u_777', { cardName: '群名片', nick: '昵称' }], ['u_888', { cardName: '', nick: '只有昵称' }]]) });
  const sent = await f.run(group([
    { type: 'at', data: { qq: 'all' } }, { type: 'at', data: { qq: '777' } }, { type: 'at', data: { qq: '888' } }, { type: 'at', data: { qq: '999' } },
    { type: 'at', data: { qq: '555', name: '自定义' } }, { type: 'text', data: { text: ' hi ' } }, { type: 'face', data: { id: '14' } }, { type: 'face', data: { id: 260 } },
  ]));
  assert.equal(sent.peer.chatType, 2);
  assert.equal(sent.peer.peerUid, '555000');
  const [all, user, nick, unknown, named, text, small, large] = sent.elements;
  assert.deepEqual(all.textElement, { content: '@全体成员', atType: 1, atUid: '0', atTinyId: '', atNtUid: '' });
  assert.deepEqual(user.textElement, { content: '@群名片', atType: 2, atUid: '777', atTinyId: '', atNtUid: 'u_777' });
  assert.equal(nick.textElement.content, '@只有昵称');
  assert.equal(unknown.textElement.content, '@999', 'falls back to the number when QQ does not know a name');
  assert.equal(named.textElement.content, '@自定义');
  assert.equal(text.textElement.content, ' hi ');
  assert.deepEqual([small.faceElement.faceIndex, small.faceElement.faceType, large.faceElement.faceType], [14, 1, 2]);

  const dice = await f.run(group([{ type: 'dice', data: {} }]));
  const rps = await f.run(group([{ type: 'rps', data: {} }]));
  assert.deepEqual([dice.elements[0].faceElement.faceIndex, dice.elements[0].faceElement.stickerId, rps.elements[0].faceElement.faceIndex, rps.elements[0].faceElement.stickerId], [358, '33', 359, '34']);
});

test('at is refused in private chats and for invalid targets, and unsupported segments are named', async t => {
  const f = await fixture(t);
  const bad = [
    [{ action: 'send_private_msg', params: { user_id: 1, message: [{ type: 'at', data: { qq: '2' } }] } }, /私聊不能使用 at/],
    [group([{ type: 'at', data: { qq: 'u_x' } }]), /QQ 数值标识/], [group([{ type: 'at', data: { qq: '1', name: 'x'.repeat(65) } }]), /name 过长/],
    [group([{ type: 'face', data: { id: -1 } }]), /face/], [group([{ type: 'face', data: { id: 'x' } }]), /face/],
    [group([{ type: 'music', data: {} }]), /暂不支持 music/], [group([{ type: 'node', data: {} }]), /暂不支持 node/], [group([{ type: 'poke', data: {} }]), /暂不支持 poke/],
    [group([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: 'x' } }]), /reply 段的 id 无效/],
    [group([{ type: 'reply', data: { id: '1', openqq_ref: { chatType: 2, peerUid: '555000', msgId: '7' } } }]), /不能为空/],
  ];
  for (const [request, pattern] of bad) await assert.rejects(f.handler.execute(request), pattern);
  assert.equal(f.sends.length, 0);
});

test('an image is copied into QQ\'s media folder and described with its real MD5, size and dimensions', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('pretend these are png bytes');
  const path = await f.put('pic.png', bytes);
  const sent = await f.run(group([{ type: 'text', data: { text: 'look' } }, { type: 'image', data: { openqq_media: pngMedia(path, { size: bytes.length }), summary: '[图片]' } }]));
  assert.equal(sent.elements[0].textElement.content, 'look');
  const pic = sent.elements[1].picElement;
  assert.equal(sent.elements[1].elementType, 2);
  assert.deepEqual([pic.md5HexStr, pic.fileSize, pic.picWidth, pic.picHeight, pic.fileName, pic.picType, pic.original, pic.summary], [md5(bytes), bytes.length, 64, 32, 'pic.png', 1001, true, '[图片]']);
  assert.deepEqual(f.requested[0], { md5HexStr: md5(bytes), fileName: 'pic.png', elementType: 2, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: '' });
  assert.equal(pic.sourcePath, join(f.root, 'QQ', 'nt_data', 'Pic', '2026-11', 'Ori', md5(bytes) + '.png'));
  assert.deepEqual(await readFile(pic.sourcePath), bytes, 'the copy is byte-identical');
  assert.deepEqual(await readFile(path), bytes, 'the source stays');
  for (const [format, type] of [['jpeg', 1000], ['gif', 2000], ['webp', 1002], ['bmp', 1005]]) {
    const other = await f.run(group([{ type: 'image', data: { openqq_media: pngMedia(path, { format }) } }]));
    assert.equal(other.elements[0].picElement.picType, type, format);
  }
});

test('voice, file and video use QQ\'s own element shapes, and a video cover lands in the Thumb folder', async t => {
  const f = await fixture(t);
  const voiceBytes = Buffer.from('#!SILK_V3 voice');
  const voice = await f.run(group([{ type: 'record', data: { openqq_media: media('record', { path: await f.put('v.slk', voiceBytes), name: 'v.slk', size: voiceBytes.length, duration: 7 }) } }]));
  const ptt = voice.elements[0].pttElement;
  assert.equal(voice.elements[0].elementType, 4);
  assert.deepEqual([ptt.md5HexStr, ptt.fileSize, ptt.duration, ptt.formatType, ptt.voiceType, ptt.fileName, ptt.canConvert2Text], [md5(voiceBytes), String(voiceBytes.length), 7, 1, 0, md5(voiceBytes) + '.amr', false]);
  assert.equal(ptt.waveAmplitudes.length, 50);
  // QQ iterates the keys of this nested object while sending; a missing one is what broke voice in issue #7.
  assert.deepEqual(ptt.otherBusinessInfo, { aiVoiceInfo: null, aiVoiceType: 0 });
  assert.deepEqual([ptt.playState, ptt.storeID, ptt.text, ptt.fileId], [0, 1, '', 0]);
  assert.equal(f.requested[0].elementType, 4);

  const fileBytes = Buffer.from('zip data');
  const file = await f.run({ action: 'send_private_msg', params: { user_id: '654321', message: [{ type: 'file', data: { openqq_media: media('file', { path: await f.put('a.zip', fileBytes), name: '资料.zip', size: fileBytes.length }) } }] } });
  assert.equal(file.peer.chatType, 1);
  assert.deepEqual([file.elements[0].elementType, file.elements[0].fileElement.fileName, file.elements[0].fileElement.fileSize, file.elements[0].fileElement.fileMd5], [3, '资料.zip', String(fileBytes.length), md5(fileBytes)]);

  const videoBytes = Buffer.from('mp4 bytes');
  const thumbBytes = Buffer.from('jpeg cover');
  const video = await f.run(group([{ type: 'video', data: { openqq_media: media('video', { path: await f.put('c.mp4', videoBytes), name: 'c.mp4', size: videoBytes.length, format: 'mp4', width: 1280, height: 720, duration: 9,
    thumb: { path: await f.put('cover.jpg', thumbBytes), size: thumbBytes.length, format: 'jpeg', width: 320, height: 180 } }) } }]));
  const element = video.elements[0].videoElement;
  assert.equal(video.elements[0].elementType, 5);
  assert.deepEqual([element.videoMd5, element.fileTime, element.fileWidth, element.fileHeight, element.fileSize, element.fileFormat, element.thumbWidth, element.thumbHeight, element.thumbMd5],
    [md5(videoBytes), 9, 1280, 720, String(videoBytes.length), 2, 320, 180, md5(thumbBytes)]);
  const thumbPath = element.thumbPath.get(0);
  assert.equal(thumbPath, join(f.root, 'QQ', 'nt_data', 'Video', '2026-11', 'Thumb', md5(videoBytes) + '_0.png'));
  assert.deepEqual(await readFile(thumbPath), thumbBytes);
  assert.deepEqual(await readFile(element.filePath), videoBytes);
  assert.ok((await stat(element.filePath)).isFile());
});

test('media segments must come from the preparer, stand alone where QQ requires it, and get more time when large', async t => {
  const f = await fixture(t);
  const path = await f.put('pic.png', 'x');
  const ok = { type: 'image', data: { openqq_media: pngMedia(path) } };
  const bad = [
    [group([{ type: 'image', data: { file: 'a.png' } }]), /没有经过处理/],
    [group([{ type: 'image', data: { openqq_media: { ...pngMedia(path), path: '\\\\server\\share\\a.png' } } }]), /描述无效/],
    [group([{ type: 'image', data: { openqq_media: { ...pngMedia(path), path: 'relative.png' } } }]), /描述无效/],
    [group([{ type: 'image', data: { openqq_media: { ...pngMedia(path), format: 'tiff' } } }]), /描述无效/],
    [group([{ type: 'image', data: { openqq_media: { ...pngMedia(path), name: '../x.png' } } }]), /描述无效/],
    [group([{ type: 'image', data: { openqq_media: { ...pngMedia(path), width: 0 } } }]), /描述无效/],
    [group([{ type: 'image', data: { openqq_media: media('record', { path, duration: 3 }) } }]), /描述无效/],
    [group([{ type: 'record', data: { openqq_media: media('record', { path, duration: 0 }) } }]), /描述无效/],
    [group([{ type: 'video', data: { openqq_media: media('video', { path, format: 'mp4', width: 1, height: 1, duration: 1 }) } }]), /描述无效/],
    [group([{ type: 'text', data: { text: 'x' } }, { type: 'record', data: { openqq_media: media('record', { path, duration: 3 }) } }]), /record 段必须单独发送/],
    [group([ok, { type: 'file', data: { openqq_media: media('file', { path }) } }]), /file 段必须单独发送/],
    [group([{ type: 'json', data: { data: '{}' } }, ok]), /json 段必须单独发送/],
  ];
  for (const [request, pattern] of bad) assert.throws(() => nativeActions.validateAction(request), pattern);
  assert.equal(nativeActions.validateAction(group([ok, { type: 'text', data: { text: 'mixed is fine for images' } }])).parts.length, 2);
  assert.equal(nativeActions.validateAction(group('plain')).timeout, 15000);
  assert.equal(nativeActions.validateAction(group([{ type: 'image', data: { openqq_media: pngMedia(path, { size: 10 * 1024 * 1024 }) } }])).timeout, 15000 + 10 * 4000);
  assert.equal(nativeActions.validateAction(group([{ type: 'file', data: { openqq_media: media('file', { path, size: 5 * 1024 ** 3 }) } }])).timeout, 300000);
});

test('dispatchAction normalizes CQ strings, prepares media, lengthens the IPC wait and always releases temp files', async t => {
  const converter = createEventConverter();
  const quoted = converter.messageId(self, { chatType: 2, peerUid: '555000', msgId: '42' });
  const calls = [];
  const channel = { async request(request, timeout) { calls.push({ request, timeout }); return { status: 'ok', retcode: 0, data: { self, message: { chatType: 2, peerUid: '555000', msgId: '9007199254741999' } } }; } };
  let released = 0;
  const fakeMedia = { async prepare(params) {
    return { params: { ...params, message: params.message.map(segment => segment.type === 'image'
      ? { ...segment, data: { ...segment.data, openqq_media: pngMedia('C:\\temp\\a.png', { size: 3 * 1024 * 1024 }) } } : segment) }, release: async () => { released++; } };
  } };
  const response = await dispatchAction(channel, converter, { action: 'send_group_msg', params: { group_id: 555000, message: `[CQ:reply,id=${quoted}]hi[CQ:image,file=base64://AAAA]` }, echo: 'e1' }, { media: fakeMedia });
  assert.deepEqual([response.status, response.echo, typeof response.data.message_id], ['ok', 'e1', 'number']);
  assert.equal(released, 1);
  assert.equal(calls[0].timeout, 15000 + 3 * 4000 + 5000);
  const sent = calls[0].request.params.message;
  assert.deepEqual(sent.map(segment => segment.type), ['reply', 'text', 'image']);
  assert.deepEqual(sent[0].data.openqq_ref, { chatType: 2, peerUid: '555000', msgId: '42' });
  assert.equal(sent[2].data.openqq_media.kind, 'image');

  // a failure in preparation is reported as a failed action, and nothing is sent
  const failing = { async prepare() { throw Object.assign(new Error('文件超过 30 MiB 上限'), { retcode: 1400 }); } };
  const failed = await dispatchAction(channel, converter, group([{ type: 'image', data: { file: 'x' } }]), { media: failing });
  assert.deepEqual([failed.status, failed.retcode, failed.message], ['failed', 1400, '文件超过 30 MiB 上限']);
  assert.equal(calls.length, 1);

  // without a preparer, media segments cannot be sent
  const unprepared = await dispatchAction(channel, converter, group([{ type: 'image', data: { file: 'C:\\a.png' } }]));
  assert.equal(unprepared.retcode, 1400);
  assert.equal(calls.length, 1);

  // answered locally, without QQ
  const version = await dispatchAction(channel, converter, { action: 'get_version_info', echo: 7 }, { version: '1.2.3' });
  assert.deepEqual(version.data, { app_name: 'OpenQQ', app_version: '1.2.3', protocol_version: 'v11' });
  assert.deepEqual((await dispatchAction(channel, converter, { action: 'can_send_image' })).data, { yes: true });
  assert.deepEqual((await dispatchAction(channel, converter, { action: 'can_send_record' })).data, { yes: true });
  assert.equal(calls.length, 1);
});

test('dispatchAction sends >1 MiB base64:// payloads across media types, CQ strings and send actions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'openqq-ipc-media-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temp = join(root, 'temp');
  let serial = 9007199254742000n;
  const sends = [];
  const nativeFixture = await startNativeFixture(t, {
    service: {
      generateMsgUniqueId: () => String(serial++),
      getRichMediaFilePathForGuild(request) { return join(root, 'QQ', String(request.elementType), request.md5HexStr + extname(request.fileName)); },
      async sendMsg(_id, peer, elements) {
        sends.push({ peer, elements });
        const msgId = String(serial++);
        queueMicrotask(() => nativeFixture.getListener().onMsgInfoListUpdate([{ ...peer, senderUin: self.uin, sendStatus: 2, msgId }]));
        return { result: 0 };
      },
    },
    session: {
      getUixConvertService: () => ({ getUid: async uins => ({ uidInfo: new Map(uins.map(uin => [uin, 'u_' + uin])) }) }),
    },
  });

  const bigPng = (size = 800 * 1024) => {
    const b = Buffer.alloc(size);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(64, 16); b.writeUInt32BE(32, 20);
    b[24] = 8; b[25] = 6;
    return b;
  };
  const bigSilk = () => Buffer.concat([Buffer.from('#!SILK_V3'), ...Array.from({ length: 40000 }, () => Buffer.from([20, 0, ...Buffer.alloc(20)])), Buffer.from([0xff, 0xff])]);
  const box = (type, ...children) => {
    const body = Buffer.concat(children);
    const b = Buffer.alloc(8 + body.length);
    b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1'); body.copy(b, 8);
    return b;
  };
  const bigMp4 = () => {
    const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(1280 * 65536, 76); tkhd.writeUInt32BE(720 * 65536, 80);
    const hdlr = Buffer.alloc(24); hdlr.write('vide', 8, 'latin1');
    const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(5000, 16);
    return Buffer.concat([box('ftyp', Buffer.from('isom'), Buffer.alloc(8)), box('mdat', Buffer.alloc(800 * 1024)), box('moov', box('mvhd', mvhd), box('trak', box('tkhd', tkhd), box('mdia', box('hdlr', hdlr))))]);
  };

  const pngBytes = bigPng();
  const silkBytes = bigSilk();
  const mp4Bytes = bigMp4();
  const thumbBytes = bigPng();
  const fileBytes = Buffer.alloc(800 * 1024, 0x41);
  const b64 = buf => {
    const encoded = buf.toString('base64');
    assert.ok(Buffer.byteLength(encoded) > 1024 * 1024);
    return 'base64://' + encoded;
  };

  const cases = [
    {
      name: 'image array via send_group_msg',
      request: group([{ type: 'image', data: { file: b64(pngBytes), summary: '[大图]', extra: 'x'.repeat(100) } }]),
      verify: sent => { assert.equal(sent.peer.chatType, 2); assert.equal(sent.elements[0].picElement.fileSize, pngBytes.length); assert.equal(sent.elements[0].picElement.summary, '[大图]'); },
    },
    {
      name: 'image CQ string via send_group_msg',
      request: group(`[CQ:image,file=${b64(pngBytes)},summary=&#91;CQ&#93;]`),
      verify: sent => { assert.equal(sent.peer.chatType, 2); assert.equal(sent.elements[0].picElement.fileSize, pngBytes.length); assert.equal(sent.elements[0].picElement.summary, '[CQ]'); },
    },
    {
      name: 'image CQ string with auto_escape: false via send_group_msg',
      request: { action: 'send_group_msg', params: { group_id: '555000', message: `[CQ:image,file=${b64(pngBytes)}]`, auto_escape: false } },
      verify: sent => { assert.equal(sent.peer.chatType, 2); assert.equal(sent.elements[0].picElement.fileSize, pngBytes.length); },
    },
    {
      name: 'record via send_private_msg',
      request: { action: 'send_private_msg', params: { user_id: '654321', message: [{ type: 'record', data: { file: b64(silkBytes) } }] } },
      verify: sent => { assert.equal(sent.peer.chatType, 1); assert.equal(sent.elements[0].pttElement.fileSize, String(silkBytes.length)); },
    },
    {
      name: 'video + thumb via send_msg (group)',
      request: { action: 'send_msg', params: { group_id: '555000', message: [{ type: 'video', data: { file: b64(mp4Bytes), thumb: b64(thumbBytes), name: 'clip.mp4' } }] } },
      verify: sent => { assert.equal(sent.peer.chatType, 2); assert.equal(sent.elements[0].videoElement.fileSize, String(mp4Bytes.length)); assert.equal(sent.elements[0].videoElement.thumbSize, thumbBytes.length); },
    },
    {
      name: 'file via send_msg (private)',
      request: { action: 'send_msg', params: { user_id: '654321', message: [{ type: 'file', data: { file: b64(fileBytes), name: 'report.bin' } }] } },
      verify: sent => { assert.equal(sent.peer.chatType, 1); assert.equal(sent.elements[0].fileElement.fileName, 'report.bin'); assert.equal(sent.elements[0].fileElement.fileSize, String(fileBytes.length)); },
    },
  ];

  const converter = createEventConverter();
  const preparer = createMediaPreparer({ dir: temp });
  for (const item of cases) {
    const before = sends.length;
    const response = await dispatchAction(nativeFixture.channel, converter, item.request, { media: preparer });
    assert.equal(response.status, 'ok', item.name);
    assert.equal(sends.length, before + 1, item.name);
    item.verify(sends[before]);
    assert.deepEqual(await readdir(temp), [], item.name + ' releases temporary files');
  }
});
