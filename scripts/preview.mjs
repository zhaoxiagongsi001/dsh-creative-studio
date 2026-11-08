/**
 * 把面板渲染成一张可双击打开的静态预览页（离线、无需 DSH 运行）。
 *
 * 用途：改界面时先在这里看效果，不必每次重启 DSH。
 * 产物：`preview/panel.html` —— 注入 DSH 真实 design token，双击即开。
 *
 * 用法：node scripts/preview.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const SAMPLES = [
  process.env.DSH_SAMPLE_ROOT || path.join(root, '..', 'dsh-prompt-forge'),
  root,
]

function requireFrom(specifier) {
  for (const base of SAMPLES) {
    const anchor = path.join(base, 'package.json')
    if (!existsSync(anchor)) continue
    try {
      return createRequire(anchor)(specifier)
    } catch { /* 继续找下一个 */ }
  }
  throw new Error(`找不到 ${specifier}`)
}

const React = requireFrom('react')
const ReactDOMServer = requireFrom('react-dom/server')

/** CSS Module 在首次求值时会创建 `<style data-plugin-css=...>` 并挂到 head。
 *  预览页必须把这些样式收下来，否则渲染出来是裸 HTML（一点版式都没有）。 */
const injectedStyles = []
globalThis.document = {
  baseURI: 'http://127.0.0.1:1/',
  createElement: (tagName) => ({
    tagName,
    attributes: {},
    textContent: '',
    style: {},
    setAttribute(name, value) { this.attributes[name] = value },
    appendChild() {},
  }),
  head: { appendChild: (el) => { injectedStyles.push(el) } },
  body: { appendChild() {} },
  querySelector(selector) {
    const match = /data-plugin-css=("(?:[^"\\]|\\.)*")/.exec(selector)
    if (match === null) return null
    const wanted = JSON.parse(match[1])
    return injectedStyles.find((s) => s.attributes['data-plugin-css'] === wanted) ?? null
  },
  querySelectorAll: () => [],
  getElementById: () => null,
  addEventListener() {},
  removeEventListener() {},
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load(record) { loaded = record } } }

const bundleSource = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
new Function('window', 'document', bundleSource)(globalThis.window, globalThis.document)

const seeded = { react: React }
const clientExports = loaded.factory((id) => {
  if (seeded[id] !== undefined) return seeded[id]
  throw new Error(`未提供的平台模块 "${id}"`)
})

// 拿主区组件：apply() 时注册的那个
let mainComponent = null
clientExports.apply({
  get: (name) => (name === 'slots'
    ? {
        register(options, component) {
          if (options?.name === 'main') mainComponent = component
          return () => {}
        },
        inject: (_key, callback) => callback(),
      }
    : undefined),
})

const panelHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(mainComponent))
// 词 → 图那半单独出一页（它在面板里是切模式后才挂载，静态渲染看不到）
const imageHtml = (() => {
  try {
    const exportsObj = loaded.factory((id) => {
      if (seeded[id] !== undefined) return seeded[id]
      throw new Error(`未提供的平台模块 "${id}"`)
    })
    const ImageGenPanel = exportsObj.ImageGenPanel
    return ImageGenPanel === undefined ? '' : ReactDOMServer.renderToStaticMarkup(React.createElement(ImageGenPanel))
  } catch (error) {
    console.warn('ImageGenPanel 预览渲染失败：', error?.message ?? error)
    return ''
  }
})()

/** 打包后的 CSS Module 样式（按注入顺序拼接）。 */
const moduleCss = injectedStyles.map((style) => style.textContent).join('\n')
console.log(`CSS modules injected: ${injectedStyles.length} 块 / ${(moduleCss.length / 1024).toFixed(1)} KB`)

// design token：优先用仓库里已验证的那份（生图/反推原型同款）
const tokenCandidates = [
  path.join(root, 'preview', '_tokens.css'),
  path.join(root, '..', 'creative-merge', 'prototype', '_tokens.css'),
]
const tokensPath = tokenCandidates.find((p) => existsSync(p))
const tokens = tokensPath ? readFileSync(tokensPath, 'utf8') : ''

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>图像创作 · 面板预览</title>
<style>
${tokens}
html, body { margin: 0; padding: 0; height: 100%; }
body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family); }
#root { height: 100%; }
${moduleCss}
.preview-note { position: fixed; left: 12px; bottom: 10px; z-index: 9; font-size: 10.5px; color: #c2410c; background: #fff7ed; border: 1px solid #fdba74; border-radius: 6px; padding: 2px 8px; }
</style>
</head>
<body>
<div id="root">${panelHtml}</div>
<div class="preview-note">离线预览 · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · design token 取自 DSH 真实主题</div>
</body>
</html>`

const outDir = path.join(root, 'preview')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'panel.html')
writeFileSync(outFile, html, 'utf8')
console.log(`preview written: ${outFile}  (${(html.length / 1024).toFixed(1)} KB)`)

if (imageHtml !== '') {
  const imagePage = html.replace(/<div id="root">[\s\S]*<\/div>\s*<div class="preview-note"/, `<div id="root">${imageHtml}</div>\n<div class="preview-note"`)
  const imageFile = path.join(outDir, 'panel-image.html')
  writeFileSync(imageFile, imagePage, 'utf8')
  console.log(`preview written: ${imageFile}  (${(imagePage.length / 1024).toFixed(1)} KB)`)
}
console.log(`token source: ${tokensPath ?? '（无，视觉会退化为裸样式）'}`)
