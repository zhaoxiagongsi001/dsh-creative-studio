/**
 * dsh-creative-studio 宿主/客户端一致性自检（零依赖、离线、可在沙箱内跑）。
 *
 * 为什么需要它：这类插件最常见的故障不是崩溃，而是**静默不生效**——
 *   · `sidebar.panellist` 的 id 与 `main` 的 key 不一致 → 侧栏有行、点了没反应；
 *   · `cordis.patch.yml` 的行 id 与 `PANEL_ID` 不一致 → Loader 加载了，但槽位没人认领；
 *   · 客户端写的路由字符串与宿主挂的不一致 → 前端 404，界面只表现为「没反应」；
 *   · `package.json` 的 `main`/`exports` 指向不存在的文件 → 加载即失败。
 * 这四类都写错了也不报错，所以必须离线断言。
 *
 * 用法：node scripts/host-check.mjs
 * 退出码 0 = 全绿；1 = 有失败项（逐条打印）。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const results = []

/** 记录一条断言。 */
function check(name, ok, detail) {
  results.push({ name, ok, detail })
}

/** 读一个文本文件；不存在返回 null。 */
async function readText(relative) {
  const file = path.join(root, relative)
  if (!existsSync(file)) return null
  return readFile(file, 'utf8')
}

const manifest = JSON.parse(await readText('package.json'))
const patch = await readText('cordis.patch.yml')
const clientSource = await readText('src/client/index.tsx')
const hostSource = await readText('src/index.ts')

// 1. package.json 基本形状
check('package.json 有 name', typeof manifest.name === 'string' && manifest.name !== '', manifest.name)
check('package.json 有 version', typeof manifest.version === 'string', manifest.version)
check('type 是 module', manifest.type === 'module', manifest.type)
check('声明了 dsh.bundle.patch', manifest.dsh?.bundle?.patch === './cordis.patch.yml', manifest.dsh?.bundle?.patch)
check('声明了 client.platform=web', manifest.dsh?.client?.platform === 'web', manifest.dsh?.client?.platform)

// 2. 入口文件真实存在（main / exports 的每个目标）
const entryTargets = new Set()
if (typeof manifest.main === 'string') entryTargets.add(manifest.main)
for (const value of Object.values(manifest.exports ?? {})) {
  if (typeof value === 'string' && value.startsWith('./')) entryTargets.add(value)
}
for (const rel of entryTargets) {
  if (rel.includes('*')) {
    // glob 形式的 exports（如 ./locale/*.json）：要求该目录下至少有一个匹配文件
    const dir = path.dirname(rel)
    const ext = path.extname(rel.replace('*', 'x'))
    const abs = path.join(root, dir)
    const hits = existsSync(abs) ? (await import('node:fs')).readdirSync(abs).filter((f) => f.endsWith(ext)) : []
    check(`入口可用 ${rel}`, hits.length > 0, `${hits.length} 个 ${ext}`)
    continue
  }
  check(`入口存在 ${rel}`, existsSync(path.join(root, rel)))
}

// 3. 三处 id 必须一致：package name / patch 行 id / 客户端 PANEL_ID
const patchIdMatch = /^\s*-\s*id:\s*([\w-]+)\s*$/m.exec(patch ?? '')
const patchNameMatch = /^\s*name:\s*(@?[\w./-]+)\s*$/m.exec(patch ?? '')
const panelIdMatch = /const PANEL_ID\s*=\s*'([^']+)'/.exec(clientSource ?? '')

const patchId = patchIdMatch?.[1]
const panelId = panelIdMatch?.[1]
check('cordis.patch.yml 有 insert 行 id', typeof patchId === 'string' && patchId !== '', patchId)
check('cordis.patch.yml 的 name 指向本包', patchNameMatch?.[1] === manifest.name, `${patchNameMatch?.[1]} vs ${manifest.name}`)
check('客户端 PANEL_ID 与 patch 行 id 一致', panelId !== undefined && panelId === patchId, `${panelId} vs ${patchId}`)

// 4. 客户端注册了「一个侧栏行 + 一个主区面板」，且 id 与 key 是同一条链
const hasSidebar = /name:\s*'sidebar\.panellist'/.test(clientSource ?? '')
const hasMain = /name:\s*'main'/.test(clientSource ?? '')
check('客户端注册了 sidebar.panellist', hasSidebar)
check('客户端注册了 main', hasMain)
check('侧栏 id 与主区 key 复用同一常量', /id:\s*PANEL_ID/.test(clientSource ?? '') && /key:\s*PANEL_ID/.test(clientSource ?? ''))

// 5. 宿主导出契约
const hostEntry = await readText(manifest.main.replace(/^\.\//, ''))
// 取**最后一个** export 语句：bundle 里的注释也可能出现 `export { … }` 字样，
// 取第一个会误命中注释。真正的导出语句在文件末尾。
const hostExports = [...(hostEntry ?? '').matchAll(/export \{[^}]*\}/gs)].at(-1)?.[0] ?? ''
for (const symbol of ['name', 'inject', 'apply']) {
  check(`宿主导出 ${symbol}`, new RegExp(`\\b${symbol}\\b`).test(hostExports), hostExports.slice(0, 60))
}
check('宿主声明 inject=[webServer]', /export const inject\s*=\s*\[\s*'webServer'\s*\]/.test(hostSource ?? ''))

// 6. 客户端 bundle 以包名注册（壳按包名认领）
const clientEntry = await readText(manifest.exports?.['./client']?.replace(/^\.\//, '') ?? 'lib/client.js')
check('客户端 bundle 调了 __ModuleLoader__.load', /__ModuleLoader__\.load\(/.test(clientEntry ?? ''))
check('客户端 bundle 的 id 等于包名', new RegExp(`id:\\s*["']${manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`).test(clientEntry ?? ''))

// 7. 宿主挂的路由 vs 客户端打的路径（health 是 M0 唯一一条，先验它）
const hostApiPaths = [...(hostSource ?? '').matchAll(/'(\/dsh-creative\/[\w/-]+)'/g)].map((m) => m[1])
check('宿主至少挂 1 条 /dsh-creative 路由', hostApiPaths.length > 0, hostApiPaths.join(', '))
const clientDir = path.join(root, 'src/client')
const clientFiles = (await import('node:fs')).readdirSync(clientDir)
const clientAll = (
  await Promise.all(clientFiles.map((f) => readText(`src/client/${f}`)))
).filter((text) => typeof text === 'string').join('\n')
const missingFromClient = hostApiPaths.filter((p) => !clientAll.includes(p.replace(/^\//, '')))
check('客户端引用了宿主的全部路由', missingFromClient.length === 0, missingFromClient.join(', ') || '全部命中')

// 8. 数据与文档资产（M2 起会用到，这里先确认复制到位）
check('data/suggestion-cards.json 存在', existsSync(path.join(root, 'data/suggestion-cards.json')))
check('docs/model-dialects.md 存在', existsSync(path.join(root, 'docs/model-dialects.md')))
check('docs/nsfw-tiers.md 存在', existsSync(path.join(root, 'docs/nsfw-tiers.md')))
check('docs/person-replace-spec.md 存在', existsSync(path.join(root, 'docs/person-replace-spec.md')))

// ------------------------- 副作用顺序（防止可预检失败留下垃圾）
// 2026-11-08 修：旧顺序是先 saveImages 再 routeOf，no-active-model 也会永久写一个附件对象。
// 这里按源码位置断言：模型路由检查必须出现在第一次写附件之前。
{
  const src = await readText('src/reverse/generate.ts')
  const atRoute = src.indexOf('const route = routeOf(contexts, payload)')
  const atSave = src.indexOf("refs = await saveImages([{ data: image.bytes")
  check(
    '副作用顺序：模型路由检查早于写附件',
    atRoute > 0 && atSave > 0 && atRoute < atSave,
    `routeOf@${atRoute} saveImages@${atSave}`,
  )
  const atSystem = src.indexOf('system = await buildSystem(options)')
  check(
    '副作用顺序：拼 system 也早于写附件',
    atSystem > 0 && atSystem < atSave,
    `buildSystem@${atSystem} saveImages@${atSave}`,
  )
}

// 输出
let failed = 0
for (const item of results) {
  if (item.ok) {
    console.log(`  ok   ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  } else {
    failed += 1
    console.log(`  FAIL ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} 通过`)
if (failed > 0) process.exitCode = 1
