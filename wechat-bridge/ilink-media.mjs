#!/usr/bin/env node
/**
 * 微信 iLink 媒体消息（图片/视频/文件）发送。
 *
 * iLink 不接收二进制消息体，媒体要走「AES-128-ECB 加密明文 -> 上传微信 CDN -> 只把加密后的
 * 引用参数放进 item_list」三步。本模块封装这三步，供 bridge.mjs 与命令行脚本共用。
 *
 * 协议要点（与 @tencent-weixin/openclaw-weixin、Hermes weixin 适配器一致）：
 *   - getuploadurl 的 filesize 是 AES-128-ECB + PKCS#7 之后的密文长度，不是明文长度；
 *   - CDN 上传用 POST，返回的 encrypted_query_param 在响应头 x-encrypted-param 里，不在 body 里；
 *   - sendmessage 的 aes_key 是 base64(密钥十六进制字符串)，不是 base64(密钥原始字节)，
 *     传错时图片会显示成灰块。
 */

import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { readFileSync } from 'node:fs'

const CDN_BASE = (process.env.WECHAT_CDN_BASE ?? 'https://novac2c.cdn.weixin.qq.com/c2c').replace(/\/+$/, '')

const MEDIA_IMAGE = 1
const MEDIA_VIDEO = 2
const MEDIA_FILE = 3

const ITEM_IMAGE = 2
const ITEM_FILE = 4
const ITEM_VIDEO = 5

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'])

/** 设 WECHAT_MEDIA_DEBUG=1 时打印上传与发包细节，用于诊断 ret/errcode 报错。 */
const DEBUG = process.env.WECHAT_MEDIA_DEBUG === '1'
const debug = (...args) => {
  if (DEBUG) console.log('[ilink-media]', ...args)
}

/** 按扩展名判定 iLink 的 media_type。 */
export function mediaTypeFor(filePath) {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return MEDIA_IMAGE
  if (VIDEO_EXTS.has(ext)) return MEDIA_VIDEO
  return MEDIA_FILE
}

/** PKCS#7 填充后的密文长度（AES 分组固定 16 字节）。 */
function paddedSize(plaintextSize) {
  return (Math.floor(plaintextSize / 16) + 1) * 16
}

/** AES-128-ECB 加密（Node 默认 PKCS#7 填充）。 */
function encryptEcb(plaintext, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

/**
 * 加密并上传一个文件，返回 iLink 发送媒体消息所需的引用参数。
 * @param api 调用 iLink JSON 接口的函数，签名与 bridge.mjs 的 api() 相同。
 * @param mediaType 见 `mediaTypeFor`。
 * @returns 密文引用参数、发给 API 的 aes_key 与明文/密文长度。
 */
async function uploadMedia(api, { baseUrl, token, baseInfo, to, filePath, mediaType }) {
  const plaintext = readFileSync(filePath)
  const aesKey = randomBytes(16)
  const filekey = randomBytes(16).toString('hex')
  const rawsize = plaintext.length
  const rawfilemd5 = createHash('md5').update(plaintext).digest('hex')

  const uploadResp = await api('ilink/bot/getuploadurl', {
    base: baseUrl,
    token,
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: to,
      rawsize,
      rawfilemd5,
      filesize: paddedSize(rawsize),
      no_need_thumb: true,
      aeskey: aesKey.toString('hex'),
      base_info: baseInfo,
    },
  })
  debug('getuploadurl resp:', JSON.stringify(uploadResp).slice(0, 300))
  if (uploadResp.ret && uploadResp.ret !== 0) {
    throw new Error('getuploadurl ret=' + uploadResp.ret + ' ' + (uploadResp.errmsg ?? ''))
  }

  const ciphertext = encryptEcb(plaintext, aesKey)
  const uploadParam = String(uploadResp.upload_param ?? '')
  const uploadFullUrl = String(uploadResp.upload_full_url ?? '')
  const uploadUrl = uploadFullUrl ||
    (uploadParam ? CDN_BASE + '/upload?encrypted_query_param=' + encodeURIComponent(uploadParam) + '&filekey=' + encodeURIComponent(filekey) : '')
  if (!uploadUrl) throw new Error('getuploadurl 未返回 upload_param 或 upload_full_url')

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(ciphertext.length) },
    body: ciphertext,
  })
  const headerParam = res.headers.get('x-encrypted-param') ?? ''
  const text = await res.text()
  debug('CDN', res.status, 'header param len', headerParam.length, 'body len', text.length, 'body', text.slice(0, 200))
  if (!res.ok) throw new Error('CDN 上传失败 HTTP ' + res.status + '：' + text.slice(0, 200))

  let encryptedQueryParam = headerParam
  if (!encryptedQueryParam) {
    try {
      const parsed = JSON.parse(text)
      encryptedQueryParam = parsed.encrypted_query_param ?? parsed.encrypt_query_param ?? ''
    } catch {
      // CDN 有时返回空 body，参数只在响应头里；此处落到下面的报错。
    }
  }
  if (!encryptedQueryParam) throw new Error('CDN 上传未返回 encrypted_query_param')

  return {
    encryptedQueryParam,
    // iLink 要求 base64(十六进制字符串)，不是 base64(原始 16 字节)。
    aesKeyForApi: Buffer.from(aesKey.toString('hex'), 'utf8').toString('base64'),
    ciphertextSize: ciphertext.length,
    rawsize,
    rawfilemd5,
  }
}

/** 组装一条媒体 item。 */
function buildItem(mediaType, upload, filePath) {
  const media = {
    encrypt_query_param: upload.encryptedQueryParam,
    aes_key: upload.aesKeyForApi,
    encrypt_type: 1,
  }
  if (mediaType === MEDIA_IMAGE) return { type: ITEM_IMAGE, image_item: { media, mid_size: upload.ciphertextSize } }
  if (mediaType === MEDIA_VIDEO) {
    return {
      type: ITEM_VIDEO,
      video_item: { media, video_size: upload.ciphertextSize, play_length: 0, video_md5: upload.rawfilemd5 },
    }
  }
  return { type: ITEM_FILE, file_item: { media, file_name: basename(filePath), len: String(upload.rawsize) } }
}

/** 图片扩展名（不含点），用于日志与判断。 */
export function isImagePath(filePath) {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase())
}

/**
 * 发送一条文字消息（媒体消息的 caption 走这里单独发）。
 * @returns 服务端返回的消息 id（若返回）。
 */
async function sendTextItem(api, { baseUrl, token, baseInfo, to, contextToken, text }) {
  return await api('ilink/bot/sendmessage', {
    base: baseUrl,
    token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: randomUUID().replaceAll('-', ''),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken ?? '',
      },
      base_info: baseInfo,
    },
  })
}

/**
 * 发送一条媒体消息；带 context_token 失败时按 iLink 的降级规则去掉 token 重发一次。
 *
 * ret=-2（invalid arguments / prepare failed）是服务端在说「这条会话现在不接受这个包」：
 * token 过期时去掉 token 能过，会话整体失效时两种都过不去。
 */
async function sendMediaItem(api, { baseUrl, token, baseInfo, to, itemList, contextToken }) {
  let last = null
  for (const attemptToken of contextToken ? [contextToken, ''] : ['']) {
    const resp = await api('ilink/bot/sendmessage', {
      base: baseUrl,
      token,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: to,
          client_id: randomUUID().replaceAll('-', ''),
          message_type: 2,
          message_state: 2,
          item_list: itemList,
          // 这个字段必须存在（可以是空串）；整个键缺失时服务端直接回 -2 invalid arguments。
          context_token: attemptToken ?? '',
        },
        base_info: baseInfo,
      },
    })
    if ((!resp.ret || resp.ret === 0) && (!resp.errcode || resp.errcode === 0)) return resp
    last = resp
    if (attemptToken) debug('sendmessage 带 context_token 失败，去掉 token 重试：' + JSON.stringify(resp))
  }
  return assertSendOk(last)
}

/** 把 sendmessage 的 ret/errcode 转成能看懂的报错。 */
function assertSendOk(resp) {
  if ((!resp.ret || resp.ret === 0) && (!resp.errcode || resp.errcode === 0)) return resp
  const detail = 'ret=' + (resp.ret ?? 0) + ' errcode=' + (resp.errcode ?? 0) + ' ' + (resp.errmsg ?? '')
  if (resp.ret === -2 || resp.errcode === -2) {
    throw new Error(
      'sendmessage -2（' + (resp.errmsg ?? '') + '）：iLink 会话不是「新鲜」状态，通常是没有用户消息在近期刷新 context_token。' +
      '在微信里给机器人发一条消息后再发，或在桥接进程内用 /send 指令（那时用的是消息自带的 token）。原始返回：' + detail,
    )
  }
  throw new Error('sendmessage ' + detail)
}

/**
 * 发送一条纯文字消息；带 context_token 被拒时去掉 token 降级重发一次。
 * @returns 服务端返回的消息 id（若返回）。
 */
export async function sendTextMessage(api, { baseUrl, token, baseInfo, to, contextToken, text }) {
  let last = null
  for (const attemptToken of contextToken ? [contextToken, ''] : ['']) {
    const resp = await sendTextItem(api, { baseUrl, token, baseInfo, to, contextToken: attemptToken, text })
    if ((!resp.ret || resp.ret === 0) && (!resp.errcode || resp.errcode === 0)) return resp
    last = resp
    if (attemptToken) debug('sendmessage 带 context_token 失败，去掉 token 重试：' + JSON.stringify(resp))
  }
  return assertSendOk(last)
}

/**
 * 把本地文件作为微信媒体消息发出。caption 非空时作为独立的一条文字消息先发。
 *
 * 注意：caption 与媒体不能放进同一个 item_list —— iLink 会整包拒绝（ret=-2 invalid arguments）。
 *
 * @returns 媒体类型与明文/密文大小。
 */
export async function sendMediaFile(api, { baseUrl, token, baseInfo, to, filePath, contextToken, caption }) {
  const mediaType = mediaTypeFor(filePath)
  const upload = await uploadMedia(api, { baseUrl, token, baseInfo, to, filePath, mediaType })

  if (caption && String(caption).trim()) {
    await sendTextMessage(api, { baseUrl, token, baseInfo, to, contextToken, text: String(caption).trim() })
  }

  const itemList = [buildItem(mediaType, upload, filePath)]
  debug('sendmessage msg:', JSON.stringify(itemList, (k, v) => (typeof v === 'string' && v.length > 60 ? v.slice(0, 12) + '…(' + v.length + ')' : v)).slice(0, 800))
  await sendMediaItem(api, { baseUrl, token, baseInfo, to, itemList, contextToken })
  return { mediaType, rawsize: upload.rawsize, ciphertextSize: upload.ciphertextSize }
}
