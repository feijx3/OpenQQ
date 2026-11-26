'use strict';

const { fail } = require('./common.cjs');
const { getPacketSender } = require('./packet-native.cjs');

const OIDB_COMMAND = 0x6d6;
const DOWNLOAD_SUBCOMMAND = 2;
const FILE_APP_ID = 7;
const COMMAND = 'OidbSvcTrpcTcp.0x6D6_2';
const MAX_PACKET_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 8000;

function encodeVarint(value) {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error('请求包含负数 varint');
  const encoded = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    encoded.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(encoded);
}

const uintField = (number, value) =>
  Buffer.concat([encodeVarint(number * 8), encodeVarint(value)]);

function bytesField(number, value) {
  const data = Buffer.from(value);
  return Buffer.concat([encodeVarint(number * 8 + 2), encodeVarint(data.length), data]);
}

// This small decoder only needs scalar fields; unknown fixed-width fields are
// skipped/preserved so adding fields on QQ's side does not change existing paths.
// Lengths and varints are bounded before slicing untrusted server responses.
function decodeFields(input) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array) && !Array.isArray(input)) {
    throw new Error('响应不是字节数组');
  }
  // Some native bindings expose signed char values; Buffer.from keeps their bits.
  if (Array.isArray(input) && input.some(byte => !Number.isInteger(byte) || byte < -128 || byte > 255)) {
    throw new Error('响应包含无效字节');
  }
  const data = Buffer.from(input);
  if (!data.length || data.length > MAX_PACKET_BYTES) throw new Error('响应为空或超过 1 MiB');

  let offset = 0;
  const result = new Map();
  function readVarint() {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= data.length) throw new Error('protobuf varint 截断');
      const byte = data[offset++];
      if (index === 9 && byte > 1) throw new Error('protobuf varint 溢出');
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    throw new Error('protobuf varint 无效');
  }

  while (offset < data.length) {
    const tag = readVarint();
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (number < 1 || number > 0x1fffffff) throw new Error('protobuf 字段号无效');
    if (wireType === 0) {
      result.set(number, readVarint());
      continue;
    }
    const length = wireType === 2 ? Number(readVarint()) : wireType === 1 ? 8 : wireType === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > data.length - offset) {
      throw new Error('protobuf 长度或类型无效');
    }
    result.set(number, data.subarray(offset, offset + length));
    offset += length;
  }
  return result;
}

const text = value => Buffer.isBuffer(value) ? value.toString('utf8') : '';

// OIDB 0x6D6/2 requests a download ticket; getGroupFileInfo is a metadata query
// and does not establish that a download URL is available.
// Schema cross-check: Lagrange.Core v1, commit e17fe35641d3a1dc9955566fa875232551224441:
// Internal/Service/Action/GroupFSDownloadService.cs and OidbSvcTrpcTcp0x6D6_2Response.cs.
function buildRequest(group, fileId, busid) {
  const groupNumber = BigInt(group);
  if (groupNumber < 1n || groupNumber > 0xffffffffn) {
    throw fail('group_id 超出群文件协议 uint32 范围', 1400);
  }
  const download = Buffer.concat([
    uintField(1, groupNumber),
    uintField(2, FILE_APP_ID),
    uintField(3, busid),
    bytesField(4, fileId),
  ]);
  return Buffer.concat([
    uintField(1, OIDB_COMMAND),
    uintField(2, DOWNLOAD_SUBCOMMAND),
    bytesField(4, bytesField(3, download)), // OIDB.body.download
    uintField(12, 1), // isReserved, used by this NTQQ OIDB transport.
  ]);
}

// Diagnostics deliberately include only field names/types/lengths, not packet
// contents or download tickets. Native error text is handled separately below.
function describe(value, depth = 0) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Buffer.isBuffer(value)) return 'Buffer(' + value.length + ')';
  if (value instanceof Uint8Array) return 'Uint8Array(' + value.length + ')';
  if (Array.isArray(value)) return 'Array(' + value.length + ')';
  if (typeof value === 'string') return 'string(' + value.length + ')';
  if (typeof value !== 'object') return typeof value;
  if (depth >= 2) return 'object';
  const entries = Object.keys(value).slice(0, 16)
    .map(key => key + ':' + describe(value[key], depth + 1));
  return '{' + entries.join(',') + '}';
}

function packetFields(input, stage) {
  try {
    return decodeFields(input);
  } catch (error) {
    throw new Error(stage + ': ' + error.message + '；类型=' + describe(input));
  }
}

function parseResponse(input) {
  const envelope = packetFields(input, 'OIDB 外层响应');
  // Default-valued protobuf fields may be omitted. If identifiers are present,
  // require this command rather than accepting an unrelated response as a ticket.
  if (envelope.has(1) && envelope.get(1) !== BigInt(OIDB_COMMAND)) throw new Error('OIDB 响应命令不匹配');
  if (envelope.has(2) && envelope.get(2) !== BigInt(DOWNLOAD_SUBCOMMAND)) throw new Error('OIDB 响应子命令不匹配');
  if ((envelope.get(3) ?? 0n) !== 0n) {
    throw new Error('OIDB 拒绝请求: ' + (text(envelope.get(5)) || String(envelope.get(3))));
  }
  const body = packetFields(envelope.get(4), 'OIDB body(field 4)，外层字段=' + [...envelope.keys()].join(','));
  const download = packetFields(body.get(3), 'download(field 3)，body 字段=' + [...body.keys()].join(','));
  if ((download.get(1) ?? 0n) !== 0n) {
    throw new Error('QQ 拒绝下载: ' + (text(download.get(3)) || text(download.get(2)) || String(download.get(1))));
  }

  const host = text(download.get(5));
  const ticket = download.get(6);
  if (!host || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(host) || !Buffer.isBuffer(ticket) || !ticket.length) {
    throw new Error('响应缺少有效 downloadDns/downloadUrl');
  }
  // Field 6 is binary, not a URL/string. UTF-8 decoding would corrupt its bytes.
  return new URL('https://' + host + '/ftn_handler/' + ticket.toString('hex') + '/?fname=').href;
}

async function getGroupFileUrl(session, action, ensure, {
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  sendPacket = getPacketSender(),
} = {}) {
  const service = session.getMsgService?.();
  if (typeof service?.sendSsoCmdReqByContend !== 'function') {
    throw fail('当前 QQ 不支持群文件下载所需的 sendSsoCmdReqByContend', 1500);
  }
  const request = buildRequest(action.group, action.fileId, action.busid);
  let timer;
  let release;
  try {
    ensure();
    // sendPacket is a production bridge by default; mocks must be passed
    // explicitly. Its handle releases tracking, never QQ-owned promise memory.
    const handle = sendPacket(service, COMMAND, request);
    if (!handle || typeof handle.release !== 'function') {
      throw new Error('原生通道未返回可释放的请求句柄');
    }
    release = () => handle.release();
    if (typeof handle.promise?.then !== 'function') {
      throw new Error('原生通道未返回请求 Promise');
    }
    const response = await Promise.race([
      handle.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(fail(
          '群文件下载链接请求超时（OIDB 0x6D6/2）；QQ 未返回响应，请确认文件 ID 来自当前协议端', 1501,
        )), timeoutMs);
      }),
    ]);
    // A timeout stops waiting, not QQ itself. The finally block removes only
    // tracking; a later QQ completion follows its ordinary callback path.
    ensure();

    const nativeResult = Number.isFinite(response?.result) ? String(response.result) : 'missing';
    const nativeMessage = typeof response?.errMsg === 'string'
      ? response.errMsg.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : '';
    const nativeStatus = 'result=' + nativeResult + ', errMsg=' + JSON.stringify(nativeMessage);
    if (typeof response?.result === 'number' && response.result !== 0) {
      throw new Error('QQ 原生发送失败（' + nativeStatus + '）；返回结构=' + describe(response));
    }

    // OpenQQ's callback adapter preserves QQ's "rsp" property, replacing only its
    // value with a Buffer. rspbuffer also allows a compatible supplied test service.
    const packet = response?.rspbuffer ?? response?.rsp;
    if (!Buffer.isBuffer(packet) && !(packet instanceof Uint8Array) && !Array.isArray(packet)) {
      throw new Error('QQ 原生接口未提供二进制响应（' + nativeStatus + '）；返回结构=' + describe(response)
        + '。OpenQQ 原生通道未返回字节响应');
    }
    try {
      return parseResponse(packet);
    } catch (error) {
      throw new Error(error.message + '；原生返回结构=' + describe(response));
    }
  } catch (error) {
    if (error.retcode) throw error;
    throw fail('获取群文件下载链接失败（OIDB 0x6D6/2）: ' + error.message, 1500);
  } finally {
    clearTimeout(timer);
    release?.();
  }
}

module.exports = { COMMAND, buildRequest, parseResponse, getGroupFileUrl };
