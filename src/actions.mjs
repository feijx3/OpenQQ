import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import nativeActions from '../native/actions.cjs';
import { generateImage } from './image-action.mjs';

const fail = (message, retcode = 1400) => Object.assign(new Error(message), { retcode });
const sendActions = ['send_private_msg', 'send_group_msg', 'send_msg'];
const MAX_IMAGE_BASE64_BYTES = 16 * 1024 * 1024;

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

// Inline media (base64:// or a data: URI) can be megabytes. The WebUI keeps every action in a 2 MiB history and drops any entry larger
// than that, and the terminal prints the request, so both get a copy where the payload is replaced by its size.
const INLINE_MEDIA = /(base64:\/\/|data:[^;,\s]{1,100};base64,)[A-Za-z0-9+/=\s]{512,}/g;
export function redactRequest(value, depth = 0) {
  if (typeof value === 'string') return value.length > 512 ? value.replace(INLINE_MEDIA, (match, head) => `${head}[已省略 ${match.length - head.length} 字符]`) : value;
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => redactRequest(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactRequest(item, depth + 1)]));
}

// get_image answers with the picture as plain base64, generate_image with base64:// files.
export function redactResponse(response) {
  const data = response?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return response;
  const plain = typeof data.base64 === 'string' && data.base64.length > 512;
  if (!plain && !Array.isArray(data.images)) return response;
  return { ...response, data: { ...data, ...(plain ? { base64: `[已省略 ${data.base64.length} 字符]` } : {}), ...(Array.isArray(data.images) ? { images: redactRequest(data.images) } : {}) } };
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
  // 这几个动作在 native 侧都靠 p.openqq_ref 拿源消息的 msgId/peerUid，主进程必须先把引用附上，
  // 否则它们永远拿到空引用、只能回 1404。
  if (request.action === 'get_msg' || request.action === 'set_msg_emoji_like'
    || request.action === 'get_msg_emoji_likes' || request.action === 'fetch_emoji_like') {
    const ref = converter.resolve(params.message_id);
    if (ref?.kind !== 'message') throw fail('message_id 不存在或已过期（仅支持本次运行期间收发过或被引用的消息）', 1404);
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
    } else if (request?.action === 'generate_image') {
      // 发送走同一个 dispatchAction，所以图片照常经过媒体处理（落盘、大小限制）和 QQ 的发送回执。
      const data = await generateImage(request.params ?? {}, { image: options.image, send: next => dispatchAction(channel, converter, next, options) });
      response = { status: 'ok', retcode: 0, data };
    } else if (request?.action === 'clean_cache') {
      // Only OpenQQ's own temporary media is cleaned, and only what an earlier run left behind (the same rule as at startup).
      await options.media?.sweep();
      response = { status: 'ok', retcode: 0, data: null };
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
      if (response.status === 'ok' && action.kind === 'get_msg') {
        response = { status: 'ok', retcode: 0, data: converter.messageResult(response.data.self, response.data.message) };
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
  return { ...response, ...(request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {}) };
}
