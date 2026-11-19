import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import nativeActions from '../native/actions.cjs';

const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });
const sendActions = ['send_private_msg', 'send_group_msg', 'send_msg'];
const mediaSegmentTypes = new Set(['image', 'record', 'video', 'file']);
const MAX_IMAGE_BASE64_BYTES = 16 * 1024 * 1024;

const formatSize = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`);

const cqMediaTag = /\[CQ:(?:image|record|video|file),[^\]]*\]/g;
const cqInlinePayload = /(base64:\/\/|data:[^,\];\s]+;base64(?:,|&#44;))([A-Za-z0-9+/=\s]+)/gi;

function base64ByteLength(encoded) {
  if (!/\s/.test(encoded)) {
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor(encoded.length * 3 / 4) - padding);
  }
  let length = 0;
  let last1 = 0;
  let last2 = 0;
  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    if (code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(encoded[i]))) continue;
    length++;
    last2 = last1;
    last1 = code;
  }
  const padding = last1 === 61 ? (last2 === 61 ? 2 : 1) : 0;
  return Math.max(0, Math.floor(length * 3 / 4) - padding);
}

function redactMediaValue(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^base64:\/\//i.test(trimmed) && trimmed.length > 9) {
    return `base64://<${formatSize(base64ByteLength(trimmed.slice(9)))}>`;
  }
  const dataBase64 = /^data:[^;,]*;base64(?:,|&#44;)/i.exec(trimmed);
  if (dataBase64 && trimmed.length > dataBase64[0].length) {
    return `${dataBase64[0]}<${formatSize(base64ByteLength(trimmed.slice(dataBase64[0].length)))}>`;
  }
  const dataInline = /^data:[^,]*?(?:,|&#44;)/i.exec(trimmed);
  if (dataInline && trimmed.length > dataInline[0].length) {
    return `${dataInline[0]}<${formatSize(Buffer.byteLength(trimmed.slice(dataInline[0].length)))}>`;
  }
  return value;
}

function redactCqMedia(text) {
  if (!text.includes('[CQ:')) return text;
  return text.replace(cqMediaTag, tag => tag.replace(cqInlinePayload, (full, prefix, encoded) => (
    !/\S/.test(encoded) ? full : `${prefix}<${formatSize(base64ByteLength(encoded))}>`
  )));
}

// Replaces inline base64:// and data: payloads with size placeholders so WebUI/terminal history never drops or bloats large sends.
export function redactActionRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const params = request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return request;
  if (typeof params.message === 'string') {
    if (params.auto_escape) return request;
    const message = redactCqMedia(params.message);
    return message === params.message ? request : { ...request, params: { ...params, message } };
  }
  if (!Array.isArray(params.message)) return request;
  let changed = false;
  const message = params.message.map(segment => {
    if (!segment || typeof segment !== 'object' || !mediaSegmentTypes.has(segment.type)) return segment;
    const data = segment.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return segment;
    let segmentChanged = false;
    const next = {};
    for (const [key, value] of Object.entries(data)) {
      const redacted = redactMediaValue(value);
      if (redacted !== value) segmentChanged = true;
      next[key] = redacted;
    }
    if (!segmentChanged) return segment;
    changed = true;
    return { ...segment, data: next };
  });
  return changed ? { ...request, params: { ...params, message } } : request;
}

export function redactActionResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  const data = response.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return response;
  if (typeof data.base64 !== 'string' || !data.base64) return response;
  return { ...response, data: { ...data, base64: `<${formatSize(base64ByteLength(data.base64))}>` } };
}

export function recordAction(webui, out, { request, response, source, elapsed }) {
  const recordedRequest = redactActionRequest(request);
  const recordedResponse = redactActionResponse(response);
  webui?.publish('action', { request: recordedRequest, response: recordedResponse, source, elapsed });
  // Terminal actions are printed by the input loop; external actions are mirrored here.
  if (source !== 'terminal') out?.action(recordedRequest, recordedResponse, source);
}

async function formatImageResult(data, mediaUrl) {
  const file = String(data?.file ?? '');
  const remoteUrl = typeof data?.url === 'string' && /^https?:\/\//.test(data.url) ? data.url : '';
  let size = Number(data?.file_size ?? 0) || 0;
  let exists = false;
  if (file) {
    try {
      const info = await stat(file);
      if (info.isFile()) { exists = true; size = info.size; }
    } catch { /* fallback below */ }
  }
  if (!exists && !remoteUrl) throw fail('图片文件不存在或尚未下载', 1404);
  const fileName = String(data?.file_name || (file ? basename(file) : '') || 'image');
  const url = remoteUrl || (exists && typeof mediaUrl === 'function' ? (mediaUrl(file, fileName) ?? '') : '');
  let base64;
  if (exists && size > 0 && size <= MAX_IMAGE_BASE64_BYTES) {
    try { base64 = (await readFile(file)).toString('base64'); } catch { /* best effort */ }
  }
  return { file, filename: fileName, file_name: fileName, size, file_size: size, url, ...(base64 ? { base64 } : {}) };
}

// OneBot ids are local to this process; translate them into the native references QQ needs before validation.
function resolveReferences(converter, request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const params = request.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return request;
  if (request.action === 'get_forward_msg') {
    const ref = converter.resolve(params.id ?? params.message_id);
    if (!ref) throw fail('合并转发 id 不存在或已过期（仅支持本次运行期间收到的消息）', 1404);
    // A message id also works: QQ keys a top-level forward by the message that carries it.
    const forward = ref.kind === 'forward' ? ref : { chatType: ref.chatType, peerUid: ref.peerUid, root: ref.msgId, parent: ref.msgId };
    return { ...request, params: { ...params, openqq_ref: { chatType: forward.chatType, peerUid: forward.peerUid, root: forward.root, parent: forward.parent } } };
  }
  if (request.action === 'delete_msg') {
    const ref = converter.resolve(params.message_id);
    if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
    return { ...request, params: { ...params, openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
  }
  if (!sendActions.includes(request.action) || !Array.isArray(params.message)) return request;
  const message = params.message.map(segment => {
    if (segment?.type !== 'reply') return segment;
    const ref = converter.resolve(segment.data?.id);
    if (ref?.kind !== 'message') throw fail('引用的消息不存在或已过期（仅支持本次运行期间收发过的消息）', 1404);
    return { type: 'reply', data: { id: String(segment.data.id), openqq_ref: { chatType: ref.chatType, peerUid: ref.peerUid, msgId: ref.msgId } } };
  });
  return { ...request, params: { ...params, message } };
}

// Answers that need no QQ session. `can_send_*` is always yes because sending media is implemented here.
function localAnswer(request, options) {
  if (request?.action === 'get_version_info') {
    return { app_name: 'OpenQQ', app_version: options.version ?? '', protocol_version: 'v11' };
  }
  if (request?.action === 'can_send_image' || request?.action === 'can_send_record') return { yes: true };
  return undefined;
}

// `options.media` (see src/media.mjs) turns image / record / video / file segments into prepared local files.
export async function dispatchAction(channel, converter, request, options = {}) {
  let response;
  let release = async () => {};
  try {
    const local = localAnswer(request, options);
    if (local !== undefined) {
      response = { status: 'ok', retcode: 0, data: local };
    } else {
      let prepared = resolveReferences(converter, nativeActions.normalizeParams(request));
      if (options.media && sendActions.includes(prepared?.action) && prepared.params && typeof prepared.params === 'object') {
        const media = await options.media.prepare(prepared.params);
        prepared = { ...prepared, params: media.params };
        release = media.release;
      }
      const action = nativeActions.validateAction(prepared);
      response = await channel.request(prepared, (action.timeout ?? 15000) + 5000);
      if (!response || !['ok', 'failed'].includes(response.status) || !Number.isSafeInteger(response.retcode)) throw new Error('原生动作回执无效');
      if (response.status === 'ok' && response.retcode !== 0) throw new Error('原生动作回执状态不一致');
      if (response.status === 'ok' && action.kind === 'send') {
        response = { status: 'ok', retcode: 0, data: { message_id: converter.messageId(response.data.self, response.data.message) } };
      }
      if (response.status === 'ok' && action.kind === 'forward') {
        response = { status: 'ok', retcode: 0, data: converter.forwardResult(response.data.self, response.data.forward) };
      }
      if (response.status === 'ok' && action.kind === 'get_image') {
        response = { status: 'ok', retcode: 0, data: await formatImageResult(response.data, options.mediaUrl) };
      }
    }
  } catch (error) {
    response = { status: 'failed', retcode: error.retcode ?? 1500, data: null, message: error.message };
  } finally {
    await release();
  }
  return request && Object.hasOwn(request, 'echo') ? { ...response, echo: request.echo } : response;
}
