/**
 * 反推规则自检：逐条断言「勾了某个档位，system 里就必须出现规范要求的那句话」。
 *
 * 为什么值得单独写一个脚本：规则层的失败方式是**静默**的 —— 少拼一句锁脸句，
 * 界面看起来完全正常，只有出图的时候才发现脸跑了。三份规范里的必写句是
 * 「字面照抄」的要求，所以这里按字面断言。
 *
 * 只测纯函数 `instructionsOf()`（不调模型、不花钱、不用起 DSH）。
 * 用法：node scripts/rules-check.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
const build = mod.instructionsOf

const failures = []
function check(name, ok, detail) {
  if (!ok) failures.push(detail === undefined ? name : `${name} —— ${detail}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  (${detail})`}`)
}

/** 断言包含某段文字。 */
function contains(text, needle, name) {
  check(name ?? `包含「${needle.slice(0, 30)}」`, text.includes(needle), needle.slice(0, 60))
}

/** 断言不包含某段文字。 */
function lacks(text, needle, name) {
  check(name ?? `不包含「${needle.slice(0, 30)}」`, !text.includes(needle))
}

// ============================================================ 硬规则（任何档位）

const baseline = build({ person: 'none', dialect: 'gpt' })
contains(baseline, '【硬规则】', '任何档位都带硬规则段')
contains(baseline, '一律写明「成年」', '硬规则：必须写成年')
contains(baseline, '没有 negative prompt 字段', '硬规则：禁止项要正向化（GPT 无负向字段）')
contains(baseline, '量化一律降级为定性', '硬规则：量化降级为定性')
contains(baseline, '不写真实品牌 Logo', '硬规则：不写真实品牌')
contains(baseline, '不写 hex 色值', '硬规则：具体禁止项存在')

// ============================================================ 换人四档

const a1 = build({ person: 'A1', lockStrength: 'medium', dialect: 'gpt' })
contains(a1, '【换人档位 · A1】', 'A1：档位段落')
contains(a1, '面部 100% 取自参考图 1：五官形状、脸型骨相、肤色、发际线与可辨识特征均以参考图 1 为准', 'A1：中强度锁脸句（原文）')
contains(a1, '取自参考图 1：① 面部结构与五官形状', 'A1：取 / 不取清单（取自）')
contains(a1, '不取自参考图 1：① 服装款式、面料与图案', 'A1：取 / 不取清单（不取自）')
contains(a1, '冲突优先级：① 身份保真（脸） ＞ ② 光效', 'A1：冲突优先级（原文）')
contains(a1, '必须保留：① 面部 100% 取自参考图 1，不得二次创作五官', 'A1：6 段身份锁（A1 版）')
contains(a1, '严格禁止：改动脸型与五官比例', 'A1：6 段禁止项（A1 版）')
contains(a1, '验收：100% 放大后，面部各特征点位置与参考图 1 一致', 'A1：一致性验收句')
lacks(a1, '身形比例取自参考图 1', 'A1：不该出现 A2 的身形归属句')

const a2 = build({ person: 'A2', dialect: 'gpt' })
contains(a2, '【换人档位 · A2】', 'A2：档位段落')
contains(a2, '删掉三围/罩杯/腿长比例等具体数字', 'A2：必须删掉身材具体数字')
contains(a2, '必须保留：身形比例取自参考图 1，服装款式与图案保持原图不变', 'A2：6 段身份锁（A2 版）')
contains(a2, '服装合身度可让步', 'A2：让步表')

const a3 = build({ person: 'A3', dialect: 'gpt' })
contains(a3, '【换人档位 · A3】', 'A3：档位段落')
contains(a3, '3 段末必须追加：取景以「完整呈现参考图的姿态」为准', 'A3：3-Shot 让步句')
contains(a3, '必须保留：姿态与肢体关系取自参考图 1', 'A3：6 段身份锁（A3 版）')
contains(a3, '构图位置可让步', 'A3：让步表')

// 锁脸三档
const short = build({ person: 'A1', lockStrength: 'short' })
contains(short, '面部 100% 取自参考图 1，不做任何改动。', '锁脸 · 短档原文')
const strong = build({ person: 'A1', lockStrength: 'strong' })
contains(strong, '禁止依据文字描述重新设计任何面部特征', '锁脸 · 强档原文')
lacks(short, '禁止依据文字描述重新设计任何面部特征', '锁脸 · 短档不混入强档措辞')

// ============================================================ 服装 B1/B2/B3

const b1 = build({ person: 'A1', clothing: 'B1' })
contains(b1, '款式、领型、袖型、下摆长度、面料与图案完全按原图', 'B1：保留原图原文')

const b2Visible = build({ person: 'A1', clothing: 'B2', clothingVisible: true })
contains(b2Visible, '款式、面料、图案与配色取自参考图（即本图）', 'B2（未带原图）：服装取自本图')
check('B2（未带原图）不出现「参考图 2」', !b2Visible.includes('参考图 2'), '未带原图时不该提参考图 2')

const b2WithSource = build({ person: 'A1', clothing: 'B2', clothingVisible: true, keepSource: true })
contains(b2WithSource, '取自参考图 2', 'B2（带原图）：服装取自参考图 2')

const b2Unknown = build({ person: 'A1', clothing: 'B2', clothingVisible: false })
contains(b2Unknown, '用户未确认目标图中能看清服装，按 B1 口径处理', 'B2 无前提确认：自动降级 B1')

const b3 = build({ person: 'A1', clothing: 'B3', clothingText: '米白细针织长袖圆领，下摆及髋' })
contains(b3, '服装：米白细针织长袖圆领', 'B3：自填内容进指令')
contains(b3, '须含款式/颜色/面料/领型/下摆五项', 'B3：五项要求')
const b3Empty = build({ person: 'A1', clothing: 'B3', clothingText: '' })
contains(b3Empty, '留出明确占位并标注', 'B3 空内容：留占位而不是瞎编')

// ============================================================ 姿态 C1/C2/C3

const c1 = build({ person: 'A2', pose: 'C1' })
contains(c1, '姿态：姿态、重心与四肢角度完全按原图', 'C1：保持原图')
const c2 = build({ person: 'A3', pose: 'C2', keepSource: true })
contains(c2, '取自参考图 2', 'C2 带原图：姿态取自参考图 2')
const c3 = build({ person: 'A3', pose: 'C3', poseText: '重心落左脚，躯干侧 45°' })
contains(c3, '姿态：重心落左脚，躯干侧 45°', 'C3：自填内容进指令')
const poseHidden = build({ person: 'A1', pose: 'C3', poseText: '不该出现' })
lacks(poseHidden, '不该出现', 'A1：姿态档不生效（规范要求 A1 隐藏 C 组）')

// ============================================================ 重绘 D1/D2/D3

const d1 = build({ person: 'A1', redraw: 'D1' })
contains(d1, '允许的改动仅限面部区域', 'D1：保守措辞')
const d3 = build({ person: 'A1', redraw: 'D3' })
contains(d3, '追求同一组拍摄条件下的另一张成片', 'D3：激进措辞')
const d2Default = build({ person: 'A1' })
contains(d2Default, '允许对背景细节、道具摆放、布料褶皱作自然重绘', 'D2：未指定时默认平衡')

// ============================================================ 卡片只进 2/5 段

const withCards = build({
  person: 'A1',
  cards: [{ name: '暖阳胶感', why: '暖调窗光', fragment: '暖调自然光自画面左侧窗户 45° 斜入' }],
})
contains(withCards, '**只**改写 2-Style 与 5-Scene lighting 两段', '卡片：只允许改 2/5 段')
contains(withCards, '不得碰 1 段与 6 段', '卡片：明令不许碰身份锁段')
contains(withCards, '暖调自然光自画面左侧窗户 45° 斜入', '卡片：片段进了指令')

// ============================================================ NSFW 三档

const l1 = build({ person: 'none', nsfw: 'L1' })
contains(l1, '【NSFW 档位 · L1】', 'L1：档位段落')
contains(l1, '换场景定性', 'L1：三个动作之一')
contains(l1, '内衣/情趣内衣 → 蕾丝边吊带背心', 'L1：词对照表')
lacks(l1, '服装完整覆盖躯干与四肢', 'L1：不该加 L2 的兜底句')

const l2 = build({ person: 'none', nsfw: 'L2' })
contains(l2, 'L2 必须**同时**做四件事', 'L2：四动作要求')
contains(l2, '全文压缩 40–60%', 'L2：压缩比例')
contains(l2, '服装完整覆盖躯干与四肢，贴合得体', 'L2：服装覆盖兜底句（原文）')
contains(l2, '裸体/全裸 → 艺术人体研究', 'L2：词对照表')
contains(l2, '放弃**「身体裸露程度」', 'L2：明示放弃项')

const l3 = build({ person: 'none', nsfw: 'L3' })
contains(l3, '【NSFW 档位 · L3】', 'L3：档位段落')
contains(l3, '拆骨架：只保留 0（改成商业用途）/2/3/5/6 段', 'L3：拆骨架动作')
contains(l3, '古典雕塑 / 艺术人体研究 / 时装大片剪影', 'L3：三框架')

// ============================================================ 方言三档

const gemini = build({ person: 'none', dialect: 'gemini' })
contains(gemini, '【方言 · Gemini（nano-banana）】', 'Gemini：方言段')
contains(gemini, '300–800 字，5–12 行', 'Gemini：长度约束')
contains(gemini, '不要「唯美」「高级感」「氛围拉满」', 'Gemini：禁模糊形容词')
lacks(gemini, '1500–3000 字', 'Gemini：不该出现 GPT 的长度')

const qwen = build({ person: 'none', dialect: 'qwen' })
contains(qwen, '【方言 · Qwen Image】', 'Qwen：方言段')
contains(qwen, '800–1500 字，每段 2–6 条', 'Qwen：长度与条数')
contains(qwen, '禁止项**单列一节**', 'Qwen：禁止项单列')

const gpt = build({ person: 'none', dialect: 'gpt' })
contains(gpt, '【方言 · GPT Image 系列】', 'GPT：方言段')
contains(gpt, '1500–3000 字', 'GPT：长度约束')
contains(gpt, '少用 ｜、→、【】', 'GPT：符号限制')

// ============================================================ 拼装顺序（§9 承重）

const full = build({
  person: 'A3',
  pose: 'C2',
  clothing: 'B1',
  redraw: 'D2',
  cards: [{ name: '暖阳胶感', why: '暖调', fragment: '暖光' }],
  extra: '换成夜景',
  nsfw: 'L2',
  dialect: 'qwen',
  locks: ['构图'],
})
const order = [
  '【硬规则】',
  '【换人档位 · A3】',
  '【锁定】',
  '【创意方向】',
  '【额外要求】',
  '【NSFW 档位 · L2】',
  '【方言 · Qwen Image】',
].map((marker) => ({ marker, at: full.indexOf(marker) }))
const orderOk = order.every((item) => item.at >= 0)
check('全选项：七段标记都存在', orderOk, order.filter((i) => i.at < 0).map((i) => i.marker).join(','))
const sorted = order.every((item, index) => index === 0 || item.at > order[index - 1].at)
check('全选项：顺序符合规范（A/B/C/D → 锁定 → 卡片 → 额外 → NSFW → 方言）', sorted, order.map((i) => i.at).join(' < '))

// 顺序的两条硬约束（规范里专门强调过的）
const nsfwAt = full.indexOf('【NSFW 档位 · L2】')
const dialectAt = full.indexOf('【方言 · Qwen Image】')
check('NSFW 在方言之前（先降档再定文体）', nsfwAt < dialectAt, `${nsfwAt} < ${dialectAt}`)
const personAt = full.indexOf('【换人档位 · A3】')
check('换人骨架在 NSFW 之前（先锁脸再降档会固定措辞，规范禁止）', personAt < nsfwAt, `${personAt} < ${nsfwAt}`)

// ============================================================ 汇总

console.log()
if (failures.length > 0) {
  console.error(`${failures.length} 项失败：`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('规则自检全绿')
}
