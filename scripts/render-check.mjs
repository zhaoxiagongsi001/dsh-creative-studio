/**
 * dsh-creative-studio 客户端渲染自检（零浏览器、离线、沙箱可跑）。
 *
 * 做法与生图插件同款：用真实 React 的 `renderToStaticMarkup`
 * （不需要 jsdom、不需要 Chromium），把打包后的 `lib/client.js` 装进一个假的
 * `window.__ModuleLoader__`，再把 `apply(ctx)` 注册的组件渲染成 HTML 做断言。
 *
 * 为什么值得写：客户端 bundle 的失败方式是「插件没反应」——壳里看不到任何报错。
 * 这里能在不重启 DSH 的前提下抓到：bundle 没注册、槽位 id 不一致、
 * label 写错、组件首帧抛错、模式切换按钮缺失。
 *
 * 依赖解析：本包刻意不建 node_modules（避免为一款校验工具拉整棵依赖树），
 * react / react-dom 从已验证的样板包 `dsh-prompt-forge` 里取
 * （可用环境变量 DSH_SAMPLE_ROOT 覆盖）。
 *
 * 用法：node scripts/render-check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** react / react-dom 的解析根：先样板包，再本包（公开 clone 装了 node_modules 就会命中）。 */
const SAMPLES = [
  process.env.DSH_SAMPLE_ROOT || path.join(root, '..', 'dsh-prompt-forge'),
  root,
]

function requireFrom(specifier) {
  const tried = []
  for (const base of SAMPLES) {
    const anchor = path.join(base, 'package.json')
    if (!existsSync(anchor)) { tried.push(`${anchor}（不存在）`); continue }
    try {
      return createRequire(anchor)(specifier)
    } catch (error) {
      tried.push(`${anchor} → ${error?.code ?? error?.message ?? error}`)
    }
  }
  throw new Error(`找不到 ${specifier}。已尝试：\n  ${tried.join('\n  ')}`)
}

const React = requireFrom('react')
const ReactDOMServer = requireFrom('react-dom/server')

// ------------------------------------------------------------------ 断言

const failures = []

function check(name, ok, detail) {
  if (!ok) failures.push(detail === undefined ? name : `${name} —— ${detail}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  (${detail})`}`)
}

function checkContains(haystack, needle, name) {
  check(name ?? `包含「${needle}」`, typeof haystack === 'string' && haystack.includes(needle))
}

function checkNotContains(haystack, needle, name) {
  check(name ?? `不包含「${needle}」`, typeof haystack !== 'string' || !haystack.includes(needle))
}

/** 把元素渲染成静态 HTML；抛错也算一条失败，不中断后续检查。 */
function render(element, label) {
  try {
    return ReactDOMServer.renderToStaticMarkup(element)
  } catch (error) {
    check(`${label} 渲染`, false, `抛出 ${error?.message ?? error}`)
    return ''
  }
}

// ------------------------------------------------- 最小 document / window 探针

/** bundle 在浏览器里跑，这里给一个够用的桩（只覆盖 materialize 期会碰到的成员）。 */
globalThis.document = {
  baseURI: 'http://127.0.0.1:1/',
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
}

let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(record) { loaded = record },
  },
}

const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const PACKAGE_NAME = manifest.name

const bundleSource = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
// classic script：自注册到 window.__ModuleLoader__，用间接 eval 跑。
new Function('window', 'document', bundleSource)(globalThis.window, globalThis.document)

check('bundle 调用了 window.__ModuleLoader__.load', loaded !== null)
if (loaded === null) {
  console.error('\nbundle 没有自注册，后续检查无法进行')
  process.exit(1)
}
check(`bundle id 等于 package.json 的 name（${PACKAGE_NAME}）`, loaded.id === PACKAGE_NAME, loaded.id)

/** 平台种子模块表：本插件只依赖 react。 */
const seeded = { react: React }
const clientExports = loaded.factory((id) => {
  if (seeded[id] !== undefined) return seeded[id]
  throw new Error(`${PACKAGE_NAME}: 运行期请求了未提供的平台模块 "${id}"`)
})

check('导出 apply', typeof clientExports.apply === 'function')
check('导出 inject 数组', Array.isArray(clientExports.inject))
check("inject 声明了 'slots'", clientExports.inject?.includes('slots') === true)
check("PANEL_ID 是 'studio'", clientExports.PANEL_ID === 'studio', clientExports.PANEL_ID)

// ---------------------------------------------------- apply() 的槽位注册

const registrations = []
const stubSlots = {
  register(options, component) {
    registrations.push({ options, component })
    return () => {}
  },
  inject(key, callback) {
    registrations.push({ injected: key })
    return callback()
  },
}

clientExports.apply({ get: (name) => (name === 'slots' ? stubSlots : undefined) })

const sidebar = registrations.find((item) => item.options?.name === 'sidebar.panellist')
const main = registrations.find((item) => item.options?.name === 'main')

check('注册了 sidebar.panellist', sidebar !== undefined)
check('注册了 main', main !== undefined)
check("sidebar.panellist 的 id 是 'studio'", sidebar?.options?.id === 'studio', sidebar?.options?.id)
check('sidebar.panellist 的 order 是 -1（排在「插件」order=0 之上）', sidebar?.options?.order === -1, sidebar?.options?.order)
check(
  'sidebar.panellist 的 label() 返回「图像创作」',
  typeof sidebar?.options?.label === 'function' && sidebar.options.label() === '图像创作',
  typeof sidebar?.options?.label === 'function' ? sidebar.options.label() : sidebar?.options?.label,
)
check("main 的 key 是 'studio'（与侧栏 id 相同 —— 接线靠这个）", main?.options?.key === 'studio', main?.options?.key)
check('侧栏 id 与主区 key 完全一致', sidebar?.options?.id === main?.options?.key)

// 退化路径：slots 不可用时 apply() 不能抛（抛错会把整个 web 启动带下水）。
let degradedThrew = false
try {
  clientExports.apply({ get: () => undefined })
} catch {
  degradedThrew = true
}
check('slots 不可用时 apply() 退化为静默跳过而不是抛出', !degradedThrew)

// --------------------------------------------------------------- 组件渲染

const h = React.createElement

const icon16 = render(h(clientExports.SidebarIcon, { size: 16, active: false }), 'SidebarIcon(16)')
checkContains(icon16, 'width="16"', 'SidebarIcon 用壳下发的 size=16')
checkContains(icon16, 'height="16"', 'SidebarIcon 高度跟随 size')

const icon18 = render(h(clientExports.SidebarIcon, { size: 18, active: true }), 'SidebarIcon(18)')
checkContains(icon18, 'width="18"', 'SidebarIcon 跟随收起态的 size=18')

// M3：默认模式是「图 → 词」，所以首帧渲染的是反推工作区。
const panel = render(h(clientExports.StudioPanel), 'StudioPanel 首帧')
checkContains(panel, '图像创作', '面板标题「图像创作」')
checkContains(panel, '图 → 词', '顶栏有「图 → 词」模式按钮')
checkContains(panel, '词 → 图', '顶栏有「词 → 图」模式按钮')
checkContains(panel, '参考图', '左栏有参考图区')
checkContains(panel, '反推参数', '右栏有「反推参数」带（v2 要求的横排布局）')
// 2026-11-07：反推前必须显示当前聊天模型（拿不到时禁用反推，不静默回落）
checkContains(panel, '模型检测中', '参数带显示当前聊天模型探测状态')
checkContains(panel, '模型检测中', '首帧处于模型探测中（不会伪造模型名）')
checkNotContains(panel, 'opencode-go', '界面不出现硬编码兜底模型名')
// M4：换人/服装/姿态/重绘四组互斥档位 + 锁脸
checkContains(panel, 'A1 只换脸', '参数带：换人 A1 档')
checkContains(panel, 'A2 换脸+身材', '参数带：换人 A2 档')
checkContains(panel, 'A3 全身含姿态', '参数带：换人 A3 档')
checkContains(panel, 'B1 保留原图', '参数带：服装 B1 档')
checkContains(panel, 'B2 跟参考图', '参数带：服装 B2 档')
checkContains(panel, 'B3 自填', '参数带：服装 B3 档')
checkContains(panel, 'C1 保持原图', '参数带：姿态 C1 档')
checkContains(panel, 'D1 保守', '参数带：重绘 D1 档')
checkContains(panel, 'D2 平衡', '参数带：重绘 D2 档')
// 2026-11-08：老板拍板「图生文的参考图不带进文生图」，这个开关一起删掉。
// 断言它真的从界面上消失 —— 留着按钮却不再起作用比没有更难查。
checkNotContains(panel, '生图时带原图', '参数带不再有「生图时带原图」开关（2026-11-08 删除）')
checkContains(panel, '锁定', '参数带有锁定组')
checkContains(panel, 'NSFW', '参数带有 NSFW 组')
// 换人没开时不显示锁脸强度（默认不换人 → 该组隐藏）
// 用标签元素形式判定（'锁脸' 三个字也会出现在 D3 的提示文案里，不能直接查字符串）
checkNotContains(panel, '>锁脸<', '不换人时不显示锁脸强度组')
checkContains(panel, '提示词', '提示词区标题存在（单版，已按老板要求下线三版 tab）')
checkNotContains(panel, '精简版', '不再出现三版 tab 的「精简版」（2026-11-07 下线）')
checkContains(panel, '还没有提示词', '未反推时提示词区为空态')
checkContains(panel, '用这段去生图', '底部有「用这段去生图」交接按钮')
checkNotContains(panel, '宿主路由不可用', '宿主连通时不显示告警条')
checkNotContains(panel, 'undefined', '首帧没有把 undefined 渲染进文本')

// 生图那半仍然可渲染（M1 搬过来的整块，M3 只是换了个地方挂）
const imagePane = render(h(clientExports.ImageGenPanel), 'ImageGenPanel')
checkContains(imagePane, '提示词', '生图面板：提示词输入区')
checkContains(imagePane, '参考图', '生图面板：参考图槽')
// 2026-11-15：参考图支持直接 Ctrl+V 粘贴（老板需求 2）。提示文案必须真的渲染出来 ——
// 粘贴监听挂没挂这里测不到（SSR 不跑 effect），但「用户看得见入口」是能断言的。
checkContains(imagePane, 'Ctrl+V 粘贴', '生图面板：参考图区提示支持 Ctrl+V 粘贴')
checkContains(imagePane, '历史记录', '生图面板：历史条')
checkContains(imagePane, '连接配置', '生图面板：连接配置入口')

// 反推工作区单独渲染（给它一个回调，确认 props 契约成立）
const reversePane = render(h(clientExports.ReversePane, { onUsePrompt: () => {} }), 'ReversePane')
checkContains(reversePane, '把图片拖到这里', '反推：空图态有拖入提示')
checkContains(reversePane, '拖入 / Ctrl+V / 点击', '反推：三种选图入口都写出来了')
checkContains(reversePane, '反推', '反推：主按钮存在')

// 纯函数：六段解析（模型按格式输出 → 结构化；不按格式 → 原样兜底）
const six = [
  '# 0 - 任务目标（Task Objective）',
  '复刻一张室内人像。',
  '# 1 - 主体／核心视觉元素（Subject）',
  '1.1 面部 100% 取自参考图 1。',
  '# 2 - 风格（Style）',
  '日系柔光。',
  '# 3 - 镜头与构图（Shot）',
  '85mm 定焦。',
  '# 4 - 场景元素与环境（Setting）',
  '室内窗边。',
  '# 5 - 场景光照与影调（Scene Lighting）',
  '自然窗光。',
  '# 6 - 约束条件（Hard Constraints）',
  '必须保留：构图。',
].join('\n')
const parsed = clientExports.parseSections(six)
// 编号 0..6 共 7 个标题（「六段」指 1-6 这六个内容段，0 是任务目标）。
check('parseSections：0-6 七个标题全部解析出', parsed.length === 7, `${parsed.length} 段`)
check('parseSections：标题去掉英文括注', parsed[0]?.title === '# 0 - 任务目标', parsed[0]?.title)
check('parseSections：英文标签单独保留', parsed[0]?.en === 'Task Objective', parsed[0]?.en)
check('parseSections：不按格式的散文回退为空数组', clientExports.parseSections('这是一段散文，没有六段结构。').length === 0)

// 纯函数：画幅推断
check('aspectOf：1:1', clientExports.aspectOf(1024, 1024) === '1:1')
check('aspectOf：3:4', clientExports.aspectOf(1536, 2048) === '3:4')
check('aspectOf：16:9', clientExports.aspectOf(1920, 1080) === '16:9')
check('aspectOf：非法尺寸回退', clientExports.aspectOf(0, 0) === '—')

// 锁定维度默认值与旧插件一致（老板没提过要改）
check('默认锁 4 个维度', clientExports.DEFAULT_LOCKS.length === 4, clientExports.DEFAULT_LOCKS.join('、'))
check('六维定义齐全', clientExports.LOCK_DIMENSIONS.length === 6)

// 侧栏那一行的 label 是函数：壳每次取都会调，第二次取必须还是同一个值。
check(
  'label() 可重复调用且结果稳定',
  sidebar?.options?.label?.() === '图像创作' && sidebar?.options?.label?.() === '图像创作',
)

// ---------------------------------------------------------------------- 汇总

console.log()
if (failures.length > 0) {
  console.error(`${failures.length} 项失败：`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('渲染自检全绿')
}
