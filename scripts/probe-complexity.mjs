/**
 * 实测 GPT Image 2.6 新增透传参数 `complexity` 到底管什么。
 *
 * 做法：同一段提示词 + 同一组固定参数，分 3 次调用，只改 complexity：
 *   A 不带该字段（基线）
 *   B complexity = "low"
 *   C complexity = "high"
 * 然后对比：返回图片字节数、耗时、usage、以及（能拿到时）图片像素尺寸。
 *
 * 为什么不能直接看文档：OpenRouter 的 endpoints 只列了 allowed_passthrough_parameters
 * = ["moderation", "complexity"]，没给枚举值也没给语义；联网搜不到。所以只能黑盒试。
 *
 * 费用：3 张 1024×1024，按该模型定价约 $0.01-0.05/张，总计几毛钱人民币。
 * 产物落到 D:/DSH/creative-merge/probe/ 下，不改任何生产数据。
 *
 * 用法：node scripts/probe-complexity.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'probe')
await mkdir(outDir, { recursive: true })

// ---- 从用户配置里读 Key（不落盘、不打印）
const cfgPath = path.join(process.env.DSH_HOME ?? 'C:/Users/zhang/.dsh', 'dsh-imagegen-panel', 'config.json')
const cfg = JSON.parse(await (await import('node:fs/promises')).readFile(cfgPath, 'utf8'))
const base = cfg.baseUrl ?? 'https://openrouter.ai/api/v1'
const key = cfg.apiKey
if (typeof key !== 'string' || key === '') throw new Error('config.json 里没有 apiKey')

// ---- 一段稳定的测试提示词（GPT 2.6 写法：长句、可数项、无 hex/百分比）
const PROMPT = [
  '一张室内窗边的成年东亚女性半身人像写真，身体略侧向画面左侧、脸转回面向镜头，右手手背轻轻托住下巴。',
  '她穿米白色粗针针织开衫，领口自然松垮露出锁骨一段，袖口堆在手腕处，中分微卷长发，额前有几缕碎发。',
  '左侧窗户的午后自然光斜射进来，勾出金色发丝光，正面白墙反光把阴影面提亮，光比柔和，暗部偏暖褐。',
  '镜头用 85mm 等效定焦、浅景深，机位与视线齐平，背景虚化成柔和光斑，前景有一株绿植叶片轻微失焦。',
  '整体暖灰低饱和，米白、暖褐、浅木色三色为主，带 35mm 胶片颗粒，皮肤保留真实毛孔与绒毛质感。',
  '画面中不出现文字水印、第二人物、品牌 Logo 与冷蓝偏色。',
].join('')

// ---- 三档
const CASES = [
  { name: 'A-baseline', extra: {} },
  { name: 'B-low', extra: { complexity: 'low' } },
  { name: 'C-high', extra: { complexity: 'high' } },
]

const results = []
for (const testCase of CASES) {
  const body = {
    model: 'openai/gpt-image-2.6-flare',
    prompt: PROMPT,
    n: 1,
    aspect_ratio: '1:1',
    quality: 'medium',
    ...testCase.extra,
  }
  const startedAt = Date.now()
  let status = 0
  let responseBody
  try {
    const response = await fetch(`${base}/images`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    status = response.status
    responseBody = await response.json()
  } catch (error) {
    results.push({ name: testCase.name, error: String(error), elapsedMs: Date.now() - startedAt })
    console.log(`${testCase.name}: 网络错误 ${String(error)}`)
    continue
  }
  const elapsedMs = Date.now() - startedAt
  const images = Array.isArray(responseBody?.data) ? responseBody.data : []
  const first = images[0]
  const b64 = first?.b64_json
  let bytes = 0
  let pngInfo = ''
  if (typeof b64 === 'string' && b64 !== '') {
    const buffer = Buffer.from(b64, 'base64')
    bytes = buffer.byteLength
    await writeFile(path.join(outDir, `${testCase.name}.png`), buffer)
    // PNG 头部第 16-24 字节是宽高；非 PNG 就只看字节数
    if (buffer.subarray(1, 4).toString() === 'PNG') {
      pngInfo = `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`
    }
  }
  const usage = responseBody?.usage ?? {}
  const entry = {
    name: testCase.name,
    status,
    elapsedMs,
    bytes,
    pngInfo,
    cost: usage.cost ?? usage.total_cost ?? null,
    imagesCount: images.length,
    error: status >= 400 ? JSON.stringify(responseBody).slice(0, 300) : undefined,
    // 原样留一份响应（去掉 b64 避免文件爆炸）
    responseShape: Object.keys(responseBody ?? {}).join(','),
  }
  results.push(entry)
  console.log(`${testCase.name}: HTTP ${status} · ${elapsedMs}ms · ${bytes} B · ${pngInfo || 'n/a'} · cost=${entry.cost}`)
}

await writeFile(path.join(outDir, 'complexity-result.json'), JSON.stringify(results, null, 2), 'utf8')
console.log(`\n结果写入 ${path.join(outDir, 'complexity-result.json')}`)
