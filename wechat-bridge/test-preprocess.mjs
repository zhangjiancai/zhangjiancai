#!/usr/bin/env node
/**
 * 预处理层自检 / 阈值标定。
 *
 * 用法：
 *   node test-preprocess.mjs           跑固定用例，打印两个判定器的判定与并集结果
 *   node test-preprocess.mjs --scores  额外打印每轮对当前问题的原始相似度
 *
 * 两个判定器由 preprocess.mjs 自己预热（各自独立）：嵌入走 进程内 ONNX -> Ollama -> 词面，
 * 生成式走 进程内 ONNX -> Ollama。打印出来的就是本机实际生效的那几级。
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeContext, preprocessInfo, warmupPreprocess } from './preprocess.mjs'

/** 固定对话：每两条构成一轮问答，判定单元就是这一轮。 */
const history = [
  { role: 'user', text: '帮我看看 nginx 的配置，站点起不来了' },
  { role: 'assistant', text: '配置在 /etc/nginx/sites-enabled，我看了一下，server_name 写错了。' },
  { role: 'user', text: '重启一下 WSL' },
  { role: 'assistant', text: '已重启 WSL，Ubuntu-24.04 状态 Running。' },
  { role: 'user', text: '把桌面截图发我' },
  { role: 'assistant', text: '已发送桌面截图 desktop-latest.png。' },
  { role: 'user', text: '微信桥接是怎么发图片的' },
  { role: 'assistant', text: '走 iLink 的 image_item：AES 加密后传 CDN，再带加密引用发消息。' },
]

/** 每条用例带上期望轮次；'新话题' 表示期望不带历史。 */
const cases = [
  ['再发一次桌面截图', [3]],
  ['nginx 那个 server_name 你改了吗', [1]],
  ['WSL 的崩溃转储清理了吗', [2]],
  ['那个 aes_key 为什么要用十六进制', [4]],
  ['继续', '兜底带最新一轮'],
  ['把前面聊的 nginx 和 WSL 两件事一起整理一下', [1, 2]],
  ['今天中午吃什么', '新话题'],
  ['帮我写一首关于秋天的诗', '新话题'],
  ['帮我订一张明天去上海的高铁票', '新话题'],
]

const showScores = process.argv.includes('--scores')
warmupPreprocess(message => console.log('[预热] ' + message))

// 等两个判定器各自落定（最坏情况是模型首次下载 ~490 MB）。
const deadline = Date.now() + 20 * 60 * 1000
while (Date.now() < deadline) {
  const info = preprocessInfo()
  const embedSettled = info.embedProvider !== null
  const genSettled = info.genDetail !== '预热中'
  if (embedSettled && genSettled) break
  await new Promise(r => setTimeout(r, 1000))
}

const info = preprocessInfo()
console.log('嵌入判定器（方案 A）：' + (info.embedProvider ?? '未就绪') + '（' + info.embedDetail + '）')
console.log('生成式判定器（方案 B）：' + (info.genProvider ?? '不可用') + '（' + info.genDetail + '）')
console.log('阈值：相关 ≥ ' + info.low + '，选中某轮 ≥ ' + info.keep)
console.log('历史：' + (history.length / 2) + ' 轮（全部参与判定，不截断）\n')

const cacheFile = join(mkdtempSync(join(tmpdir(), 'pre-test-')), 'vec.json')

for (const [message, expect] of cases) {
  const started = Date.now()
  const result = await analyzeContext({ records: history, message, cacheFile })
  const elapsed = Date.now() - started
  // 最终结果以 pickedIndexes 为准：它包含承接兜底加入的那一轮，正是要发给云端的内容。
  const picked = new Set(result.pickedIndexes)
  const hit = Array.isArray(expect)
    // 并集是召回优先的：期望的轮次必须都在，多带的不算错。
    ? result.related && expect.every(index => picked.has(index))
    : expect === '新话题'
      ? !result.related
      : result.related && picked.has(history.length / 2)
  console.log('「' + message + '」  期望 ' + JSON.stringify(expect))
  console.log('  -> ' + (result.related ? '相关' : '新话题') +
    '  带入=[' + result.pickedIndexes.join(',') + ']' +
    '  生成式选中=' + JSON.stringify(result.genPicked) +
    '  嵌入选中=' + JSON.stringify(result.embedPicked) +
    '  最高=' + result.best + '  ' + elapsed + 'ms' + (hit ? '  ✓' : '  ✗'))
  if (result.genError) console.log('  生成式错误：' + result.genError)
  if (result.genTruncated) console.log('  生成式输入被截断（超过字数上限）')
  if (showScores) {
    console.log('  各轮相似度：' + result.scores.join('  '))
    const lines = result.context ? result.context.split('\n').slice(1, -2) : []
    console.log('  带入：' + (lines.length ? lines.map(l => l.slice(0, 40)).join(' │ ') : '(无)'))
  }
  console.log('')
}

// ONNX 运行时不会自己释放事件循环，显式退出。
process.exit(0)
