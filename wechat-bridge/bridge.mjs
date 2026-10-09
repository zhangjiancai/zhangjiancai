#!/usr/bin/env node
/**
 * DeepSeek Harness <-> 微信 ClawBot 桥接进程。
 *
 * 微信侧使用腾讯官方 iLink Bot API（与微信 ClawBot / @tencent-weixin/openclaw-weixin 同一协议），
 * Harness 侧使用 SDK JSON-RPC（等价于命令 dsh --profile sdk），因此不需要安装 OpenClaw。
 *
 *   微信 --iLink 长轮询--> bridge.mjs --SDK JSON-RPC(stdio)--> dsh --profile sdk
 *   微信 <--sendmessage--- bridge.mjs <--finalResponse-------- DSH Agent
 *
 * 用法：
 *   node bridge.mjs                  首次运行会打印二维码链接，扫码后开始收发消息
 *   node bridge.mjs --login          强制重新扫码登录
 *   node bridge.mjs --check          仅检查 DSH 运行时能否启动，不连接微信
 *   node bridge.mjs --check-wechat   仅检查 iLink 服务是否可达，不登录
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { sendMediaFile } from './ilink-media.mjs'
import { analyzeContext, embeddingCacheFile, preprocessInfo, warmupPreprocess } from './preprocess.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(process.env.DSH_REPO ?? join(HERE, '..'))
const STATE_DIR = resolve(process.env.WECHAT_STATE_DIR ?? join(HERE, '.state'))
const STATE_FILE = join(STATE_DIR, 'wechat-bridge.json')
const SDK_CLIENT = join(REPO_ROOT, 'packages', 'sdk', 'client', 'lib', 'index.js')

const ILINK_BASE = process.env.WECHAT_ILINK_BASE ?? 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = process.env.WECHAT_BOT_TYPE ?? '3'
const APP_ID = process.env.WECHAT_APP_ID ?? 'bot'
const CHANNEL_VERSION = '1.0.2'
const BOT_AGENT = process.env.WECHAT_BOT_AGENT ?? 'DSH-WeChat-Bridge/1.0.0'
const CLIENT_VERSION = String(((1 & 0xff) << 16) | ((0 & 0xff) << 8) | 0)

const AGENT_CWD = resolve(process.env.DSH_CWD ?? REPO_ROOT)
const PROVIDER = process.env.DSH_PROVIDER ?? 'deepseek-official'
const MODEL = process.env.DSH_MODEL ?? 'deepseek-flash'
const ALLOW = (process.env.WECHAT_ALLOW ?? '').split(',').map(s => s.trim()).filter(Boolean)
const PERMISSION_MODE = process.env.DSH_PERMISSION_MODE || 'danger-full-access'
const MAX_RUNTIMES = Number(process.env.DSH_MAX_RUNTIMES ?? 3)
const HISTORY_DIR = join(STATE_DIR, 'history')
/** DSH 的命名工作区注册表：`$DSH_HOME/storages/workspace.json`，即 Web/GUI 里那份「项目」列表。 */
const WORKSPACE_REGISTRY = join(resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh')), 'storages', 'workspace.json')
/** `/ws` 一次最多列出几个已登记工作区（微信单条 1200 字）。 */
const MAX_WORKSPACE_LIST = 20
const REPLAY_EXCHANGES = Number(process.env.WECHAT_REPLAY_EXCHANGES ?? 4)
const REPLAY_MAX_CHARS = Number(process.env.WECHAT_REPLAY_MAX_CHARS ?? 4000)
const MAX_TEXT_CHARS = Number(process.env.WECHAT_MAX_CHARS ?? 1200)
/** 本地预处理默认开启：无关消息走新会话，相关消息只带选中的历史（见 preprocess.mjs）。 */
const PREPROCESS_DEFAULT = (process.env.WECHAT_PREPROCESS ?? '1') !== '0'
/** 是否在回复末尾附上本回合的预处理判定。 */
const PREPROCESS_NOTIFY = (process.env.WECHAT_PRE_NOTIFY ?? '1') !== '0'
/** 参与相关性判定的历史记录条数上限；0 表示整条时间线。判定输入要求是「整个对话」，所以默认不截断。 */
const PRE_SELECT_RECORDS = Number(process.env.WECHAT_PRE_SELECT_RECORDS ?? 0)
/** 预处理每回合新建会话，会话状态留在运行时内存里；单个运行时超过这个数量就回收它。 */
const MAX_SESSIONS_PER_RUNTIME = Number(process.env.DSH_MAX_SESSIONS ?? 50)
const LONG_POLL_MS = 35000
const TYPING_KEEPALIVE_MS = 5000
const STALE_TOKEN_ERRCODE = -14
/**
 * 瘦身 profile 的补丁文件：禁掉 computer-use 那一组（实测 26,837 tokens，占完整档的 70%）。
 * 图像外包子代理由 profile 的 DSH_VISION_CHANNEL 控制，默认关。
 */
const LEAN_PATCH = join(HERE, 'lean.patch.yml')
/** 默认是否启用瘦身 profile；微信里可用 /profile full 临时把截图能力开回来。 */
const LEAN_PROFILE_DEFAULT = (process.env.WECHAT_LEAN_PROFILE ?? '1') !== '0'

const HELP_TEXT = [
  '我在，直接把需求发给我就行。可用指令：',
  '/new         开一段新会话（清空上下文）',
  '/status      查看工作区、会话、权限与运行时状态',
  '/ws          列出全部工作区（当前工作区标 *）',
  '/pwd         查看当前工作区与该工作区的会话',
  '/ws <名称>   切换工作区：DSH 已登记的工作区名（如 wechat-todo）',
  '/ws <路径>   切换工作区：路径相对当前工作区解析，支持 ~ 与 ..',
  '/ws -        切回上一个工作区',
  '/ws+ <名称|路径> 新建目录并切过去',
  '/ls [路径]   列出目录内容',
  '/send <路径> 把本机文件发到微信（图片直接显示，其他类型发文件）',
  '/pre on|off  本地预处理：判断新消息与上文是否相关，无关就开新会话省钱',
  '/pre         看预处理状态（判定器、阈值、模型缓存目录）',
  '/profile [lean|full] 提示词档位（lean 默认，禁用截图工具组，固定提示词 38.2k→11.4k）',
  '/history [n] 回看该工作区最近 n 轮对话（默认 10）',
  '/help        显示这条帮助',
].join('\n')

const argv = new Set(process.argv.slice(2))
const MODE = argv.has('--login') ? 'login'
  : argv.has('--check') ? 'check'
    : argv.has('--check-wechat') ? 'check-wechat'
      : argv.has('--check-media') ? 'check-media'
        : argv.has('--check-workspaces') ? 'check-workspaces'
          : 'run'

/** 带时间戳的控制台输出。 */
function log(...args) {
  console.log(new Date().toLocaleString('zh-CN', { hour12: false }), ...args)
}

/** 等待若干毫秒。 */
function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

/**
 * 取 `/命令` 后面那个参数，去掉包裹的方括号/圆括号并转小写。
 * 帮助里写的是 `/pre [on|off]`，照抄连同方括号发过来的人不少，括号不能当成参数的一部分。
 */
function bareArg(text, command) {
  return text.slice(command.length).trim().replace(/^[\[(]+/, '').replace(/[\])]+$/, '').toLowerCase()
}

/** 解析 KEY=VALUE 形式的 .env 文件，忽略注释与空行。 */
function parseDotEnv(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match || line.trim().startsWith('#')) continue
    out[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/** 子进程环境：进程环境 + bridge/.env + 仓库根 .env（已存在的变量优先）。 */
/** 子进程环境：先合 .env，再强制权限模式（提权开关，见 README）。 */
function childEnv() {
  const env = {
    ...parseDotEnv(join(REPO_ROOT, '.env')),
    ...parseDotEnv(join(HERE, '.env')),
    ...process.env,
  }
  env.DSH_PERMISSION_MODE = env.DSH_PERMISSION_MODE || PERMISSION_MODE
  return env
}

/** 读取持久化状态（登录凭据、同步游标、会话映射）。 */
function loadState() {
  const empty = { v: 1, account: null, syncBuf: '', paired: [], sessions: {}, workspaces: {}, previousWorkspaces: {}, contextTokens: {}, preprocess: PREPROCESS_DEFAULT, preprocessSince: {}, leanProfile: null }
  if (!existsSync(STATE_FILE)) return empty
  try {
    return { ...empty, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }
  } catch (err) {
    log('状态文件损坏，按未登录处理：', String(err))
    return empty
  }
}

/** 原子写入状态文件。 */
function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, STATE_FILE)
}

/** 每个请求都变化的 X-WECHAT-UIN：随机 uint32 -> 十进制字符串 -> base64。 */
function randomUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64')
}

/** 请求头；未登录时只有公共头。 */
function buildHeaders(token) {
  const headers = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomUin(),
    'iLink-App-Id': APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
  }
  if (token) headers.Authorization = 'Bearer ' + token
  return headers
}

/** 公共请求体字段。 */
function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }
}

/**
 * 调用 iLink 接口。超时以 AbortError 抛出，由调用方决定如何解释（长轮询中超时是正常现象）。
 * @returns 解析后的 JSON 响应。
 */
async function api(path, { base = ILINK_BASE, method = 'POST', body, token, timeoutMs = 15000 } = {}) {
  const url = new URL(path, base.endsWith('/') ? base : base + '/')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: buildHeaders(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(method + ' ' + path + ' HTTP ' + res.status + ': ' + text.slice(0, 300))
    return text ? JSON.parse(text) : {}
  } finally {
    clearTimeout(timer)
  }
}

/** 取一张新的登录二维码，并把链接写进控制台（后台运行时即日志）。 */
async function fetchQr() {
  const qr = await api('ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(BOT_TYPE), { body: { local_token_list: [] } })
  log('请用手机微信打开下面的链接（或扫描二维码）完成授权；二维码约 8 分钟有效，过期会自动换新：')
  log('  ' + (qr.qrcode_img_content ?? '(未返回链接)'))
  return qr
}

/** 扫码登录：取二维码 -> 轮询扫码状态 -> 返回账号凭据。 */
async function qrLogin() {
  let qr = await fetchQr()
  let deadline = Date.now() + 8 * 60 * 1000
  let verifyCode = ''
  for (;;) {
    if (Date.now() >= deadline) {
      qr = await fetchQr()
      verifyCode = ''
      deadline = Date.now() + 8 * 60 * 1000
    }
    let status
    try {
      const query = 'ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qr.qrcode)
      status = await api(verifyCode ? query + '&verify_code=' + encodeURIComponent(verifyCode) : query,
        { method: 'GET', timeoutMs: LONG_POLL_MS })
    } catch (err) {
      if (String(err && err.name) === 'AbortError') continue
      log('轮询扫码状态失败，重试：' + String(err))
      await sleep(2000)
      continue
    }
    switch (status.status) {
      case 'wait':
        break
      case 'scaned':
        verifyCode = ''
        break
      case 'scaned_but_redirect':
        if (status.redirect_host) log('服务端要求切换到接入点：' + status.redirect_host)
        break
      case 'need_verifycode': {
        if (!input.isTTY) {
          log('需要输入手机微信上显示的数字，但当前不是交互终端；请先在本目录控制台执行 node bridge.mjs --login 完成一次登录。')
          await sleep(5 * 60 * 1000)
          qr = await fetchQr()
          verifyCode = ''
          deadline = Date.now() + 8 * 60 * 1000
          break
        }
        const rl = createInterface({ input, output })
        verifyCode = (await rl.question('请输入手机微信上显示的数字：')).trim()
        rl.close()
        break
      }
      case 'expired':
        qr = await fetchQr()
        verifyCode = ''
        deadline = Date.now() + 8 * 60 * 1000
        break
      case 'verify_code_blocked':
        log('验证码多次输入错误，换一张二维码后重试。')
        await sleep(60 * 1000)
        qr = await fetchQr()
        verifyCode = ''
        deadline = Date.now() + 8 * 60 * 1000
        break
      case 'binded_redirect':
        log('该微信号已绑定过其它客户端，30 分钟后重试；如需换号请先在微信中解绑。')
        await sleep(30 * 60 * 1000)
        qr = await fetchQr()
        deadline = Date.now() + 8 * 60 * 1000
        break
      case 'confirmed': {
        if (!status.ilink_bot_id) throw new Error('登录失败：服务端未返回 ilink_bot_id')
        log('登录成功：bot_id=' + status.ilink_bot_id)
        return {
          token: status.bot_token,
          baseUrl: status.baseurl ?? ILINK_BASE,
          botId: status.ilink_bot_id,
          userId: status.ilink_user_id ?? '',
          loginAt: Date.now(),
        }
      }
      default:
        log('未知扫码状态：' + String(status.status))
    }
    await sleep(1000)
  }
}

/** 按长度切分长回复，尽量在换行处断开。 */
function chunkText(text, limit = MAX_TEXT_CHARS) {
  const chunks = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  chunks.push(rest)
  return chunks
}

/**
 * iLink 在「这条会话现在不接受该包」时返回 -2（invalid arguments / prepare failed）或
 * -14（登录态过期）。用户消息自带的 context_token 会随时间失效，长回合结束时正好撞上。
 */
function isStaleSession(resp) {
  return resp.ret === -2 || resp.ret === -14 || resp.errcode === -2 || resp.errcode === -14
}

/** 发送文本消息，必要时分片；带 context_token 被拒时去掉 token 降级重发一次。 */
async function sendText(account, to, text, contextToken) {
  const body = String(text ?? '').trim() || '(空回复)'
  const chunks = chunkText(body)
  const post = (part, token) => api('ilink/bot/sendmessage', {
    base: account.baseUrl,
    token: account.token,
    body: {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: randomUUID().replaceAll('-', ''),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: part } }],
        context_token: token,
      },
      base_info: baseInfo(),
    },
  })
  for (let i = 0; i < chunks.length; i += 1) {
    const part = chunks.length > 1 ? '（' + (i + 1) + '/' + chunks.length + '）\n' + chunks[i] : chunks[i]
    let resp = await post(part, contextToken ?? '')
    if (isStaleSession(resp) && contextToken) {
      log('sendmessage 带 context_token 被拒（' + (resp.errmsg ?? resp.ret) + '），去掉 token 重试')
      resp = await post(part, '')
    }
    if (resp.ret && resp.ret !== 0) throw new Error('sendmessage ret=' + resp.ret + ' ' + (resp.errmsg ?? ''))
    if (i + 1 < chunks.length) await sleep(300)
  }
}

/** 媒体接口调用统一给更长的超时：一张图要先加密再上传 CDN。 */
function mediaApi(path, options) {
  return api(path, { ...options, timeoutMs: 60000 })
}

/** 消息脚注开关：默认把本回合的 token 消耗附在回复末尾。 */
const TOKEN_FOOTER = (process.env.WECHAT_TOKEN_FOOTER ?? '1') !== '0'

/**
 * 把一个回合内所有 `assistant/message` 事件的 usage 累加。
 *
 * 每个 step 都是一次独立的模型请求，所以 inputTokens 必须累加而不是取最后一次
 * （上下文缓存命中在 cacheReadTokens 里，与 inputTokens 不重复）。
 * @returns 累加后的用量；该回合没有上报用量时返回 null。
 */
function sumUsage(events) {
  let usage = null
  for (const event of events ?? []) {
    if (event?.type !== 'assistant/message') continue
    const step = event.data?.usage
    if (!step) continue
    usage ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
    const input = step.inputTokens ?? 0
    const output = step.outputTokens ?? 0
    const cacheRead = step.cacheReadTokens ?? 0
    const cacheWrite = step.cacheWriteTokens ?? 0
    usage.inputTokens += input
    usage.outputTokens += output
    usage.cacheReadTokens += cacheRead
    usage.cacheWriteTokens += cacheWrite
    usage.totalTokens += step.totalTokens ?? (input + output + cacheRead + cacheWrite)
  }
  return usage
}

/** 回复末尾的 token 脚注，例如「（本条消耗 12,345 tokens：输入 11,000，其中缓存 9,000，输出 1,345）」。 */
function tokenFooter(usage) {
  if (!TOKEN_FOOTER || !usage) return ''
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens
  const parts = ['输入 ' + (usage.inputTokens + cached).toLocaleString('en-US')]
  if (cached > 0) parts.push('其中缓存 ' + cached.toLocaleString('en-US'))
  parts.push('输出 ' + usage.outputTokens.toLocaleString('en-US'))
  return '\n\n（本条消耗 ' + usage.totalTokens.toLocaleString('en-US') + ' tokens：' + parts.join('，') + '）'
}

/** 把本机文件作为媒体消息发给用户；图片走 image_item，其余走 file_item。 */
async function sendMedia(account, to, filePath, contextToken, caption) {
  const result = await sendMediaFile(mediaApi, {
    baseUrl: account.baseUrl,
    token: account.token,
    baseInfo: baseInfo(),
    to,
    filePath,
    contextToken,
    caption,
  })
  log('已发送媒体：' + filePath + '（' + (result.mediaType === 1 ? '图片' : '文件') + '，' + result.rawsize + ' 字节）')
}

/**
 * 从回复文本里摘出 `MEDIA:<路径>` 行（每行一个附件），返回剩余文本与文件列表。
 * 路径支持 ~ 与相对当前工作区。
 */
function extractMediaLines(reply, workspace) {
  const files = []
  const kept = []
  for (const line of String(reply ?? '').split('\n')) {
    const match = /^\s*MEDIA:\s*(.+?)\s*$/.exec(line)
    if (!match) {
      kept.push(line)
      continue
    }
    const path = resolveWorkspacePath(match[1], workspace)
    if (existsSync(path)) files.push(path)
    else log('回复里的附件不存在，已忽略：' + path)
  }
  return { text: kept.join('\n').trim(), files }
}

/** 取（并缓存）某用户的 typing_ticket。 */
const typingTickets = new Map()
async function typingTicket(account, userId, contextToken) {
  const cached = typingTickets.get(userId)
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.ticket
  const resp = await api('ilink/bot/getconfig', {
    base: account.baseUrl,
    token: account.token,
    body: { ilink_user_id: userId, context_token: contextToken, base_info: baseInfo() },
    timeoutMs: 10000,
  })
  const ticket = resp.typing_ticket ?? ''
  if (ticket) typingTickets.set(userId, { ticket, at: Date.now() })
  return ticket
}

/** 发送/取消“正在输入”，失败不影响主流程。 */
async function setTyping(account, userId, contextToken, status) {
  try {
    const ticket = await typingTicket(account, userId, contextToken)
    if (!ticket) return
    await api('ilink/bot/sendtyping', {
      base: account.baseUrl,
      token: account.token,
      body: { ilink_user_id: userId, typing_ticket: ticket, status },
      timeoutMs: 10000,
    })
  } catch {
    // “正在输入”只是体验优化，任何失败都忽略。
  }
}

/** 把 iLink 消息体转成文本。 */
function messageText(msg) {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item && item.text_item.text != null) return String(item.text_item.text)
    if (item.type === 3 && item.voice_item && item.voice_item.text) return String(item.voice_item.text)
  }
  return ''
}

/** 单用户串行队列：同一微信用户的消息按顺序交给同一个 DSH 会话。 */
const queues = new Map()
function enqueue(userId, task) {
  const previous = queues.get(userId) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(userId, next.then(() => {}, () => {}))
  return next
}

let startedAt = Date.now()

/** 当前是否用瘦身 profile；/profile 改它，下一个新建的运行时生效。 */
let leanProfile = LEAN_PROFILE_DEFAULT

/** 一个工作区一个 DSH 运行时（子进程）：cwd、AGENTS.md、沙箱根都跟着工作区走。 */
class DshRuntime {
  constructor(workspace, lean) {
    this.workspace = workspace
    /** 启动这个运行时用的提示词档位；与当前设置不一致时会被回收重建。 */
    this.lean = lean
    this.harness = null
    this.busy = false
    this.lastUsed = Date.now()
    /** 本运行时实例已经用过的会话 id（回收/重启后重新回放历史）。 */
    this.started = new Set()
  }

  async ensure() {
    if (this.harness) return this.harness
    let DeepSeekHarness
    try {
      const url = 'file://' + SDK_CLIENT.replaceAll('\\', '/')
      const mod = await import(url)
      DeepSeekHarness = mod.DeepSeekHarness
    } catch (err) {
      throw new Error(
        '无法加载 SDK 客户端 ' + SDK_CLIENT + '\n' +
        '请先在 DSH 仓库根目录执行 pnpm run build:lib，然后重试。\n' +
        '原始错误：' + String(err && err.message ? err.message : err),
      )
    }
    const options = {
      cwd: this.workspace,
      provider: PROVIDER,
      model: MODEL,
      // 这台机器上 dsh 冷启动约 10 秒，SDK 客户端默认 10 秒握手会超时。
      initializeTimeoutMs: Number(process.env.DSH_INIT_TIMEOUT_MS ?? 60000),
      env: childEnv(),
    }
    if (process.env.DSH_BIN) options.dshBin = process.env.DSH_BIN
    // 瘦身档：启动时用一个补丁层禁掉 computer-use 那一组工具，固定提示词从 38.2k 降到 11.4k。
    if (this.lean) {
      if (existsSync(LEAN_PATCH)) options.patches = [LEAN_PATCH]
      else log('瘦身补丁不存在，按完整 profile 启动：' + LEAN_PATCH)
    }
    this.harness = new DeepSeekHarness(options)
    await this.harness.start()
    log('DSH 运行时已就绪：provider=' + PROVIDER + ' model=' + MODEL + ' cwd=' + this.workspace +
      ' 权限=' + childEnv().DSH_PERMISSION_MODE + ' 提示词=' + (this.lean && existsSync(LEAN_PATCH) ? 'lean' : 'full'))
    return this.harness
  }

  async run(sessionId, text) {
    const harness = await this.ensure()
    this.busy = true
    try {
      const result = await harness.run(text, { sessionId })
      return { finalResponse: result.finalResponse, usage: sumUsage(result.events) }
    } catch (err) {
      // 运行时子进程可能已退出：丢弃实例，下一条消息重新拉起。
      await this.harness.close().catch(() => {})
      this.harness = null
      throw err
    } finally {
      this.busy = false
      this.lastUsed = Date.now()
    }
  }

  async close() {
    const harness = this.harness
    this.harness = null
    if (harness) await harness.close().catch(() => {})
  }
}

const runtimes = new Map()

/** 取某个工作区的运行时；超过上限时关掉最久未用的空闲运行时。 */
async function runtimeFor(workspace) {
  let runtime = runtimes.get(workspace)
  // 提示词档位变了就重建：patch 是启动参数，热改不了。
  if (runtime !== undefined && runtime.lean !== leanProfile) {
    runtimes.delete(workspace)
    await runtime.close()
    runtime = undefined
  }
  if (runtime === undefined) {
    runtime = new DshRuntime(workspace, leanProfile)
    runtimes.set(workspace, runtime)
  }
  runtime.lastUsed = Date.now()
  if (runtimes.size > MAX_RUNTIMES) {
    const idle = [...runtimes.values()]
      .filter(candidate => candidate !== runtime && !candidate.busy)
      .sort((left, right) => left.lastUsed - right.lastUsed)
    while (runtimes.size > MAX_RUNTIMES && idle.length > 0) {
      const victim = idle.shift()
      runtimes.delete(victim.workspace)
      log('回收工作区运行时：' + victim.workspace)
      await victim.close()
    }
  }
  return runtime
}

/** 关掉所有空闲运行时（/profile 切换档位后回收，下一条消息用新档位重建）。 */
async function closeIdleRuntimes() {
  const idle = [...runtimes.values()].filter(runtime => !runtime.busy)
  for (const runtime of idle) runtimes.delete(runtime.workspace)
  await Promise.all(idle.map(runtime => runtime.close()))
  return idle.length
}

/** 关闭全部运行时。 */
async function closeAllRuntimes() {
  const all = [...runtimes.values()]
  runtimes.clear()
  await Promise.all(all.map(runtime => runtime.close()))
}

/**
 * 单个运行时用过的会话数超过上限就回收它，下一条消息重新拉起。
 * 预处理每回合都新建会话，这些会话连同上下文会一直留在运行时进程里，不回收会持续涨内存。
 */
async function recycleRuntimeIfNeeded(workspace) {
  const runtime = runtimes.get(workspace)
  if (!runtime || runtime.busy || runtime.started.size <= MAX_SESSIONS_PER_RUNTIME) return
  runtimes.delete(workspace)
  log('会话数达上限（' + runtime.started.size + '），回收运行时：' + workspace)
  await runtime.close()
}

/** 解析用户输入的路径：支持 ~ 与相对当前工作区。 */
function resolveWorkspacePath(raw, current) {
  const text = String(raw ?? '').trim().replace(/^"(.*)"$/, '$1')
  if (!text) return ''
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return resolve(homedir(), text.slice(2))
  return isAbsolute(text) ? resolve(text) : resolve(current, text)
}

/** 读 DSH 已登记的命名工作区（标题 + 路径），按标题排序；注册表缺失或格式不认识时返回空表。 */
function knownWorkspaces() {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(WORKSPACE_REGISTRY, 'utf8'))
  } catch {
    // 注册表不存在或不是 JSON：/ws 退回只按路径解析，不影响原有用法。
    return []
  }
  return Object.values(parsed?.tables?.workspaces ?? {})
    .filter(row => typeof row?.title === 'string' && typeof row?.path === 'string')
    .map(row => ({ title: row.title, path: resolve(row.path) }))
    .sort((a, b) => a.title.localeCompare(b.title, 'en'))
}

/** 按标题查注册表里的路径；标题唯一才认，找不到或重名返回空串（调用方再按路径解析）。 */
function resolveWorkspaceName(name) {
  const needle = String(name ?? '').trim().toLowerCase()
  if (!needle) return ''
  const hits = knownWorkspaces().filter(row => row.title.toLowerCase() === needle)
  return hits.length === 1 ? hits[0].path : ''
}

/** 用户当前工作区；目录已消失时回落到默认工作区。 */
function currentWorkspace(state, userId) {
  const workspace = state.workspaces[userId]
  return workspace && existsSync(workspace) ? workspace : AGENT_CWD
}

/** 会话 key：工作区不同就是不同会话，切回去能接着聊。 */
function sessionKey(userId, workspace) {
  return userId + '|' + workspace
}

/** 取（必要时创建）该用户在该工作区的会话；旧版单 key 会话迁移到默认工作区。 */
function ensureSession(state, userId, workspace) {
  const key = sessionKey(userId, workspace)
  if (!state.sessions[key]) {
    const legacy = state.sessions[userId]
    state.sessions[key] = legacy && workspace === AGENT_CWD ? legacy : 'wx-' + randomUUID().replaceAll('-', '')
  }
  return state.sessions[key]
}

/** 文件名安全化。 */
function slugify(text) {
  return String(text).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

/** 历史文件与嵌入缓存共用的目录分片。 */
function historySlugs(userId, workspace) {
  return {
    user: slugify(String(userId).split('@')[0] || 'user'),
    workspace: slugify(workspace.replace(/[:\\/]+/g, '-')) || 'default',
  }
}

/** 某个用户在工作区的历史记录文件（JSONL，一行一条）。 */
function historyPath(userId, workspace) {
  const slugs = historySlugs(userId, workspace)
  return join(HISTORY_DIR, slugs.user, slugs.workspace + '.jsonl')
}

/** 追加一条历史记录（用户消息或 Agent 回复）。 */
function appendHistory(userId, workspace, role, text) {
  try {
    const file = historyPath(userId, workspace)
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ ts: Date.now(), role, workspace, text: String(text).slice(0, 20000) }) + '\n')
  } catch (err) {
    log('写历史记录失败：' + String(err && err.message ? err.message : err))
  }
}

/** 读取最近 limit 轮的记录（一条用户消息 + 一条回复算一轮）；limit <= 0 表示整条时间线，不截断。 */
function readHistory(userId, workspace, limit) {
  const file = historyPath(userId, workspace)
  if (!existsSync(file)) return []
  const all = readFileSync(file, 'utf8').split('\n')
  const lines = limit > 0 ? all.slice(-limit * 3 - 5) : all
  const records = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // 跳过损坏行
    }
  }
  return limit > 0 ? records.slice(-limit * 2) : records
}

/** 新进程/新运行时接手续用旧会话时，把最近几轮历史带回上下文。 */
function replayPrefix(userId, workspace) {
  if (!(REPLAY_EXCHANGES > 0)) return ''
  const records = readHistory(userId, workspace, REPLAY_EXCHANGES)
  if (records.length === 0) return ''
  const lines = records.map(record => (record.role === 'user' ? '用户：' : '助手：') + String(record.text).replace(/\s+/g, ' ').slice(0, 400))
  let body = lines.join('\n')
  if (body.length > REPLAY_MAX_CHARS) body = body.slice(-REPLAY_MAX_CHARS)
  return '[以下是这个工作区之前的对话记录，用来恢复上下文]\n' + body + '\n[历史记录结束]\n\n'
}

/** 进程启动时已存在的会话：它们的历史需要回放，/new 新建的不需要。 */
const resumedSessions = new Set()

let stopping = false

/** 处理一条用户消息。 */
async function handleMessage(state, account, msg) {
  const userId = msg.from_user_id ?? ''
  const contextToken = msg.context_token
  if (!userId) return

  // 授权：配置了 WECHAT_ALLOW 时只认名单；否则第一个发消息的人自动配对。
  const allowed = ALLOW.length > 0 ? ALLOW.includes(userId) : state.paired.includes(userId)
  if (!allowed) {
    if (ALLOW.length === 0 && state.paired.length === 0) {
      state.paired.push(userId)
      saveState(state)
      log('已配对第一个微信用户：' + userId + '（后续只有该用户可用；如需多人请设置 WECHAT_ALLOW）')
      await sendText(account, userId, '已配对成功。直接把需求发给我即可，发送 /help 查看指令。', contextToken)
    } else {
      log('拒绝未授权用户：' + userId)
      await sendText(account, userId, '未授权：' + userId + '\n请让管理员把该 ID 加入 WECHAT_ALLOW。', contextToken)
    }
    return
  }

  const text = messageText(msg).trim()
  if (!text) {
    const mediaCount = (msg.item_list ?? []).filter(item => [2, 4, 5].includes(item.type)).length
    await sendText(account, userId, mediaCount > 0
      ? '我还没接住图片/文件（当前只处理文字与语音转写）。要我把本机文件发给你，发：/send <路径>'
      : '暂不支持该类型的消息，请发送文字。', contextToken)
    return
  }

  if (contextToken && state.contextTokens?.[userId] !== contextToken) {
    // 记下最新的会话票据：桥接进程外的发送（send-media.mjs、计划任务）要用它。
    state.contextTokens[userId] = contextToken
    saveState(state)
  }

  const workspace = currentWorkspace(state, userId)

  if (text === '/help') {
    await sendText(account, userId, HELP_TEXT, contextToken)
    return
  }
  if (text === '/pwd') {
    await sendText(account, userId, [
      '当前工作区：' + workspace,
      '该工作区会话：' + (state.sessions[sessionKey(userId, workspace)] ?? '(尚未创建)'),
    ].join('\n'), contextToken)
    return
  }
  if (text === '/ws' || text === '/ws list' || text === '/ws ls') {
    const known = knownWorkspaces()
    const previous = state.previousWorkspaces[userId]
    await sendText(account, userId, [
      '当前工作区：' + workspace,
      '该工作区会话：' + (state.sessions[sessionKey(userId, workspace)] ?? '(尚未创建)'),
      '上一个工作区：' + (previous && existsSync(previous) ? previous : '无'),
      known.length > 0
        ? 'DSH 已登记的工作区（' + known.length + '）：'
        : '读不到 DSH 工作区注册表（' + WORKSPACE_REGISTRY + '），只能按路径切换：',
      ...known.slice(0, MAX_WORKSPACE_LIST).map(row =>
        (row.path === workspace ? '* ' : '  ') + row.title + '  ' + row.path + (existsSync(row.path) ? '' : '（目录不存在）')),
      known.length > MAX_WORKSPACE_LIST ? '… 另有 ' + (known.length - MAX_WORKSPACE_LIST) + ' 个未显示' : '',
      '切换：/ws <名称|路径>（/ws+ 新建并切换，/ws - 返回上一个，/ls 看目录）',
    ].filter(Boolean).join('\n'), contextToken)
    return
  }
  if (text.startsWith('/ws+ ') || text.startsWith('/ws ') || text.startsWith('/cd ')) {
    const arg = text.replace(/^\/(ws\+|ws|cd)\s+/, '').trim()
    const from = currentWorkspace(state, userId)
    if (arg === '-') {
      const back = state.previousWorkspaces[userId]
      if (!back || !existsSync(back)) {
        await sendText(account, userId, '还没有可返回的上一个工作区。', contextToken)
        return
      }
      state.previousWorkspaces[userId] = from
      state.workspaces[userId] = back
      ensureSession(state, userId, back)
      saveState(state)
      await sendText(account, userId, '已切回工作区：' + back, contextToken)
      return
    }
    // 名称先查 DSH 工作区注册表；已存在的路径、以及 /ws+ 要新建的路径，仍按路径解析。
    const byPath = resolveWorkspacePath(arg, workspace)
    const target = byPath && existsSync(byPath) ? byPath : (resolveWorkspaceName(arg) || byPath)
    if (!target) {
      await sendText(account, userId, '用法：/ws <名称|路径>，例如 /ws wechat-todo、/ws D:\\work\\proj 或 /ws ~/proj', contextToken)
      return
    }
    if (!existsSync(target)) {
      if (!text.startsWith('/ws+ ')) {
        await sendText(account, userId, '目录不存在：' + target + '\n要新建并切过去就发：/ws+ ' + arg, contextToken)
        return
      }
      try {
        mkdirSync(target, { recursive: true })
      } catch (err) {
        await sendText(account, userId, '创建目录失败：' + String(err && err.message ? err.message : err), contextToken)
        return
      }
    } else if (!statSync(target).isDirectory()) {
      await sendText(account, userId, '不是目录：' + target, contextToken)
      return
    }
    if (from !== target) state.previousWorkspaces[userId] = from
    state.workspaces[userId] = target
    const switched = ensureSession(state, userId, target)
    saveState(state)
    await sendText(account, userId, [
      '已切换工作区：' + target,
      '该工作区的会话：' + switched,
      '（每个工作区独立上下文，切回去接着聊；/new 可清空当前工作区上下文）',
    ].join('\n'), contextToken)
    return
  }
  if (text === '/ls' || text.startsWith('/ls ')) {
    const arg = text.slice(3).trim()
    const target = arg ? resolveWorkspacePath(arg, workspace) : workspace
    if (!existsSync(target)) {
      await sendText(account, userId, '目录不存在：' + target, contextToken)
      return
    }
    let entries
    try {
      entries = readdirSync(target, { withFileTypes: true })
    } catch (err) {
      await sendText(account, userId, '读取目录失败：' + String(err && err.message ? err.message : err), contextToken)
      return
    }
    const shown = entries.slice(0, 60).map(entry => (entry.isDirectory() ? entry.name + '/' : entry.name))
    await sendText(account, userId, [
      target,
      shown.join('  ') || '(空目录)',
      entries.length > shown.length ? '…共 ' + entries.length + ' 项' : '',
    ].filter(Boolean).join('\n'), contextToken)
    return
  }
  if (text === '/send' || text.startsWith('/send ')) {
    const arg = text.slice(5).trim()
    if (!arg) {
      await sendText(account, userId, '用法：/send <路径>，例如 /send C:\\Users\\me\\Desktop\\shot.png\n图片（jpg/png/gif/webp/bmp）直接显示，其他类型作为文件发送。', contextToken)
      return
    }
    const target = resolveWorkspacePath(arg, workspace)
    if (!existsSync(target) || !statSync(target).isFile()) {
      await sendText(account, userId, '文件不存在：' + target, contextToken)
      return
    }
    try {
      await sendMedia(account, userId, target, contextToken)
    } catch (err) {
      await sendText(account, userId, '发送失败：' + String(err && err.message ? err.message : err).slice(0, 300), contextToken)
    }
    return
  }
  if (text === '/history' || text.startsWith('/history ')) {
    const limit = Math.min(Math.max(Number(text.slice(8).trim()) || 10, 1), 50)
    const records = readHistory(userId, workspace, limit)
    if (records.length === 0) {
      await sendText(account, userId, '这个工作区还没有历史记录。\n记录文件：' + historyPath(userId, workspace), contextToken)
      return
    }
    const lines = records.map(record => (record.role === 'user' ? '你：' : '我：') + String(record.text).replace(/\s+/g, ' ').slice(0, 300))
    await sendText(account, userId, lines.join('\n\n') + '\n\n（完整记录：' + historyPath(userId, workspace) + '）', contextToken)
    return
  }
  if (text === '/new') {
    const key = sessionKey(userId, workspace)
    state.sessions[key] = 'wx-' + randomUUID().replaceAll('-', '')
    // 预处理靠历史挑选上下文，所以 /new 必须同时划一条时间线，否则旧话题会被重新塞回来。
    state.preprocessSince[key] = Date.now()
    saveState(state)
    await sendText(account, userId, '已在该工作区开启新会话：' + state.sessions[key] + '\n工作区：' + workspace, contextToken)
    return
  }
  if (text === '/pre' || text.startsWith('/pre ') || text.startsWith('/pre[')) {
    const arg = bareArg(text, '/pre')
    // 认不出的参数当场回用法：漏给模型的话，它没有这个指令，只会回一句「我没有 /pre」。
    if (arg !== '' && arg !== 'status' && arg !== 'on' && arg !== 'off') {
      await sendText(account, userId, '没看懂这个用法：' + text +
        '\n用法：/pre on 开启，/pre off 关闭，/pre 看状态（帮助里的方括号可带可不带）。', contextToken)
      return
    }
    if (arg === 'on' || arg === 'off') {
      state.preprocess = arg === 'on'
      saveState(state)
    }
    const info = preprocessInfo()
    const scoring = info.embedProvider === null || info.embedProvider === 'lexical'
    const embedLine = info.embedProvider === 'local' ? info.localModel + '（进程内 ONNX）'
      : info.embedProvider === 'ollama' ? info.ollamaModel + ' @ ' + info.ollamaUrl
        : state.preprocess === false ? '（已关闭，未预热）'
          : info.embedProvider === null ? '预热中' : '词面相似度（本地模型与 Ollama 都不可用，判断更粗）'
    const genLine = state.preprocess === false ? '（已关闭，未预热）'
      : info.genProvider === 'local' ? info.genModel + '（进程内 ONNX，整段对话输入）'
        : info.genProvider === 'ollama' ? info.ollamaGenModel + ' @ ' + info.ollamaUrl
          : info.genDetail
    await sendText(account, userId, [
      '本地预处理：' + (state.preprocess === false ? '已关闭（每回合沿用同一个持久会话）' : '已开启（每回合新会话，只带选中的历史）'),
      '判定器 A（嵌入，逐轮余弦）：' + embedLine + (info.embedProvider === 'local' ? '｜' + info.embedDetail : ''),
      '判定器 B（生成式，整段对话）：' + genLine,
      '两者取并集；B 不能凭空引入 A 判为无关的轮次',
      '阈值：相关 ≥ ' + (scoring ? info.lowLexical : info.low) + '，选中某轮 ≥ ' + (scoring ? info.keepLexical : info.keep),
      '模型缓存：' + info.cacheDir,
      '用法：/pre on 开启，/pre off 关闭；/pre 看状态',
    ].join('\n'), contextToken)
    return
  }

  if (text === '/profile' || text.startsWith('/profile ') || text.startsWith('/profile[')) {
    const arg = bareArg(text, '/profile')
    if (arg !== '' && arg !== 'lean' && arg !== 'full') {
      await sendText(account, userId, '没看懂这个用法：' + text +
        '\n用法：/profile lean 省 token；/profile full 开回截图与桌面操作；/profile 看当前档位。', contextToken)
      return
    }
    let note = '当前档位未变。'
    if (arg === 'lean' || arg === 'full') {
      if ((arg === 'lean') === leanProfile) {
        note = '已经是这个档位。'
      } else {
        leanProfile = arg === 'lean'
        state.leanProfile = leanProfile
        saveState(state)
        note = '已切换档位，回收空闲运行时 ' + (await closeIdleRuntimes()) + ' 个；下一条消息用新档位重建。'
      }
    }
    await sendText(account, userId, [
      '提示词档位：' + (leanProfile
        ? 'lean —— 禁用 computer-use 工具组，固定提示词约 11.4k tokens（实测 38.2k → 11.4k）'
        : 'full —— 含截图/桌面操作工具，固定提示词约 38.4k tokens'),
      '补丁文件：' + LEAN_PATCH + (existsSync(LEAN_PATCH) ? '' : '（缺失，实际按 full 启动）'),
      note,
      '用法：/profile lean 省 token；/profile full 把截图与桌面操作能力开回来。',
    ].join('\n'), contextToken)
    return
  }

  if (text === '/status') {
    await sendText(account, userId, [
      '工作区：' + workspace,
      '会话：' + (state.sessions[sessionKey(userId, workspace)] ?? '(尚未创建)'),
      '模型：' + PROVIDER + ' / ' + MODEL,
      '权限：' + PERMISSION_MODE,
      '提示词档位：' + (leanProfile ? 'lean' : 'full'),
      '活跃运行时：' + runtimes.size + ' / ' + MAX_RUNTIMES,
      '历史记录：' + historyPath(userId, workspace),
      '运行时长：' + Math.round((Date.now() - startedAt) / 60000) + ' 分钟',
    ].join('\n'), contextToken)
    return
  }

  // 预处理开启时每回合都用新会话：上下文完全由本地小模型挑选，不再累积。
  // 关闭时沿用原来的持久会话（重启/回收后靠历史回放续上）。
  const preprocessOn = state.preprocess !== false
  let sessionId
  let prefix = ''
  let preNote = ''
  if (preprocessOn) {
    let analysis = null
    try {
      const slugs = historySlugs(userId, workspace)
      // /new 之后只拿新划的那条线之后的记录参与判定。
      const since = state.preprocessSince?.[sessionKey(userId, workspace)] ?? 0
      analysis = await analyzeContext({
        records: readHistory(userId, workspace, PRE_SELECT_RECORDS).filter(record => (record.ts ?? 0) > since),
        message: text,
        cacheFile: embeddingCacheFile(HISTORY_DIR, slugs.user, slugs.workspace),
      })
    } catch (err) {
      log('预处理失败，按不带历史处理：' + String(err && err.message ? err.message : err))
    }
    sessionId = 'wx-' + randomUUID().replaceAll('-', '')
    state.sessions[sessionKey(userId, workspace)] = sessionId
    prefix = analysis?.context ?? ''
    preNote = analysis
      ? '（预处理：' + analysis.digest + '；判定器 ' + analysis.source + '；最高相似度 ' + analysis.best + '）'
      : '（预处理：判定失败，未带历史）'
  } else {
    sessionId = ensureSession(state, userId, workspace)
  }
  saveState(state)

  await sendText(account, userId, '收到，正在处理…', contextToken)
  await setTyping(account, userId, contextToken, 1)
  const keepalive = setInterval(() => { void setTyping(account, userId, contextToken, 1) }, TYPING_KEEPALIVE_MS)
  try {
    const runtime = await runtimeFor(workspace)
    // 会话是启动前就存在的、而这个运行时实例还没用过它：先回放最近几轮历史，续上上下文。
    const needsReplay = !preprocessOn && resumedSessions.has(sessionId) && !runtime.started.has(sessionId)
    runtime.started.add(sessionId)
    appendHistory(userId, workspace, 'user', text)
    const outcome = await runtime.run(sessionId, prefix + (needsReplay ? replayPrefix(userId, workspace) : '') + text)
    // 回复里可以是纯文本，也可以夹带 `MEDIA:<路径>` 行让桥接把本机文件当附件发出去。
    const { text: replyText, files } = extractMediaLines(outcome.finalResponse, workspace)
    // 历史里不带 token 脚注与预处理说明：它们是给微信看的，回放时白占上下文。
    appendHistory(userId, workspace, 'assistant', replyText + files.map(file => '\nMEDIA:' + file).join(''))
    const note = replyText && PREPROCESS_NOTIFY && preprocessOn ? '\n\n' + preNote : ''
    const body = (replyText + note + tokenFooter(outcome.usage)).trim()
    if (body || files.length === 0) {
      await sendText(account, userId, body || '(模型没有返回文本结果)', contextToken)
    }
    for (const file of files) {
      try {
        await sendMedia(account, userId, file, contextToken)
      } catch (err) {
        log('发送附件失败 ' + file + '：' + String(err && err.message ? err.message : err))
        await sendText(account, userId, '附件发送失败：' + file + '\n' + String(err && err.message ? err.message : err).slice(0, 200), contextToken)
      }
    }
  } catch (err) {
    log('处理失败 user=' + userId + '：' + String(err && err.stack ? err.stack : err))
    const message = String(err && err.message ? err.message : err).slice(0, 300)
    await sendText(account, userId, '处理失败：' + message, contextToken).catch(() => {})
  } finally {
    clearInterval(keepalive)
    await setTyping(account, userId, contextToken, 2)
    await recycleRuntimeIfNeeded(workspace)
  }
}

/** 长轮询主循环。 */
async function monitor(state, account) {
  let buf = state.syncBuf ?? ''
  let timeoutMs = LONG_POLL_MS
  let failures = 0
  while (!stopping) {
    let resp
    try {
      resp = await api('ilink/bot/getupdates', {
        base: account.baseUrl,
        token: account.token,
        body: { get_updates_buf: buf, base_info: baseInfo() },
        timeoutMs,
      })
    } catch (err) {
      if (String(err && err.name) === 'AbortError') continue
      failures += 1
      log('getupdates 失败（' + failures + ' 次）：' + String(err && err.message ? err.message : err))
      await sleep(Math.min(30000, 2000 * failures))
      continue
    }
    failures = 0
    if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
      if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
        log('登录态已失效（errcode -14）。请在电脑上重新执行 node bridge.mjs --login，然后重启本进程。')
        await sleep(10 * 60 * 1000)
        continue
      }
      log('getupdates 返回错误：ret=' + resp.ret + ' errcode=' + resp.errcode + ' ' + (resp.errmsg ?? ''))
      await sleep(3000)
      continue
    }
    if (resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms
    if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
      buf = resp.get_updates_buf
      state.syncBuf = buf
      saveState(state)
    }
    for (const msg of resp.msgs ?? []) {
      if (msg.message_type !== 1) continue // 只处理用户发来的消息
      const userId = msg.from_user_id ?? ''
      void enqueue(userId, () => handleMessage(state, account, msg)).catch(() => {})
    }
  }
}

/** 自检一：DSH 运行时能否启动（不连接微信）。 */
async function checkDsh() {
  log('检查 SDK 客户端：' + SDK_CLIENT)
  if (!existsSync(SDK_CLIENT)) {
    log('缺少 SDK 客户端构建产物，请先执行 pnpm run build:lib')
    process.exitCode = 1
    return
  }
  const env = childEnv()
  log('DEEPSEEK_API_KEY：' + (env.DEEPSEEK_API_KEY ? '已设置' : '未设置（真正对话前必须设置）'))
  log('权限模式：' + env.DSH_PERMISSION_MODE + '（工作区：' + AGENT_CWD + '）')
  const runtime = await runtimeFor(AGENT_CWD)
  await runtime.ensure()
  if (env.DEEPSEEK_API_KEY) {
    log('发起一次测试对话…')
    const reply = await runtime.run('wx-check-' + Date.now(), '用一句话回答：桥接自检成功。')
    log('模型回复：' + JSON.stringify(reply.finalResponse) + ' 用量：' + JSON.stringify(reply.usage))
  }
  await closeAllRuntimes()
  log('DSH 自检完成。')
}

/** 自检二：iLink 是否可达（不登录）。 */
async function checkWechat() {
  const qr = await api('ilink/bot/get_bot_qrcode?bot_type=' + encodeURIComponent(BOT_TYPE), { body: { local_token_list: [] } })
  log('iLink 可达，已获取二维码会话：' + Boolean(qr.qrcode))
  log('二维码链接：' + (qr.qrcode_img_content ?? '(无)'))
  log('（本次未扫码，二维码会自行过期）')
}

/** 自检三：媒体通道——用已保存的登录态，把一个本机文件发给已配对的微信用户。 */
async function checkMedia(filePath) {
  const state = loadState()
  if (!state.account?.token) throw new Error('尚未登录：先运行 node bridge.mjs --login')
  const to = ALLOW[0] || state.paired[0] || state.account.userId
  if (!to) throw new Error('没有已配对用户：先用微信给机器人发一条消息完成配对')
  if (!filePath) throw new Error('用法：node bridge.mjs --check-media <文件路径>')
  const target = resolve(filePath)
  if (!existsSync(target)) throw new Error('文件不存在：' + target)
  log('媒体自检：发给 ' + to + '，文件 ' + target)
  await sendMedia(state.account, to, target, state.contextTokens?.[to] ?? '')
  log('媒体自检完成。')
}

/** 自检四：DSH 工作区注册表能否读到、名称能否解析（不连微信、不起 dsh 子进程）。 */
function checkWorkspaces() {
  log('工作区注册表：' + WORKSPACE_REGISTRY + (existsSync(WORKSPACE_REGISTRY) ? '' : '（读不到）'))
  const known = knownWorkspaces()
  log('已登记的工作区：' + known.length + ' 个')
  for (const row of known) log('  ' + row.title + '  ->  ' + row.path + (existsSync(row.path) ? '' : '（目录不存在）'))
  for (const name of process.argv.slice(2).filter(arg => !arg.startsWith('--'))) {
    log('按名称解析 ' + name + ' -> ' + (resolveWorkspaceName(name) || '(未登记，会当作路径)'))
  }
  log('默认工作区（DSH_CWD）：' + AGENT_CWD)
}

async function main() {
  // 档位先落定：--check 分支也要用它。
  leanProfile = loadState().leanProfile ?? LEAN_PROFILE_DEFAULT
  if (MODE === 'check') return checkDsh()
  if (MODE === 'check-wechat') return checkWechat()
  if (MODE === 'check-media') {
    const args = process.argv.slice(2)
    return checkMedia(args[args.indexOf('--check-media') + 1] ?? '')
  }
  if (MODE === 'check-workspaces') return checkWorkspaces()

  mkdirSync(STATE_DIR, { recursive: true })
  const state = loadState()
  // 启动前就存在的会话：它们在新进程里需要历史回放，/new 之后新建的不需要。
  for (const id of Object.values(state.sessions)) resumedSessions.add(id)
  if (MODE === 'login' || !state.account || !state.account.token) {
    state.account = await qrLogin()
    state.syncBuf = ''
    saveState(state)
  }
  const account = state.account
  startedAt = Date.now()
  log('微信账号：' + account.botId + '，接入点：' + account.baseUrl)
  log('允许的用户：' + (ALLOW.length ? ALLOW.join(', ') : state.paired.length ? state.paired.join(', ') : '(第一个发消息的用户将自动配对)'))
  // 预处理判定器后台预热（首次会下模型），不阻塞消息处理；关闭预处理时不做任何动作。
  if (state.preprocess !== false) warmupPreprocess(log)
  log('提示词档位：' + (leanProfile ? 'lean（禁用 computer-use，固定提示词约 11.4k tokens）' : 'full（约 38.2k tokens）'))
  log('开始监听微信消息，Ctrl+C 退出。')

  const shutdown = async () => {
    if (stopping) return
    stopping = true
    log('正在退出…')
    await closeAllRuntimes()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await monitor(state, account)
}

// 崩溃留痕：未捕获异常与未处理的 Promise 拒绝显式写进日志（stdout/stderr 由 run-bridge.ps1
// 汇总到 bridge.log），并以非零码退出，让计划任务的看门狗在下一个周期把它拉起来。
process.on('uncaughtException', error => {
  log('未捕获异常（进程退出）：' + String(error && error.stack ? error.stack : error))
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  log('未处理的 Promise 拒绝（进程退出）：' + String(reason && reason.stack ? reason.stack : reason))
  process.exit(1)
})

main().catch(err => {
  log('启动失败：' + String(err && err.stack ? err.stack : err))
  process.exit(1)
})
