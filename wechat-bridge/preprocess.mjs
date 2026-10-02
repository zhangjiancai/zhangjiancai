#!/usr/bin/env node
/**
 * 微信桥接的本地预处理层：在消息进 DSH 之前，先在本机判断它跟已有对话的关系。
 *
 * 目的：省 token。桥接每回合都把上下文重发给模型，会话越长越贵。这一层先做一次极便宜的
 * 判断，并挑出真正相关的那几轮：
 *
 *   无关  -> 当成新会话（等价于 /new），不带任何历史
 *   有关  -> 只把相关的那几轮作为上下文前缀发过去
 *
 * 判定单元始终是「一轮问答」——用户那句话和它对应的回复绑成一个整体，判定、编码、
 * 选中、回放都以这个整体为单位，不拆开。
 *
 * 两条判定路径并行、结果取并集：
 *
 *   gen     方案 B：把**整段对话**当作一次输入交给本机小模型，让它直接指出与当前问题
 *           相关的轮次编号。能处理指代和跨轮关联（「刚才那个」「把前面说的两件事一起」）。
 *   embed   方案 A：每一轮问答整体编码成一个向量，与当前问题算余弦。快、稳、可缓存。
 *
 * 两条都给出结果时取并集（召回优先）；只有一条可用就只用那条；都不可用落到词面。
 * 每一级都在后台预热，不阻塞消息处理，预热期间自动走下一级。
 *
 * 关掉这一层：微信里发 `/pre off`（或设 WECHAT_PREPROCESS=0）。
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const OLLAMA_URL = (process.env.WECHAT_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
const OLLAMA_MODEL = process.env.WECHAT_PRE_MODEL ?? 'all-minilm'
const OLLAMA_GEN_MODEL = process.env.WECHAT_PRE_OLLAMA_GEN_MODEL ?? 'qwen2.5:3b'

/**
 * 进程内 ONNX 嵌入模型（方案 A）。默认从 hf-mirror 拉，国内可达；换回官方源设 WECHAT_PRE_MODEL_HOST=https://huggingface.co。
 *
 * 用多语言版而不是 all-MiniLM-L6-v2：后者是英文模型，中文句子的基线相似度高达 0.5，
 * 相关的 0.54、无关的 0.50，基本没有区分度（实测）。多语言版对同样的用例给出
 * 相关 0.42~0.83、无关 ≤0.06，阈值才好定。代价是首次要下 ~120 MB。
 */
const LOCAL_MODEL = process.env.WECHAT_PRE_LOCAL_MODEL ?? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
const LOCAL_MODEL_HOST = process.env.WECHAT_PRE_MODEL_HOST ?? 'https://hf-mirror.com'
const LOCAL_ENABLED = (process.env.WECHAT_PRE_LOCAL ?? '1') !== '0'
const MODEL_CACHE_DIR = process.env.WECHAT_PRE_CACHE_DIR ?? join(homedir(), '.dsh', 'models')
const WARMUP_TIMEOUT_MS = Number(process.env.WECHAT_PRE_WARMUP_TIMEOUT_MS ?? 120000)

/**
 * 进程内 ONNX 生成式模型（方案 B）。它要读完一整段对话再吐轮次编号，需要指令跟随能力，
 * 用 Qwen2.5-0.5B-Instruct（q8 约 490 MB）。q4f16 更小但 CPU 上不稳，q8 是 CPU 上稳妥的选择。
 */
const GEN_ENABLED = (process.env.WECHAT_PRE_GEN ?? '1') !== '0'
const GEN_MODEL = process.env.WECHAT_PRE_GEN_MODEL ?? 'onnx-community/Qwen2.5-0.5B-Instruct'
const GEN_DTYPE = process.env.WECHAT_PRE_GEN_DTYPE ?? 'q8'
const GEN_MAX_NEW_TOKENS = Number(process.env.WECHAT_PRE_GEN_MAX_TOKENS ?? 32)
/** 交给生成式模型的对话正文上限（字符）。超出时保留最近的轮次，并在结果里标明截断。 */
const GEN_MAX_CHARS = Number(process.env.WECHAT_PRE_GEN_MAX_CHARS ?? 16000)
/** 交给生成式模型的单轮上限（字符）。 */
const GEN_TURN_CHARS = Number(process.env.WECHAT_PRE_GEN_TURN_CHARS ?? 800)
const GEN_TIMEOUT_MS = Number(process.env.WECHAT_PRE_GEN_TIMEOUT_MS ?? 180000)
/** 生成式模型的预热上限单独一套：首次要下 ~490 MB（更大的模型更多），不能用单次推理的超时。 */
const GEN_WARMUP_TIMEOUT_MS = Number(process.env.WECHAT_PRE_GEN_WARMUP_TIMEOUT_MS ?? 1800000)

/** 低于 LOW 判为「新话题」；高于 KEEP 的历史轮次才会被选中。阈值按默认多语言模型的实测分布定：相关 0.42~0.83，无关 ≤0.06。 */
const LOW = Number(process.env.WECHAT_PRE_LOW ?? 0.30)
const KEEP = Number(process.env.WECHAT_PRE_KEEP ?? 0.45)
/** 词面降级路径的阈值（量纲不同，单独一套）。 */
const LOW_LEX = Number(process.env.WECHAT_PRE_LOW_LEXICAL ?? 0.06)
const KEEP_LEX = Number(process.env.WECHAT_PRE_KEEP_LEXICAL ?? 0.10)

/** 选中轮次上限；0 表示不限（默认：判定输入是整个对话，选中多少就带多少）。 */
const MAX_ENTRIES = Number(process.env.WECHAT_PRE_MAX_ENTRIES ?? 0)
/**
 * 生成式判定的准入闸门。默认 `embed`：只接受嵌入判定器认为至少沾边（相似度 >= 相关阈值）的轮次，
 * 不允许生成式判定凭空引入嵌入判定器判为无关的轮次。
 *
 * 实测依据：0.5B/1.5B 的小模型做这个任务假阳性很重——「今天中午吃什么」会被判成与第 1 轮相关，
 * 纯并集把嵌入判定器本来正确的 9/9 拖到 4/9。闸门让小模型只能做「提升」不能做「引入」。
 * 设 WECHAT_PRE_GEN_GATE=none 恢复纯并集（换用足够强的生成模型时才建议这么做）。
 */
const GEN_GATE = (process.env.WECHAT_PRE_GEN_GATE ?? 'embed') !== 'none'
/** 回放前缀的总字数上限，以及单轮字数上限。 */
const MAX_CHARS = Number(process.env.WECHAT_PRE_MAX_CHARS ?? 8000)
const TURN_CHARS = Number(process.env.WECHAT_PRE_TURN_CHARS ?? 600)
const EMBED_TIMEOUT_MS = Number(process.env.WECHAT_PRE_TIMEOUT_MS ?? 5000)
const VEC_CACHE_LIMIT = Number(process.env.WECHAT_PRE_CACHE_LIMIT ?? 2000)

/** 方案 A 的判定器：`local` / `ollama` / `lexical`；null 表示还在预热。 */
let embedProvider = null
let embedDetail = '预热中'
/** 方案 B 的判定器：`local` / `ollama`；null 表示不可用或还在预热。 */
let genProvider = null
let genDetail = '预热中'
let warmupStarted = false

/** 供 `/pre status` 展示的配置与当前状态。 */
export function preprocessInfo() {
  return {
    embedProvider,
    embedDetail,
    genProvider,
    genDetail,
    localModel: LOCAL_MODEL,
    localHost: LOCAL_MODEL_HOST,
    genModel: GEN_MODEL,
    genDtype: GEN_DTYPE,
    genMaxChars: GEN_MAX_CHARS,
    ollamaModel: OLLAMA_MODEL,
    ollamaGenModel: OLLAMA_GEN_MODEL,
    ollamaUrl: OLLAMA_URL,
    low: LOW,
    keep: KEEP,
    lowLexical: LOW_LEX,
    keepLexical: KEEP_LEX,
    maxEntries: MAX_ENTRIES,
    maxChars: MAX_CHARS,
    turnChars: TURN_CHARS,
    cacheDir: MODEL_CACHE_DIR,
  }
}

/** 文本指纹，用作嵌入缓存键。 */
function fingerprint(text) {
  return createHash('sha1').update(text).digest('hex')
}

/** 余弦相似度；零向量返回 0。 */
function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb)
}

/** 字符二元组 + 拉丁单词集合，用于零依赖的词面相似度。 */
function shingles(text) {
  const normalized = String(text).toLowerCase().replace(/\s+/g, ' ').trim()
  const set = new Set()
  for (const word of normalized.match(/[a-z0-9_]{2,}/g) ?? []) set.add('w:' + word)
  const compact = normalized.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
  for (let i = 0; i + 2 <= compact.length; i += 1) set.add('g:' + compact.slice(i, i + 2))
  return set
}

/** 词面相似度：Jaccard。 */
function lexicalScore(a, b) {
  const sa = shingles(a)
  const sb = shingles(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let hit = 0
  for (const item of sa) if (sb.has(item)) hit += 1
  return hit / (sa.size + sb.size - hit)
}

/** 进程内 ONNX 嵌入管道，首次调用时加载模型（预热阶段完成）。 */
let embedPipeline = null
async function localEmbed(texts) {
  if (!embedPipeline) {
    const mod = await import('@huggingface/transformers')
    mod.env.cacheDir = MODEL_CACHE_DIR
    mod.env.remoteHost = LOCAL_MODEL_HOST
    mod.env.allowRemoteModels = true
    // dtype q8 对应 model_quantized.onnx，与旧版缓存里的文件名一致，沿用已下载的 120 MB。
    embedPipeline = await mod.pipeline('feature-extraction', LOCAL_MODEL, { dtype: 'q8' })
  }
  const output = await embedPipeline(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}

/** Ollama 是否在线且已经拉过该嵌入模型。 */
async function ollamaEmbed(texts) {
  const res = await fetch(OLLAMA_URL + '/api/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('ollama /api/embed HTTP ' + res.status)
  const body = await res.json()
  const vectors = body.embeddings ?? []
  if (vectors.length !== texts.length) throw new Error('ollama 返回的向量数量与请求不一致')
  return vectors
}

/** 进程内 ONNX 生成式管道，首次调用时加载模型。 */
let genPipeline = null
async function localGenerate(prompt) {
  if (!genPipeline) {
    const mod = await import('@huggingface/transformers')
    mod.env.cacheDir = MODEL_CACHE_DIR
    mod.env.remoteHost = LOCAL_MODEL_HOST
    mod.env.allowRemoteModels = true
    genPipeline = await mod.pipeline('text-generation', GEN_MODEL, { dtype: GEN_DTYPE })
  }
  const output = await genPipeline([{ role: 'user', content: prompt }], {
    max_new_tokens: GEN_MAX_NEW_TOKENS,
    do_sample: false,
    return_full_text: false,
  })
  // chat 输入下 generated_text 是消息数组（含输入），新增的那条在末尾。
  const generated = output?.[0]?.generated_text
  if (typeof generated === 'string') return generated
  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1]
    return typeof last === 'string' ? last : (last?.content ?? '')
  }
  return generated?.content ?? ''
}

/** Ollama 上的生成式判定。 */
async function ollamaGenerate(prompt) {
  const res = await fetch(OLLAMA_URL + '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_GEN_MODEL, prompt, stream: false, options: { temperature: 0 } }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error('ollama /api/generate HTTP ' + res.status)
  const body = await res.json()
  return body.response ?? ''
}

/**
 * 后台预热两个判定器，各自独立、互不阻塞。
 * gen 首次要下 ~490 MB，embed 首次要下 ~120 MB，都在这里后台完成；
 * 预热期间到达的消息自动走已经就绪的那一级或词面路径。
 */
export function warmupPreprocess(log = () => {}) {
  if (warmupStarted) return
  warmupStarted = true
  const probe = '预处理预热'
  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('预热超时')), ms)),
  ])

  void (async () => {
    if (LOCAL_ENABLED) {
      try {
        const started = Date.now()
        await withTimeout(localEmbed([probe]), WARMUP_TIMEOUT_MS)
        embedProvider = 'local'
        embedDetail = LOCAL_MODEL + '（' + Math.round((Date.now() - started) / 100) / 10 + 's 就绪）'
        log('嵌入判定器就绪：' + embedDetail)
        return
      } catch (err) {
        log('本地 ONNX 嵌入模型不可用（' + String(err && err.message ? err.message : err).slice(0, 120) + '），改用 Ollama')
      }
    }
    try {
      await withTimeout(ollamaEmbed([probe]), EMBED_TIMEOUT_MS)
      embedProvider = 'ollama'
      embedDetail = OLLAMA_MODEL + ' @ ' + OLLAMA_URL
      log('嵌入判定器就绪：' + embedDetail)
    } catch (err) {
      embedProvider = 'lexical'
      embedDetail = '词面相似度（本地模型与 Ollama 都不可用）'
      log('嵌入判定降级为词面相似度：' + String(err && err.message ? err.message : err).slice(0, 120))
    }
  })()

  void (async () => {
    if (GEN_ENABLED) {
      try {
        const started = Date.now()
        await withTimeout(localGenerate('你好'), GEN_WARMUP_TIMEOUT_MS)
        genProvider = 'local'
        genDetail = GEN_MODEL + '（' + Math.round((Date.now() - started) / 100) / 10 + 's 就绪，整段对话输入）'
        log('生成式判定器就绪：' + genDetail)
        return
      } catch (err) {
        log('本地生成式模型不可用（' + String(err && err.message ? err.message : err).slice(0, 120) + '），试 Ollama')
      }
    }
    try {
      await withTimeout(ollamaGenerate('你好'), GEN_TIMEOUT_MS)
      genProvider = 'ollama'
      genDetail = OLLAMA_GEN_MODEL + ' @ ' + OLLAMA_URL
      log('生成式判定器就绪：' + genDetail)
    } catch (err) {
      genProvider = null
      genDetail = '不可用（本地生成式模型与 Ollama 都无法使用，判定只用嵌入）'
      log('生成式判定不可用：' + String(err && err.message ? err.message : err).slice(0, 120))
    }
  })()
}

/** 读嵌入缓存（按文本指纹索引）。 */
function loadCache(cacheFile) {
  if (!existsSync(cacheFile)) return {}
  try {
    return JSON.parse(readFileSync(cacheFile, 'utf8'))
  } catch {
    return {}
  }
}

/** 原子写嵌入缓存，超限时丢掉最早的键（对象保留插入顺序）。 */
function saveCache(cacheFile, cache) {
  const keys = Object.keys(cache)
  if (keys.length > VEC_CACHE_LIMIT) {
    for (const key of keys.slice(0, keys.length - VEC_CACHE_LIMIT)) delete cache[key]
  }
  mkdirSync(dirname(cacheFile), { recursive: true })
  const tmp = cacheFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(cache))
  renameSync(tmp, cacheFile)
}

/**
 * 批量取嵌入向量，命中缓存的直接复用。
 * @returns 与 texts 等长的向量数组；无可用判定器时返回 null（调用方转词面路径）。
 */
async function embedTexts(texts, { cacheFile }) {
  if (embedProvider !== 'local' && embedProvider !== 'ollama') return null
  const cache = loadCache(cacheFile)
  const missing = []
  const result = texts.map(text => {
    const hit = cache[fingerprint(text)]
    if (hit) return hit
    missing.push(text)
    return null
  })

  if (missing.length > 0) {
    const vectors = embedProvider === 'local' ? await localEmbed(missing) : await ollamaEmbed(missing)
    let cursor = 0
    for (let i = 0; i < result.length; i += 1) {
      if (result[i] !== null) continue
      result[i] = vectors[cursor]
      cache[fingerprint(missing[cursor])] = vectors[cursor]
      cursor += 1
    }
    saveCache(cacheFile, cache)
  }
  return result
}

/** 把历史记录按「一问一答」切成轮次；连续的用户消息各自成轮。 */
function toExchanges(records) {
  const exchanges = []
  for (const record of records) {
    const last = exchanges[exchanges.length - 1]
    if (record.role === 'user' || last === undefined || last.assistant !== undefined) {
      exchanges.push({ user: record, assistant: undefined })
    } else {
      last.assistant = record
    }
  }
  return exchanges
}

/** 一轮问答的整体文本。判定、编码、渲染都走这里，保证问题和对应的回答不被拆开。 */
function turnText(exchange) {
  const user = String(exchange.user?.text ?? '')
  const assistant = String(exchange.assistant?.text ?? '')
  return assistant ? user + '\n' + assistant : user
}

/** 单条刷成一行、截断，避免回放被长回复撑爆。 */
function clip(text, limit = TURN_CHARS) {
  return String(text).replace(/\s+/g, ' ').slice(0, limit)
}

/**
 * 把选中的轮次渲染成回放前缀。
 * @returns `{ text, chars, truncated }`；`truncated` 为真表示内容被字数上限截掉了。
 */
function renderContext(exchanges) {
  const lines = []
  for (const exchange of exchanges) {
    lines.push('用户：' + clip(exchange.user?.text))
    if (exchange.assistant) lines.push('助手：' + clip(exchange.assistant.text))
  }
  let body = lines.join('\n')
  const truncated = body.length > MAX_CHARS
  if (truncated) body = body.slice(-MAX_CHARS)
  return {
    text: '[以下是这个工作区之前的对话记录，用来恢复上下文]\n' + body + '\n[历史记录结束]\n\n',
    chars: body.length,
    truncated,
  }
}

/**
 * 「接着说上一轮」的信号词。这类消息往往词面相似度极低（甚至只有一个「继续」），
 * 但最新一轮上下文必不可少，所以单独兜底。
 */
const CONTINUE_CUE = /(继续|接着|然后呢|下一步|刚才的|上面那个|再说说|再来一次|继续吧)/
/** 消息很短且带承接信号时，按「相关」处理并带上最新一轮。 */
function looksLikeContinuation(message) {
  const text = String(message).trim()
  return text.length <= 16 && CONTINUE_CUE.test(text)
}

/** 生成式判定器的提示词。整段对话一次性交给模型，轮次编号从 1 开始。 */
function buildGenPrompt(exchanges, message) {
  const lines = []
  for (let i = 0; i < exchanges.length; i += 1) {
    lines.push('[' + (i + 1) + '] 用户：' + clip(exchanges[i].user?.text, GEN_TURN_CHARS))
    if (exchanges[i].assistant) lines.push('    助手：' + clip(exchanges[i].assistant.text, GEN_TURN_CHARS))
  }
  let body = lines.join('\n')
  let truncated = false
  if (body.length > GEN_MAX_CHARS) {
    // 超长时保留最近的部分：新问题更可能指代近期内容。
    body = body.slice(-GEN_MAX_CHARS)
    truncated = true
  }
  return {
    prompt: [
      '你是对话检索助手。下面是一整段对话，每轮问答用 [编号] 标出。',
      '用户提出了一个新问题。请找出哪些轮次与这个新问题相关。',
      '只输出相关轮次的编号，用英文逗号分隔，例如：1,3',
      '一个都不相关就只输出：无',
      '不要输出编号以外的任何内容，不要解释。',
      '',
      '对话：',
      body,
      '',
      '新问题：' + message,
      '相关轮次：',
    ].join('\n'),
    truncated,
  }
}

/** 从模型输出里解析轮次编号，越界的丢弃。 */
function parseGenSelection(raw, total) {
  const body = String(raw).split(/相关轮次[:：]/).pop() ?? ''
  const picked = new Set()
  for (const match of body.matchAll(/\d+/g)) {
    const n = Number(match[0])
    if (n >= 1 && n <= total) picked.add(n)
  }
  return [...picked].sort((a, b) => a - b)
}

/**
 * 方案 B：把整段对话作为一次输入交给本机小模型，取回相关轮次（1 起编号）。
 * @returns `{ picked, truncated, raw }`；`picked` 为空数组表示模型认为都不相关。
 */
async function generateSelect(exchanges, message) {
  const { prompt, truncated } = buildGenPrompt(exchanges, message)
  const raw = genProvider === 'ollama' ? await ollamaGenerate(prompt) : await localGenerate(prompt)
  return { picked: parseGenSelection(raw, exchanges.length), truncated, raw: String(raw).slice(0, 200) }
}

/** 并发跑两个判定器，任何一个失败都不影响另一个。 */
async function runJudges(exchanges, message, cacheFile) {
  const texts = exchanges.map(turnText)
  const [embed, gen] = await Promise.all([
    (async () => {
      try {
        const vectors = await embedTexts([...texts, message], { cacheFile })
        if (!vectors) throw new Error('判定器未就绪')
        const query = vectors[vectors.length - 1]
        return { scores: vectors.slice(0, -1).map(vector => cosine(query, vector)), source: embedProvider }
      } catch (err) {
        const reason = embedProvider === null ? '预热中'
          : embedProvider === 'lexical' ? '词面兜底'
            : String(err && err.message ? err.message : err).slice(0, 60)
        // 词面兜底同样以「一整轮问答」为单位打分，不再把问题分别去比用户句和回答句。
        return { scores: texts.map(text => lexicalScore(message, text)), source: 'lexical:' + reason }
      }
    })(),
    (async () => {
      if (genProvider === null) return { picked: [], error: genDetail }
      try {
        return await generateSelect(exchanges, message)
      } catch (err) {
        // 生成式判定失败不影响嵌入判定，记下原因即可。
        return { picked: [], error: String(err && err.message ? err.message : err).slice(0, 60) }
      }
    })(),
  ])
  return { embed, gen }
}

/**
 * 判断新消息与历史的关联，并挑出要带给模型的相关轮次。
 *
 * 方案 B（生成式，整段对话输入）与方案 A（嵌入）的结果取并集；只有一级可用就只用那一级。
 *
 * @param records 该用户在该工作区时间线内的全部原始历史记录（按时间升序）。
 * @param message 本次用户消息。
 * @param cacheFile 该 (用户, 工作区) 的嵌入缓存文件路径。
 * @returns `{ related, context, source, best, picked, pickedIndexes, scores, genPicked, embedPicked, digest }`：
 *   `context` 为要前置的文本（空串表示不带历史）；`picked` 是实际带入的轮次数；
 *   `pickedIndexes` 是实际带入的轮次编号（1 起，含承接兜底加入的那一轮），即最终结果的真相来源。
 */
export async function analyzeContext({ records, message, cacheFile }) {
  const exchanges = toExchanges(records)
  if (exchanges.length === 0) {
    return {
      related: false, context: '', source: 'empty', best: 0, picked: 0, pickedIndexes: [],
      scores: [], genPicked: [], embedPicked: [], digest: '无历史',
    }
  }

  const { embed, gen } = await runJudges(exchanges, message, cacheFile)

  const lexical = embed.source.startsWith('lexical')
  const low = lexical ? LOW_LEX : LOW
  const keep = lexical ? KEEP_LEX : KEEP
  let best = 0
  for (const score of embed.scores) if (score > best) best = score

  const embedPicked = []
  for (let i = 0; i < embed.scores.length; i += 1) if (embed.scores[i] >= keep) embedPicked.push(i + 1)
  const genRaw = gen.picked ?? []
  // 闸门：嵌入判定器判为无关的轮次，不接受生成式判定凭空引入。
  const genPicked = GEN_GATE ? genRaw.filter(index => embed.scores[index - 1] >= low) : genRaw
  const genRejected = genRaw.length - genPicked.length

  // 并集：任一判定器选中就带上。
  const union = new Set([...embedPicked, ...genPicked])
  const continuation = looksLikeContinuation(message)
  if (union.size === 0 || continuation) union.add(exchanges.length)

  let ordered = [...union].sort((a, b) => a - b)
  let dropped = 0
  if (MAX_ENTRIES > 0 && ordered.length > MAX_ENTRIES) {
    dropped = ordered.length - MAX_ENTRIES
    // 超限时优先保留生成式判定器点名的轮次，其余按嵌入相似度补齐，再按时间还原顺序。
    ordered = [...ordered]
      .sort((a, b) => {
        const byGen = Number(genPicked.includes(b)) - Number(genPicked.includes(a))
        return byGen !== 0 ? byGen : embed.scores[b - 1] - embed.scores[a - 1]
      })
      .slice(0, MAX_ENTRIES)
      .sort((a, b) => a - b)
  }

  const related = best >= low || genPicked.length > 0 || continuation
  const rendered = related ? renderContext(ordered.map(index => exchanges[index - 1])) : null

  const sources = []
  if (genPicked.length > 0) sources.push('gen')
  if (embedPicked.length > 0) sources.push(embed.source)
  const source = sources.length > 0 ? sources.join('+') : embed.source

  const digest = related
    ? '相关，带入 ' + ordered.length + ' 轮（生成式 ' + genPicked.length + ' ＋ 嵌入 ' + embedPicked.length +
      '，并集 ' + ordered.length + '）' +
      (genRejected > 0 ? '，生成式另有 ' + genRejected + ' 项被闸门拦下' : '') +
      (dropped > 0 ? '，超限丢弃 ' + dropped : '')
    : '新话题，未带历史'

  return {
    related,
    context: rendered ? rendered.text : '',
    source,
    best: Number(best.toFixed(3)),
    picked: related ? ordered.length : 0,
    pickedIndexes: related ? ordered : [],
    scores: embed.scores.map(score => Number(score.toFixed(3))),
    genPicked,
    genRaw,
    genRejected,
    embedPicked,
    genError: gen.error ?? null,
    genTruncated: gen.truncated ?? false,
    renderTruncated: rendered ? rendered.truncated : false,
    digest,
  }
}

/** 该 (用户, 工作区) 的嵌入缓存路径。 */
export function embeddingCacheFile(historyDir, userSlug, workspaceSlug) {
  return join(historyDir, userSlug, workspaceSlug + '.vec.json')
}
