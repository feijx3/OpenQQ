import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const nativeDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'native');
const pb = require(join(nativeDir, 'pb-mini.cjs'));
const oidb = require(join(nativeDir, 'oidb-actions.cjs'));
const actions = require(join(nativeDir, 'actions.cjs'));

test('protobuf varints cover the boundaries and stay exact above 2^53', () => {
  assert.equal(pb.varint(0).toString('hex'), '00');
  assert.equal(pb.varint(1).toString('hex'), '01');
  assert.equal(pb.varint(127).toString('hex'), '7f');
  assert.equal(pb.varint(128).toString('hex'), '8001');
  assert.equal(pb.varint(300).toString('hex'), 'ac02');
  // 群号、msgId 这个量级必须精确：Number 在 2^53 以上会丢精度，所以字符串/BigInt 是唯一安全输入。
  assert.equal(pb.varint('9007199254740993').toString('hex'), '8180808080808010');
  assert.equal(pb.varint(9007199254740993n).toString('hex'), '8180808080808010');
  // 负数按 uint64 补码编码，而不是悄悄写 0。
  assert.equal(pb.varint(-1).toString('hex'), 'ffffffffffffffffff01');
});

test('protobuf encoder rejects invalid integers instead of writing zero', () => {
  for (const bad of [NaN, Infinity, 1.5, undefined, null, {}, [], 'abc', '']) {
    assert.throws(() => pb.varint(bad), TypeError, `应当拒绝 ${String(bad)}`);
  }
  assert.throws(() => pb.varint(Number.MAX_SAFE_INTEGER + 2), /安全整数/);
  assert.throws(() => pb.tag(-1, 0), RangeError);
  assert.throws(() => pb.tag(1, 9), RangeError);
});

test('field encoders produce the documented tags', () => {
  assert.equal(pb.tag(1, 2).toString('hex'), '0a');
  assert.equal(pb.tag(1, 0).toString('hex'), '08');
  assert.equal(pb.vint(2, 1).toString('hex'), '1001');
  assert.equal(pb.bytes(4, Buffer.from([1, 2])).toString('hex'), '22020102');
  assert.equal(pb.str(1, 'ab').toString('hex'), '0a026162');
});

test('encodeBySchema skips proto3 defaults and wraps nested messages', () => {
  const schema = {
    1: { name: 'groupUin', kind: 'varint' },
    2: { name: 'settings', kind: 'message', fields: { 1: { name: 'allow', kind: 'varint' } } },
    3: { name: 'name', kind: 'string' },
  };
  const encoded = oidb.encodeBySchema(schema, { groupUin: 1234, settings: { allow: 1 }, name: 'x' });
  assert.equal(encoded.toString('hex'), '08d209120208011a0178');
  // 0 / '' 不编码（proto3 默认值），和空对象一致。
  assert.equal(oidb.encodeBySchema(schema, { groupUin: 0, settings: {}, name: '' }).length, 0);
  // __raw 逃生口原样返回。
  const raw = Buffer.from([9, 9]);
  assert.equal(oidb.encodeBySchema(schema, { __raw: raw }), raw);
});

test('keepZero writes an explicit zero so a setting can be turned off', () => {
  // 标了 keepZero 的字段，0 是有效值（"关闭"），必须进 wire。
  const scalar = { 1: { name: 'state', kind: 'varint', keepZero: true } };
  assert.equal(oidb.encodeBySchema(scalar, { state: 0 }).toString('hex'), '0800');
  // 没标的仍然按 proto3 省略 —— 两条行为要能区分开，否则这个开关没有意义。
  assert.equal(oidb.encodeBySchema({ 1: { name: 'state', kind: 'varint' } }, { state: 0 }).length, 0);
  // 内层全被省略时，外层 message 也要因为 keepZero 而写出去。
  const nested = {
    1: { name: 'inner', kind: 'message', keepZero: true, fields: { 1: { name: 'v', kind: 'varint', keepZero: true } } },
  };
  assert.equal(oidb.encodeBySchema(nested, { inner: { v: 0 } }).toString('hex'), '0a020800');
});

test('turning a group setting off still sends the field', () => {
  // 「群被永久禁言、怎么关都关不掉」就是这条退化：state:0 被当成默认值省略，
  // 外层 message 又因内层为空整块跳过，body 只剩群号。
  const muteOff = oidb.buildOidbBody('set_group_whole_mute', { group_id: 1041147387, enable: false });
  assert.match(muteOff.toString('hex'), /12020800$/, '关闭禁言必须带上 state:0');
  const history = oidb.buildOidbBody('set_group_new_member_history_visibility', { group_id: 1041147387, visible: false });
  assert.match(history.toString('hex'), /1204/, '历史可见性要带 settings 块');
  // 打开时本来就是 1，不该被 keepZero 影响。
  const muteOn = oidb.buildOidbBody('set_group_whole_mute', { group_id: 1041147387, enable: true });
  assert.match(muteOn.toString('hex'), /12020801$/);
});

test('wrapOidbBase emits command/subCommand/errorCode/body and only adds reserved when asked', () => {
  const body = Buffer.from([0x08, 0x00]);
  assert.equal(oidb.wrapOidbBase(3795, 1, body).toString('hex'), '08d31d1001180022020800');
  assert.equal(oidb.wrapOidbBase(3795, 1, body, 1).toString('hex'), '08d31d10011800220208003801');
});

test('buildOidbPoke keeps the verified group shape', () => {
  assert.equal(
    pb.buildOidbPoke({ groupId: 1041147387, userId: 2975434328 }).toString('hex'),
    '08d31d10011800221008d88ce68a0b10fbcbbaf00328003000'
  );
});

test('whole-group setting rewrites stay un-sent until confirmed', () => {
  const dry = actions.validateAction({ action: 'set_group_whole_mute', params: { group_id: 1041147387, enable: false } });
  assert.equal(dry.kind, 'oidb_dryrun');
  assert.ok(dry.bodyLen > 0, 'dryrun 仍要给出将要发送的字节');
  const armed = actions.validateAction({ action: 'set_group_whole_mute', params: { group_id: 1041147387, enable: false, confirm_danger: true } });
  assert.equal(armed.kind, 'sso_pipe');
  // 只读动作不该被 danger 拦住。
  const read = actions.validateAction({ action: 'get_group_todo_list', params: { group_id: 1041147387 } });
  assert.equal(read.kind, 'sso_pipe');
});
