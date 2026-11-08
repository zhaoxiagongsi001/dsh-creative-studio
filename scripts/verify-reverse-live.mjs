/**
 * 真机反推验证：用一张真实人像图打 DSH 的 /dsh-creative/reverse，
 * 检查新协议（两行元信息）与本地推断兜底在**真实宿主进程**里是否生效。
 *
 * 为什么不用离线自检代替：离线只测纯函数；真实链路里还有
 * attachments.saveImages / llm.stream / 多模态 ImageBlock，这些只能在 DSH 里验。
 *
 * 用法：node scripts/verify-reverse-live.mjs [port]
 * 输入图：probe/A-baseline.png（上一步 complexity 实测生成的真实人像）
 * 费用：一次 LLM 调用（几分钱）。不改任何生产数据。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const port = process.argv[2] ?? '1799'
const base = `http://127.0.0.1:${port}`
const png = await readFile(path.join(root, 'probe', 'A-baseline.png'))
const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`

console.log(`输入图 ${(png.byteLength / 1024).toFixed(0)} KB，POST ${base}/dsh-creative/reverse …`)
const startedAt = Date.now()

const response = await fetch(`${base}/dsh-creative/reverse`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    image: imageDataUrl,
    options: {
      person: 'none',
      clothing: 'B1',
      pose: 'C1',
      redraw: 'D2',
      locks: ['构图', '光线', '姿态', '色调'],
      nsfw: '',
      dialect: 'gpt',
      cards: [],
    },
  }),
})
const elapsedMs = Date.now() - startedAt
const body = await response.json().catch(() => ({}))

const out = {
  status: response.status,
  elapsedMs,
  ok: body.ok,
  textLength: typeof body.text === 'string' ? body.text.length : 0,
  type: body.type ?? null,
  typeSource: body.typeSource ?? null,
  recommendedCards: body.recommendedCards ?? [],
  cardsSource: body.cardsSource ?? null,
  warnings: body.warnings ?? [],
  provider: body.provider ?? null,
  model: body.model ?? null,
  routeSource: body.routeSource ?? null,
  code: body.code ?? null,
  message: body.message ?? null,
  textHead: typeof body.text === 'string' ? body.text.slice(0, 240) : '',
}
console.log(JSON.stringify(out, null, 2))

// ---- 断言
const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  (${detail})`}`)
}
console.log('\n=== 断言 ===')
check('HTTP 200', response.status === 200, String(response.status))
check('ok=true', body.ok === true, String(body.ok))
check('返回了正文（>200 字）', out.textLength > 200, `${out.textLength} 字`)
check('正文以 # 0 开头（元信息已剥离）', out.textHead.trimStart().startsWith('# 0'), out.textHead.slice(0, 40))
check('图片类型非空（模型判定或本地推断都算）', typeof out.type === 'string' && out.type !== '', String(out.type))
check('类型来源被标注', ['model', 'inferred'].includes(out.typeSource), String(out.typeSource))
check('推荐卡片非空', Array.isArray(out.recommendedCards) && out.recommendedCards.length > 0, JSON.stringify(out.recommendedCards))
check('卡片来源被标注', ['model', 'inferred'].includes(out.cardsSource), String(out.cardsSource))
check('没有三版残留（响应里不含 versions 字段）', body.versions === undefined, typeof body.versions)
check('路由来源可读', typeof out.routeSource === 'string', String(out.routeSource))
check('耗时合理（<180s）', elapsedMs < 180_000, `${(elapsedMs / 1000).toFixed(1)}s`)

const failed = checks.filter((item) => !item.ok)
await writeFile(path.join(root, 'probe', 'verify-reverse-live.json'), JSON.stringify({ out, checks }, null, 2), 'utf8')
console.log(`\n${checks.length - failed.length}/${checks.length} 通过；结果写入 probe/verify-reverse-live.json`)
if (failed.length > 0) process.exitCode = 1
