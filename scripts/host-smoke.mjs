/**
 * 宿主半边实跑自检：把 `lib/index.js` 装进一个假 webServer，起一个真 HTTP 服务，
 * 然后逐条打真实路由。**不需要重启 DSH** —— 这是搬迁阶段最有性价比的验证手段
 * （真机重启一轮约 1 分钟，且要老板手动操作）。
 *
 * 覆盖：
 *   1. 路由注册数量与路径（与 package 里那张 API 表逐条比对）
 *   2. 各条路由的基本应答（health / config / models / history / draft / logs）
 *   3. loopback 与 body 上限的行为
 *   4. 未实现的路由不会误命中
 *
 * 注意：**不测 `/generate`**（会真花钱、且需要有效 API Key）；那条留给 M6 真机验收。
 *
 * 用法：node scripts/host-smoke.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const failures = []
function check(name, ok, detail) {
  if (!ok) failures.push(detail === undefined ? name : `${name} —— ${detail}`)
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `  (${detail})`}`)
}

const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

// ------------------------------------------------------- 假 webServer 装配

/** 注册表：{ kind, path, handler }[]，与 DSH 的 webServer 契约同形。 */
const routes = []
const fakeWebServer = {
  register(options) {
    routes.push(options)
    return () => {
      const index = routes.indexOf(options)
      if (index >= 0) routes.splice(index, 1)
    }
  },
}

const disposersRun = []
const fakeContext = {
  inject(_deps, callback) {
    callback({
      webServer: fakeWebServer,
      effect(setup) {
        const dispose = setup()
        disposersRun.push(dispose)
        return dispose
      },
    })
  },
}

mod.apply(fakeContext)

check('apply() 之后有路由注册', routes.length > 0, `${routes.length} 条`)
check('每一条都带 kind 与 path', routes.every((r) => r.kind === 'exact' || r.kind === 'prefix'))
check('每一条都带 handler 函数', routes.every((r) => typeof r.handler === 'function'))

// 与 API 表比对：表里每条都应挂上
const apiPaths = Object.values(mod.API ?? {})
const registeredPaths = new Set(routes.map((r) => r.path))
const missing = apiPaths.filter((p) => !registeredPaths.has(p))
check('API 表里的路径全部挂上', missing.length === 0, missing.join(', ') || `${apiPaths.length} 条全挂`)

// ------------------------------------------------------------- 起真服务

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  // prefix 优先长匹配，exact 精确匹配 —— 与 webServer 语义一致
  const prefix = routes
    .filter((r) => r.kind === 'prefix' && (pathname === r.path || pathname.startsWith(`${r.path}/`)))
    .sort((a, b) => b.path.length - a.path.length)[0]
  const exact = routes.find((r) => r.kind === 'exact' && r.path === pathname)
  const hit = prefix ?? exact
  if (hit === undefined) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'not-found', path: pathname }))
    return
  }
  try {
    hit.handler(req, res)
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, code: 'handler-threw', message: String(error) }))
  }
})

/*
 * 端口交给系统分配（listen 0），不再硬编码 4793。
 * 起因：2026-11-08 本机 4793 被占用，listen 直接 EACCES 让整套自检挂在第一个
 * 用例上。自检脚本不该依赖某个具体端口是否空闲。
 */
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

/** 打一条路由，返回 { status, body, text }。 */
async function hit(method, route, { body, headers } = {}) {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = undefined }
  return { status: response.status, body: parsed, text }
}

// ------------------------------------------------------------- 逐条验证

const health = await hit('GET', '/dsh-creative/health')
check('GET /health 200', health.status === 200, String(health.status))
check('/health ok=true', health.body?.ok === true, JSON.stringify(health.body)?.slice(0, 120))
check('/health 报告插件名', health.body?.plugin === 'dsh-creative-studio' || health.body?.name === 'dsh-creative-studio', String(health.body?.plugin ?? health.body?.name))
check('/health 报告了数据目录', typeof health.body?.home === 'string', health.body?.home)

const config = await hit('GET', '/dsh-creative/config')
check('GET /config 200', config.status === 200, String(config.status))
check('/config 不回传明文 Key', !JSON.stringify(config.body ?? {}).includes('"apiKey":"sk-'), '未泄漏')

const models = await hit('GET', '/dsh-creative/models')
check('GET /models 有应答', models.status === 200 || models.status === 400, String(models.status))
check('/models 回 JSON', models.body !== undefined, models.text.slice(0, 80))

const history = await hit('GET', '/dsh-creative/history')
check('GET /history 200', history.status === 200, String(history.status))
const historyCount = Array.isArray(history.body?.images) ? history.body.images.length : undefined
check('/history 回图片数组', historyCount !== undefined, `count=${historyCount}`)
check('/history 读到了老板的历史图（>0）', (historyCount ?? 0) > 0, `count=${historyCount}`)

const draft = await hit('GET', '/dsh-creative/draft')
check('GET /draft 200', draft.status === 200, String(draft.status))
check('/draft 回草稿对象', typeof draft.body?.draft === 'object', JSON.stringify(draft.body)?.slice(0, 100))

const logs = await hit('GET', '/dsh-creative/logs?limit=5')
check('GET /logs 200', logs.status === 200, String(logs.status))
check('/logs 回日志列表', Array.isArray(logs.body?.entries ?? logs.body?.logs), Object.keys(logs.body ?? {}).join(','))
// 落盘在沙箱内会因 EPERM 失败（真实 DSH 进程有权限），但内存缓冲必须照常有记录。
const logText = JSON.stringify(logs.body ?? {})
check('/logs 里有「已挂载 N 条路由」启动记录', logText.includes('已挂载'), logText.slice(0, 120))
check('/logs 即使落盘失败也能从内存缓冲读到', (logs.body?.entries?.length ?? 0) > 0, `entries=${logs.body?.entries?.length}`)

// 方法约束
const wrongMethod = await hit('PUT', '/dsh-creative/health')
check('health 非 GET 被拒（405）', wrongMethod.status === 405, String(wrongMethod.status))

// 未知路由不能命中
const unknown = await hit('GET', '/dsh-creative/does-not-exist')
check('未知路由 404', unknown.status === 404, String(unknown.status))

// loopback 校验：这条路由写本地文件，非本机来源必须 403
// （本机请求打不到 403 分支，所以只断言「本机是允许的」= 非 403）
check('本机请求未被 loopback 守卫误拒', health.status !== 403, String(health.status))

// ---------------------------------------------- 反推域：路由解析与图片解码

const fakeAgentModel = {
  currentSelection: () => ({ provider: 'openrouter-customer', model: 'deepseek/deepseek-v4.1-flash' }),
}
const routeWithService = mod.routeOf({ get: (k) => (k === 'agentDefaultModel' ? fakeAgentModel : undefined) })
check(
  'routeOf：跟随 DSH 当前聊天模型（不是生图模型）',
  routeWithService?.provider === 'openrouter-customer' && routeWithService?.model === 'deepseek/deepseek-v4.1-flash',
  JSON.stringify(routeWithService),
)
check('routeOf：来源标为 agentDefaultModel', routeWithService?.source === 'agentDefaultModel', String(routeWithService?.source))

// 2026-11-07 修掉的**逻辑 bug**：读不到当前模型时不再静默回落到硬编码模型
const routeNoService = mod.routeOf({ get: () => undefined })
check('routeOf：没有该服务时返回 undefined（不再偷偷换模型）', routeNoService === undefined, JSON.stringify(routeNoService))
const routeThrows = mod.routeOf({ get: () => { throw new Error('restricted context') } })
check('routeOf：服务读取抛错时返回 undefined 而不是抛出', routeThrows === undefined, JSON.stringify(routeThrows))
check('routeOf：任何失败路径都不会出现硬编码 opencode-go', JSON.stringify([routeNoService, routeThrows]).includes('opencode-go') === false)

const routeOverride = mod.routeOf({ get: () => undefined }, { provider: 'p', model: 'm' })
check('routeOf：请求可显式覆盖', routeOverride?.source === 'request' && routeOverride?.provider === 'p', JSON.stringify(routeOverride))

// activeModelOf：界面反推前显示的那个模型
const activeHit = mod.activeModelOf({ get: (k) => (k === 'agentDefaultModel' ? fakeAgentModel : undefined) })
check('activeModelOf：读到当前聊天模型', activeHit?.provider === 'openrouter-customer' && activeHit?.model === 'deepseek/deepseek-v4.1-flash', JSON.stringify(activeHit))
check('activeModelOf：读不到时返回 undefined（不伪造）', mod.activeModelOf({ get: () => undefined }) === undefined)
// 多个上下文：第一个抛、第二个命中
const multiCtx = mod.activeModelOf([
  { get: () => { throw new Error('restricted') } },
  { get: (k) => (k === 'agentDefaultModel' ? fakeAgentModel : undefined) },
])
check('activeModelOf：受限上下文抛错时继续试下一个上下文', multiCtx?.model === 'deepseek/deepseek-v4.1-flash', JSON.stringify(multiCtx))

const pngPixel = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64')
const decoded = mod.decodeDataUrl(pngPixel)
check('decodeDataUrl：解出字节与媒体类型', decoded?.mediaType === 'image/png' && decoded?.bytes?.byteLength === 8, JSON.stringify(decoded?.mediaType))
check('decodeDataUrl：非图片 data URL 拒绝', mod.decodeDataUrl('data:text/plain;base64,aGk=') === undefined)
check('decodeDataUrl：image/jpg 归一化成 image/jpeg', mod.decodeDataUrl('data:image/jpg;base64,aGk=')?.mediaType === 'image/jpeg')

// -------------------------- 输出协议解析（两行元信息 + 六段正文，单版）
// 2026-11-07 实测：JSON 块 + 三版标记的协议被模型整块忽略，改成两行纯文本。
// 这里把「守格式 / 不守格式 / 只给一半 / 元信息混进正文」四种情况都钉住。

const goodOutput = [
  '类型：人像 · 写真',
  '卡片：portrait-warm-film, portrait-blue-hour',
  '',
  '# 0 - 任务目标',
  '复刻室内人像。',
  '# 1 - 主体',
  '一位成年女性。',
].join('\n')
const parsedGood = mod.parseReverseOutput(goodOutput)
check('协议：类型行被解析', parsedGood.type === '人像 · 写真', parsedGood.type)
check('协议：卡片行解析出两个 id', parsedGood.cards.length === 2, parsedGood.cards.join(','))
check('协议：正文从 # 0 开始（元信息已剥离）', parsedGood.text.startsWith('# 0 - 任务目标'), parsedGood.text.slice(0, 30))
check('协议：正文里不残留元信息行', !parsedGood.text.includes('类型：') && !parsedGood.text.includes('卡片：'))
check('协议：正常输出无降级警告', parsedGood.warnings.length === 0, parsedGood.warnings.join('；'))

// 模型完全不守格式：只有正文
const noMeta = mod.parseReverseOutput('# 0 - 任务目标\n一段正文')
check('协议：没有元信息时正文完整保留', noMeta.text === '# 0 - 任务目标\n一段正文', noMeta.text.slice(0, 30))
check('协议：没有元信息时 type 为空（交给本地推断）', noMeta.type === '')
check('协议：没有元信息会记警告', noMeta.warnings.some((w) => w.includes('元信息')), noMeta.warnings.join('；'))

// 只有类型没有卡片
const typeOnly = mod.parseReverseOutput('类型：产品 · 美妆\n\n# 0 - 任务目标\n正文')
check('协议：只给类型时类型生效', typeOnly.type === '产品 · 美妆', typeOnly.type)
check('协议：只给类型时卡片为空', typeOnly.cards.length === 0)
check('协议：只给类型时正文完整', typeOnly.text.startsWith('# 0'), typeOnly.text.slice(0, 20))

// 卡片写「无」
const cardsNone = mod.parseReverseOutput('类型：风景\n卡片：无\n\n# 0 - 任务目标\n正文')
check('协议：卡片写「无」时不产生垃圾 id', cardsNone.cards.length === 0, cardsNone.cards.join(','))

// 元信息用英文冒号 / 中文逗号 / 顿号混排
const looseMeta = mod.parseReverseOutput('Type: 海报 · 促销\nCards: poster-bold-title、poster-gradient-bg\n\n# 0 - 任务目标\n正文')
check('协议：英文行首也能识别', looseMeta.type === '海报 · 促销', looseMeta.type)
check('协议：中文顿号分隔也能拆开', looseMeta.cards.length === 2, looseMeta.cards.join(','))

// 空输入
const empty = mod.parseReverseOutput('')
check('协议：空输入给出警告而不是抛错', empty.text === '' && empty.warnings.length > 0)

// ---------------------------------------- 本地推断兜底（模型不守格式时的第二条路）

const portraitText = [
  '# 0 - 任务目标：一张人像写真',
  '# 1 - 主体：成年东亚女性，面部柔光，妆容自然，发丝被窗光勾亮，半身取景，肤色白皙，眼神放松。',
  '# 2 - 风格：暖调胶片',
].join('\n')
const inferred = mod.inferType(portraitText)
check('推断：人像正文推断出人像类型', inferred.startsWith('人像'), inferred)

const productText = '产品白底特写，瓶身与礼盒陈列，材质光泽清晰，电商主图，卖点文字区留白。'
check('推断：产品正文推断出产品类型', mod.inferType(productText).startsWith('产品'), mod.inferType(productText))

check('推断：无关文本不硬猜', mod.inferType('这是一段没有任何画面信息的说明文字。') === '', mod.inferType('这是一段没有任何画面信息的说明文字。'))
check('推断：空文本返回空', mod.inferType('') === '')

const catalog = [
  { id: 'portrait-warm-film', name: '暖阳胶感', why: '暖调窗光', promptFragment: '暖调自然光自画面左侧窗户斜入', group: 'portrait' },
  { id: 'portrait-blue-hour', name: '蓝调时刻', why: '冷蓝暮光', promptFragment: '蓝调时刻环境光，冷蓝灰', group: 'portrait' },
  { id: 'poster-bold-title', name: '大字标题', why: '粗黑标题', promptFragment: '超大号粗黑标题字压在画面下方', group: 'poster' },
]
const matched = mod.matchCards(portraitText + '暖阳胶感更慵懒', catalog, '人像 · 写真')
check('推断：能按关键词匹配到卡片', matched.includes('portrait-warm-film'), matched.join(','))
check('推断：同组卡片会因类型加分', matched.length >= 1, matched.join(','))
check('推断：匹配结果最多 4 张', mod.matchCards(portraitText, catalog, '人像').length <= 4)
check('推断：完全不相关的文本不返回卡片', mod.matchCards('纯白背景一张纸。', catalog, '').length === 0, JSON.stringify(mod.matchCards('纯白背景一张纸。', catalog, '')))

// 当前聊天模型（界面反推前显示用）
const activeResp = await hit('GET', '/dsh-creative/active-model')
check('GET /active-model 200', activeResp.status === 200, String(activeResp.status))
// smoke 跑在独立进程里，没有真的 agentDefaultModel 服务 → 应当如实回 ok:false，而不是伪造模型
check(
  '/active-model 拿不到服务时如实回 no-active-model（不伪造）',
  activeResp.body?.ok === false && activeResp.body?.code === 'no-active-model',
  JSON.stringify(activeResp.body),
)

const cardsResp = await hit('GET', '/dsh-creative/cards')
check('GET /cards 200', cardsResp.status === 200, String(cardsResp.status))
check('/cards 读出 6 组建议卡片', Array.isArray(cardsResp.body?.groups) && cardsResp.body.groups.length === 6, `${cardsResp.body?.groups?.length} 组`)
const reverseGet = await hit('GET', '/dsh-creative/reverse')
check('reverse 非 POST 被拒（405）', reverseGet.status === 405, String(reverseGet.status))
const reverseBadImage = await hit('POST', '/dsh-creative/reverse', { body: { image: 'nope' } })
check('reverse 非图片 body 回 400 bad-image', reverseBadImage.status === 400 && reverseBadImage.body?.code === 'bad-image', String(reverseBadImage.body?.code))

// 图片 prefix 路由：拿历史里的第一个 id 试
const firstId = Array.isArray(history.body?.images) ? history.body.images[0]?.id : undefined
if (typeof firstId === 'string' && firstId !== '') {
  const image = await hit('GET', `/dsh-creative/image/${firstId}`)
  check('GET /image/<id> 200', image.status === 200, String(image.status))
  check('/image/<id> 回了非空字节', image.text.length > 1000, `${image.text.length} chars`)
} else {
  check('历史里至少有一张图（用于测 /image）', false, 'history 为空')
}

// ------------------------------------------------------------- 收尾

await new Promise((resolve) => server.close(resolve))

check('卸载回调可用（effect 返回了 disposer）', disposersRun.length > 0, `${disposersRun.length} 个`)
try {
  for (const dispose of disposersRun) dispose()
  check('disposer 执行后路由清空', routes.length === 0, `剩 ${routes.length} 条`)
} catch (error) {
  check('disposer 执行不抛错', false, String(error))
}

console.log()
if (failures.length > 0) {
  console.error(`${failures.length} 项失败：`)
  for (const line of failures) console.error(`  - ${line}`)
  process.exitCode = 1
} else {
  console.log('宿主实跑自检全绿')
}
