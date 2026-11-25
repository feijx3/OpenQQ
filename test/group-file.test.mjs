import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { COMMAND, buildRequest, parseResponse, getGroupFileUrl } = require('../native/group-file.cjs');
const { run } = require('../native/extended.cjs');
const field = (n, value) => { const data = Buffer.from(value); return Buffer.concat([Buffer.from([n * 8 + 2, data.length]), data]); };
const reply = (download, outer = []) => Buffer.concat([Buffer.from(outer), field(4, field(3, download))]);
const download = Buffer.concat([Buffer.from([8, 0]), field(5, 'cdn.example.com'), field(6, Buffer.from([0xab, 0xcd]))]);
const good = reply(download);
const action = { kind: 'get_group_file_url', group: '123', fileId: '/f1', busid: 102 };
const ensure = () => {};
test('download request uses group, appId, busid and raw file UUID in OIDB 0x6D6/2', () => {
  assert.equal(buildRequest('123', '/f1', 102).toString('hex'), '08d60d1002220d1a0b087b1007186622032f66316001');
  assert.ok(buildRequest('123', '/f1', 103).includes(Buffer.from([24, 103])));
  assert.throws(() => buildRequest('4294967296', '/f1', 102), /uint32/);
});
test('download response converts binary key into URL and accepts signed native bytes', () => {
  assert.equal(parseResponse(good), 'https://cdn.example.com/ftn_handler/abcd/?fname=');
  assert.equal(parseResponse(Array.from(good, b => b > 127 ? b - 256 : b)), parseResponse(good));
});
test('download response rejects server errors, missing fields and truncated protobuf', () => {
  assert.throws(() => parseResponse(reply(download, [24, 7])), /OIDB 拒绝/);
  assert.throws(() => parseResponse(reply(Buffer.from([8, 5]))), /QQ 拒绝下载/);
  assert.throws(() => parseResponse(reply(field(5, 'cdn.example.com'))), /downloadDns/);
  assert.throws(() => parseResponse(Buffer.from([34, 100, 1])), /长度/);
  assert.throws(() => parseResponse(reply(Buffer.concat([field(5, 'evil/path'), field(6, 'x')]))), /downloadDns/);
});
test('action calls native send API with receiver intact and never queries metadata', async () => {
  const service = { async sendSsoCmdReqByContend(command, request) {
    assert.equal(this, service); assert.equal(command, COMMAND);
    assert.deepEqual(request, buildRequest('123', '/f1', 102)); return { rspbuffer: good };
  } };
  const session = { getMsgService: () => service, getRichMediaService() { throw Error('metadata should not be queried'); } };
  assert.deepEqual(await run(action, { session, ensure }), { url: parseResponse(good) });
});
test('native API errors and missing API produce specific failures', async () => {
  await assert.rejects(getGroupFileUrl({}, action, ensure), /不支持.*sendSso/);
  await assert.rejects(getGroupFileUrl({ getMsgService: () => ({ sendSsoCmdReqByContend() { throw Error('native error'); } }) }, action, ensure), /native error/);
});
test('stalled native call has download-specific timeout', async () => {
  await assert.rejects(getGroupFileUrl({ getMsgService: () => ({ sendSsoCmdReqByContend: () => new Promise(() => {}) }) }, action, ensure, 10),
    e => e.retcode === 1501 && e.message.includes('0x6D6/2'));
});
test('cached URL avoids native request', async () => {
  assert.deepEqual(await run(action, { session: {}, ensure, lookupMedia: () => ({ url: 'https://cdn.example.com/cached' }) }), { url: 'https://cdn.example.com/cached' });
});

test('missing packet response reports shape without leaking returned content', async () => {
  const session = { getMsgService: () => ({ sendSsoCmdReqByContend: async () => ({ result: 0, errMsg: 'ok', rspbuffer: undefined }) }) };
  await assert.rejects(getGroupFileUrl(session, action, ensure), e => e.message.includes('rspbuffer:undefined') && e.message.includes('未提供二进制响应') && e.message.includes('result=0'));
});
test('missing nested body identifies parsing stage', () => {
  assert.throws(() => parseResponse(Buffer.from([8, 0xd6, 0x0d, 16, 2])), /OIDB body.*外层字段=1,2/);
});

test('native failure is reported before attempting protobuf decoding', async () => {
  const session = { getMsgService: () => ({ sendSsoCmdReqByContend: async () => ({ result: -1, errMsg: 'not impl', rsp: '' }) }) };
  await assert.rejects(getGroupFileUrl(session, action, ensure), e => e.retcode === 1500 && e.message.includes('result=-1') && e.message.includes('not impl') && !e.message.includes('protobuf'));
});

test('own bridge binary rsp response is accepted', async () => {
  const session = { getMsgService: () => ({ sendSsoCmdReqByContend: async () => ({ result: 0, errMsg: '', rsp: good }) }) };
  assert.equal(await getGroupFileUrl(session, action, ensure), parseResponse(good));
});
