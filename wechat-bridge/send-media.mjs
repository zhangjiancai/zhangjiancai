#!/usr/bin/env node
/**
 * 命令行发送微信消息（图片/视频/文件/纯文字），复用 bridge.mjs 的登录凭据。
 *
 * 用途：不重启桥接进程也能验证媒体通道，从计划任务里推一张图，或在主回复发送失败时补一条通知。
 *
 * 用法：
 *   node send-media.mjs <文件> [--caption 文字] [--to <用户ID>] [--context-token <token>]
 *   node send-media.mjs --text "一句话" [--to <用户ID>]
 *
 * 默认收件人是状态文件里已配对的第一个微信用户。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { sendMediaFile, sendTextMessage } from './ilink-media.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_FILE = join(resolve(process.env.WECHAT_STATE_DIR ?? join(HERE, '.state')), 'wechat-bridge.json')

const argv = process.argv.slice(2)
const flag = name => {
  const at = argv.indexOf('--' + name)
  return at === -1 ? '' : (argv[at + 1] ?? '')
}
const textOnly = flag('text')
const file = argv.find(arg => !arg.startsWith('--') && argv[argv.indexOf(arg) - 1]?.startsWith('--') !== true)

if (!textOnly && !file) {
  console.log('用法：node send-media.mjs <文件> [--caption 文字] [--to <用户ID>]')
  console.log('      node send-media.mjs --text "一句话" [--to <用户ID>]')
  process.exit(1)
}
if (file && !existsSync(file)) {
  console.log('文件不存在：' + resolve(file))
  process.exit(1)
}
if (!existsSync(STATE_FILE)) {
  console.log('没有登录状态文件：' + STATE_FILE + '（先运行 node bridge.mjs 完成扫码登录）')
  process.exit(1)
}

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
const account = state.account
if (!account?.token) {
  console.log('状态文件里没有 bot_token，请先运行 node bridge.mjs --login')
  process.exit(1)
}
const to = flag('to') || state.paired?.[0] || account.userId
if (!to) {
  console.log('没有收件人：状态文件里没有已配对用户，请用 --to 指定。')
  process.exit(1)
}

/** 只带了 sendmessage/getuploadurl 两条接口的最小 iLink 客户端。 */
async function api(path, { base, token, body, timeoutMs = 60000 } = {}) {
  const url = new URL(path, base.endsWith('/') ? base : base + '/')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
        'iLink-App-Id': process.env.WECHAT_APP_ID ?? 'bot',
        'iLink-App-ClientVersion': '1.0.2',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error('POST ' + path + ' HTTP ' + res.status + '：' + text.slice(0, 300))
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

const baseInfo = {
  channel_version: process.env.WECHAT_CHANNEL_VERSION ?? '1.0.2',
  bot_agent: process.env.WECHAT_BOT_AGENT ?? 'DSH-WeChat-Bridge/1.0.0',
}

const contextToken = flag('context-token') || state.contextTokens?.[to] || ''
console.log('收件人：' + to)
if (textOnly) {
  await sendTextMessage(api, { baseUrl: account.baseUrl, token: account.token, baseInfo, to, contextToken, text: textOnly })
  console.log('已发送文字：' + textOnly)
} else {
  console.log('发送文件：' + resolve(file))
  const result = await sendMediaFile(api, {
    baseUrl: account.baseUrl,
    token: account.token,
    baseInfo,
    to,
    filePath: resolve(file),
    contextToken,
    caption: flag('caption'),
  })
  console.log('已发送：' + JSON.stringify(result))
}
