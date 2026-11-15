/**
 * 反推状态持久化自检：断言「手改过 / 旧版本写脏 / 超大」的存档一律被收敛成能用的值。
 *
 * 为什么值得单独写：这条链路的失败方式是**静默**的。localStorage 是用户能直接改的
 * 明文存储，一个坏字段（比如 `person: "A9"`）如果原样进了界面，表现是「勾选全不亮」
 * 或整块面板白屏 —— 而这两种都很难从现象反推到存档上。
 *
 * 只测纯函数与存储封装（stub 一个 localStorage），不调模型、不用起 DSH。
 * 用法：node scripts/persist-check.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

const {
  coerceReverseOptions,
  coerceReverseSnapshot,
  coerceStoredImage,
  coerceStudioMode,
  defaultReverseOptions,
  REVERSE_IMAGE_KEY,
  REVERSE_SNAPSHOT_VERSION,
  REVERSE_STATE_KEY,
  STUDIO_MODE_KEY,
} = mod

const failures = []
function check(name, ok, detail) {
  if (!ok) failures.push(detail === undefined ? name : `${name} —— ${detail}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  (${detail})`}`)
}

/** 断言相等（浅比较用 JSON）。 */
function equals(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(name, a === b, `${a} !== ${b}`)
}

// ============================================================ 默认值

console.log('\n[默认值]')
const base = defaultReverseOptions()
equals('默认不换人', base.person, 'none')
equals('默认服装 B1', base.clothing, 'B1')
equals('默认姿态 C1', base.pose, 'C1')
equals('默认重绘 D2', base.redraw, 'D2')
equals('默认方言 gpt', base.dialect, 'gpt')
equals('默认不处理 NSFW', base.nsfw, '')
equals('默认锁定四个维度', base.locks, ['构图', '光线', '姿态', '色调'])
check('默认参数是独立对象（可安全改写）', defaultReverseOptions().locks !== base.locks)

// ============================================================ 参数收敛

console.log('\n[参数收敛：坏值不炸]')
equals('person 非法值退回 none', coerceReverseOptions({ person: 'A9' }).person, 'none')
equals('clothing 非法值退回 B1', coerceReverseOptions({ clothing: 'B7' }).clothing, 'B1')
equals('lockStrength 非法值退回 medium', coerceReverseOptions({ lockStrength: '超强' }).lockStrength, 'medium')
equals('dialect 非法值退回 gpt', coerceReverseOptions({ dialect: 'openai' }).dialect, 'gpt')
equals('nsfw 非法值退回空串', coerceReverseOptions({ nsfw: 'L9' }).nsfw, '')
equals('locks 过滤非法维度', coerceReverseOptions({ locks: ['构图', '心情', '光线'] }).locks, ['构图', '光线'])
equals('locks 去重', coerceReverseOptions({ locks: ['构图', '构图', '光线'] }).locks, ['构图', '光线'])
equals('locks 非数组退回空（不继承默认）', coerceReverseOptions({ locks: '构图' }).locks, [])
// 「生图时带原图」开关 2026-11-08 删除：存档里残留的旧字段不许可视化，
// 更不许被复活成界面上的一个勾选。
equals('已删除的 keepSource 字段不会被复活', coerceReverseOptions({ keepSource: true }).keepSource, undefined)
equals('clothingText 超长截断', coerceReverseOptions({ clothingText: 'x'.repeat(999) }).clothingText.length, 300)
equals('cards 非数组退回空', coerceReverseOptions({ cards: 'x' }).cards, [])
equals('cards 缺 name 的条目被丢', coerceReverseOptions({ cards: [{ why: '没有名字' }] }).cards, [])
equals(
  'cards 超过 8 张截断',
  coerceReverseOptions({ cards: Array.from({ length: 12 }, (_, i) => ({ name: `卡${i}`, why: '理由' })) }).cards.length,
  8,
)
equals(
  'cards 字段收敛',
  coerceReverseOptions({ cards: [{ name: ' 暖阳胶感 ', why: 'w', fragment: 'f' }] }).cards,
  [{ name: '暖阳胶感', why: 'w', fragment: 'f' }],
)
equals('原始值是 null 也能收敛', coerceReverseOptions(null).person, 'none')

// ============================================================ 快照收敛

console.log('\n[快照收敛]')
check('非对象返回 undefined（按没有存档处理）', coerceReverseSnapshot('nonsense') === undefined)
check('数组返回 undefined', coerceReverseSnapshot([]) === undefined)
equals('空对象的版本号被写回', coerceReverseSnapshot({}).version, REVERSE_SNAPSHOT_VERSION)
equals('空对象给默认参数', coerceReverseSnapshot({}).options.person, 'none')
check('空对象没有结果', coerceReverseSnapshot({}).result === null)
equals('正文为空的 result 当作没有', coerceReverseSnapshot({ result: { text: '   ' } }).result, null)
equals(
  '正文超长截断',
  coerceReverseSnapshot({ result: { text: 'x'.repeat(30000) } }).result.text.length,
  20000,
)
equals(
  '缺 chars 时用正文长度补',
  coerceReverseSnapshot({ result: { text: '四个字' } }).result.chars,
  3,
)
equals(
  'typeSource 非法值退回 none',
  coerceReverseSnapshot({ result: { text: '正文', typeSource: 'magic' } }).result.typeSource,
  'none',
)
equals(
  'warnings 限量 10 条',
  coerceReverseSnapshot({ result: { text: '正文', warnings: Array.from({ length: 20 }, (_, i) => `w${i}`) } }).result.warnings.length,
  10,
)
equals(
  '尺寸缺高时整块丢掉',
  coerceReverseSnapshot({ meta: { width: 800 } }).meta,
  null,
)
equals(
  '尺寸有效时保留',
  coerceReverseSnapshot({ meta: { width: 800, height: 600, aspect: '4:3' } }).meta,
  { width: 800, height: 600, aspect: '4:3' },
)
equals('hasImage 只认布尔', coerceReverseSnapshot({ hasImage: 'yes' }).hasImage, false)

// ============================================================ 源图收敛

console.log('\n[源图收敛]')
const tinyImage = 'data:image/jpeg;base64,AAAA'
equals('正常 data URL 原样保留', coerceStoredImage(tinyImage), tinyImage)
check('非字符串返回 undefined', coerceStoredImage(42) === undefined)
check('非图片 data URL 被拒', coerceStoredImage('data:text/html;base64,AAAA') === undefined)
check('超限的图被拒（宁可没图，不占满配额）', coerceStoredImage(`data:image/jpeg;base64,${'A'.repeat(2_000_001)}`) === undefined)

// ============================================================ 模式收敛

console.log('\n[模式收敛]')
equals('image 原样保留', coerceStudioMode('image'), 'image')
equals('word 原样保留', coerceStudioMode('word'), 'word')
equals('垃圾退回 word', coerceStudioMode('gallery'), 'word')
equals('undefined 退回 word', coerceStudioMode(undefined), 'word')

// ============================================================ 存取往返（stub localStorage）

console.log('\n[存取往返：stub localStorage]')
const store = new Map()
globalThis.localStorage = {
  get length() { return store.size },
  key: (index) => Array.from(store.keys())[index] ?? null,
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)) },
  removeItem: (key) => { store.delete(key) },
  clear: () => { store.clear() },
}

const persist = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
equals('存档键名固定（改键名 = 老数据全丢）', REVERSE_STATE_KEY, 'dsh-creative.reverse.state.v1')
equals('图片键名独立', REVERSE_IMAGE_KEY, 'dsh-creative.reverse.image.v1')
equals('模式键名固定', STUDIO_MODE_KEY, 'dsh-creative.studio.mode.v1')

const written = persist.saveReverseSnapshot({
  version: REVERSE_SNAPSHOT_VERSION,
  options: { ...defaultReverseOptions(), person: 'A2', locks: ['构图'] },
  result: { text: '# 0 - 任务目标\n正文', chars: 12, type: '人像 · 写真', typeSource: 'model', cardsSource: 'model', provider: 'p', model: 'm', elapsedMs: 1234, warnings: [] },
  meta: { width: 800, height: 600, aspect: '4:3' },
  hasImage: true,
  updatedAt: 1,
})
check('快照写成功', written === true)
const loaded = persist.loadReverseSnapshot()
equals('往返：参数保住', loaded.options.person, 'A2')
equals('往返：锁定保住', loaded.options.locks, ['构图'])
equals('往返：正文保住', loaded.result.text.startsWith('# 0 - 任务目标'), true)
equals('往返：尺寸保住', loaded.meta, { width: 800, height: 600, aspect: '4:3' })
equals('没有图时 image 是空串', loaded.image, '')

check('图写成功', persist.saveReverseImage(tinyImage) === true)
equals('图能读回来', persist.loadReverseImage(), tinyImage)
persist.saveReverseImage(null)
equals('传 null 清掉图', store.has(REVERSE_IMAGE_KEY), false)

persist.saveStudioMode('image')
equals('模式能读回来', persist.loadStudioMode(), 'image')

// 手改坏 JSON：不能抛，按「没有存档」处理
store.set(REVERSE_STATE_KEY, '{ 这不是 JSON')
const broken = persist.loadReverseSnapshot()
equals('坏 JSON 退回默认参数', broken.options.person, 'none')
check('坏 JSON 没有结果', broken.result === null)

// 老版本存档（只认识一部分字段）
store.set(REVERSE_STATE_KEY, JSON.stringify({ options: { person: 'A3' }, result: null }))
const legacy = persist.loadReverseSnapshot()
equals('老存档保住认识的字段', legacy.options.person, 'A3')
equals('老存档缺的字段用默认补齐', legacy.options.clothing, 'B1')

// 存储被禁用（隐私模式）
const saved = globalThis.localStorage
delete globalThis.localStorage
const disabled = persist.loadReverseSnapshot()
equals('没有 localStorage 时返回默认值', disabled.options.person, 'none')
check('没有 localStorage 时写返回 false', persist.saveReverseSnapshot({
  version: REVERSE_SNAPSHOT_VERSION,
  options: defaultReverseOptions(),
  result: null,
  meta: null,
  hasImage: false,
  updatedAt: 0,
}) === false)
globalThis.localStorage = saved

// ============================================================ 页面加载的运行态判定
//
// 2026-11-08 修「跑到一半切走就被取消」时新增：反推现在挂在模块作用域的执行体上，
// 页面刷新 / 关窗仍会打断它 —— 那一次要靠快照里的 inflight 标记识别成「被中断」，
// 而不是安静地回到空面板（用户会以为白花了 175 秒且毫无解释）。

console.log('\n[页面加载的运行态判定]')
const { resolveBootRun, patchReverseSnapshot, emptyReverseSnapshot, MAX_INTERRUPTED_MS } = mod
const snap = (patch) => ({ ...emptyReverseSnapshot(), ...patch })
const sampleResult = {
  text: '# 0 - 任务目标\n正文',
  chars: 12,
  type: '人像 · 写真',
  typeSource: 'model',
  cardsSource: 'none',
  provider: 'p',
  model: 'm',
  elapsedMs: 1000,
  warnings: [],
}

equals('没有存档 → 空态', resolveBootRun(undefined).kind, 'idle')
equals('有结果 → 成功态', resolveBootRun(snap({ result: sampleResult })).kind, 'done')
equals('有失败 → 失败态', resolveBootRun(snap({ error: { title: '反推超时', detail: '', hint: '' } })).kind, 'error')
equals(
  '中断标记优先于旧结果（跑一半就没了不能被当成上次成功）',
  resolveBootRun(snap({ inflight: { startedAt: 1000 }, result: sampleResult }), 61_000).kind,
  'interrupted',
)
equals(
  '中断态带真实已用秒数',
  resolveBootRun(snap({ inflight: { startedAt: 1000 } }), 61_000).elapsedMs,
  60_000,
)
equals(
  '失败优先于成功（上次是失败的，不该显示旧结果）',
  resolveBootRun(snap({ result: sampleResult, error: { title: '反推超时', detail: '', hint: '' } })).kind,
  'error',
)
equals(
  '太旧的中断标记当作没有（不吓人）',
  resolveBootRun(snap({ inflight: { startedAt: 1000 } }), 1000 + MAX_INTERRUPTED_MS + 1).kind,
  'idle',
)

// 两个写者合并：面板写参数、执行体写结果，谁后写都不许抹掉对方的字段
persist.patchReverseSnapshot({ options: { ...defaultReverseOptions(), dialect: 'qwen' } })
persist.patchReverseSnapshot({ result: sampleResult, inflight: null })
const merged = persist.loadReverseSnapshot()
equals('patch：后写结果不影响已写参数', merged.options.dialect, 'qwen')
equals('patch：参数写入不抹掉结果', merged.result?.type, '人像 · 写真')
equals('patch：结果写入后中断标记被清掉', merged.inflight, null)

// ============================================================ 结论

console.log('')
if (failures.length > 0) {
  console.error(`✗ ${failures.length} 项失败：`)
  for (const item of failures) console.error(`  · ${item}`)
  process.exit(1)
}
console.log('✓ 全部通过（反推状态持久化）')
