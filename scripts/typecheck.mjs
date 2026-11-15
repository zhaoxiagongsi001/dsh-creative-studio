/**
 * 类型自检：只抓「写了不存在的名字」这一类错误。
 *
 * 为什么要有这个脚本（2026-11-15）：`scripts/build.mjs` 用 `ts.transpileModule`
 * 转译，**不做类型检查** —— 于是 `Composer.tsx` 里一句
 * `addFilesRef.current(files)`（`files` 根本没定义，应为 `read.files`）一路绿着
 * 进了产物，运行时 `ReferenceError` 让「Ctrl+V 粘参考图」静默失效，老板报上来才发现。
 *
 * 全量 tsc 跑不动（本包没有 node_modules，没有 @types/react，会有成片的
 * 「找不到模块」噪音），所以这里只列几个**纯局部、与外部类型无关**的诊断码：
 *
 *   2304 找不到名字（Cannot find name）
 *   2552 找不到名字（带拼写建议的 2304 变体）
 *   2448 块级变量在自己声明之前被使用
 *   2454 变量在赋值之前被读取
 *   2305 模块没有导出这个成员（`import { x }` 拼错时）
 *
 * 这几个错误的共同点：不需要知道 React / DOM 的类型就能判定「这行代码一定有问题」，
 * 所以零噪音 —— 只有真错了才报。
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WATCHED = new Set([2304, 2552, 2448, 2454, 2305])

/** TypeScript 不在本包 node_modules 里（见 build.mjs 同款回退）。 */
async function loadTypeScript() {
  const candidates = [
    'typescript',
    pathToFileURL(path.join(ROOT, '..', 'dsh-prompt-forge', 'node_modules', 'typescript', 'lib', 'typescript.js')).href,
  ]
  for (const specifier of candidates) {
    try {
      return (await import(specifier)).default ?? (await import(specifier))
    } catch {
      // 试下一个来源
    }
  }
  throw new Error('找不到 typescript；请确认 ../dsh-prompt-forge/node_modules/typescript 存在')
}

const ts = await loadTypeScript()

/** 收集 src 下全部 .ts/.tsx（手写遍历，避免依赖 glob）。 */
async function sources(dir) {
  const { readdir } = await import('node:fs/promises')
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await sources(absolute)))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(absolute)
  }
  return found
}

const files = await sources(path.join(ROOT, 'src'))
const program = ts.createProgram(files, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  noEmit: true,
  skipLibCheck: true,
  strict: true,
  types: [],
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
})

const diagnostics = ts.getPreEmitDiagnostics(program).filter((item) => WATCHED.has(item.code))
if (diagnostics.length === 0) {
  console.log(`✓ 类型自检通过（${files.length} 个源文件，无未定义名字 / 提前使用）`)
  process.exit(0)
}

const host = {
  getCanonicalFileName: (name) => name,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => '\n',
}
console.error(`✗ 类型自检失败：${diagnostics.length} 处`)
console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
process.exit(1)
