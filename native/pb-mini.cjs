'use strict';

// 极简 protobuf 编码器。整个 native/ 只有这一份实现（oidb-actions.cjs 与 sso-pipe.cjs 都从这里取），
// 免得两份实现各自处理非法输入。
//
// 整数一律走 BigInt：Number 在 2^53 以上会悄悄丢精度，而 QQ 号、群号、msgId 都在那个量级附近。
// 非法输入直接抛错，不编成 0 —— 把一个非法 group_id 编成 0 再发给服务端，比当场失败危险得多。

function toBigInt(value, what = 'protobuf 整数字段') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`${what} 必须是整数，收到 ${value}`);
    if (!Number.isSafeInteger(value)) throw new TypeError(`${what} 超出安全整数范围（2^53），请传字符串或 BigInt：${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${what} 必须是整数，收到 ${typeof value}`);
}

// protobuf 的 uint64 用补码表示负数，所以负数按 64 位取模编码，而不是写 0。
function varint(value, what) {
  let v = toBigInt(value, what);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

function tag(field, wire) {
  const fieldNo = toBigInt(field, 'protobuf 字段号');
  if (fieldNo < 0n || fieldNo > 0x1fffffffn) throw new RangeError(`protobuf 字段号越界：${field}`);
  if (wire < 0 || wire > 5) throw new RangeError(`protobuf wire type 非法：${wire}`);
  return varint((fieldNo << 3n) | BigInt(wire));
}

const vint = (field, value, what) => Buffer.concat([tag(field, 0), varint(value, what || `字段 ${field}`)]);

function str(field, s) {
  const body = Buffer.from(s == null ? '' : String(s), 'utf8');
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

function bytes(field, b) {
  const body = Buffer.isBuffer(b) ? b : Buffer.from(b || []);
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

// 拍一拍（OIDB 0xed3_1 SendPoke）的完整 OidbBase 包。
// 群聊：uin=被拍的人、groupUin=群号、friendUin=0；私聊：uin=对方、groupUin=0、friendUin=对方。
// ⚠️ friendUin 是 field 5，不是 field 3 —— 按"第 4 个字段"猜会编错。
function buildOidbPoke({ groupId = 0, userId = 0 } = {}) {
  const g = BigInt(groupId || 0);
  const u = BigInt(userId || 0);
  const isGroup = g > 0n;
  const poke = Buffer.concat([
    vint(1, u),                        // uin：被拍的人
    vint(2, isGroup ? g : 0n),         // groupUin
    vint(5, isGroup ? 0n : u),         // friendUin
    vint(6, 0n),                       // ext
  ]);
  // OidbBase { command=1, subCommand=2, errorCode=3, body=4 }
  return Buffer.concat([
    vint(1, 3795), // 0xed3 SendPoke
    vint(2, 1),
    vint(3, 0),
    bytes(4, poke),
  ]);
}

module.exports = { toBigInt, varint, tag, vint, str, bytes, buildOidbPoke };
