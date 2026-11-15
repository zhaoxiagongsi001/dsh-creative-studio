/**
 * 参考图粘贴解析自检：断言「从剪贴板里读什么」这条规则在离线能复现。
 *
 * 为什么单独一个脚本：`paste` 事件只能在真浏览器里触发，render-check 只能断言
 * 「参考图区写了 Ctrl+V 粘贴」这行字，测不到真正容易回归的取图协议 ——
 * Chromium 有的来源给 `items`、有的只给 `files`、图文混排还带一个空的 text/plain 槽。
 * 规则抽到 `src/shared/paste.ts` 之后，这里用假 clipboardData 把每种形态钉死。
 *
 * 不依赖 DOM / 浏览器，不调模型，不用起 DSH。
 * 用法：node scripts/paste-check.mjs
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)

const { readPasteImages } = mod

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

/** 造一个假文件对象（只带 type 与 name，够断言用）。 */
function fakeFile(type, name = 'x') {
  return { type, name }
}

/** 造一个假 DataTransferItem。 */
function item(kind, type, file) {
  return { kind, type, getAsFile: () => file ?? null }
}

console.log('[粘贴：取图两级兜底]')
{
  // 典型截图：items 里一项 image/png。
  const png = fakeFile('image/png', 'shot.png')
  const read = readPasteImages({ items: [item('file', 'image/png', png)], types: ['Files', 'image/png'] })
  equals('items 里的图片被取出', read.files, [png])
  check('取自 items 时不判 unreadable', read.unreadable === false)
  check('只有 image/* 时 hasText 为假', read.hasText === false)
}
{
  // 部分录屏 / 终端只填 files，不填 items。
  const png = fakeFile('image/png', 'clip.png')
  const read = readPasteImages({ items: [item('string', 'text/plain', null)], files: [png], types: ['Files'] })
  equals('items 空时退回 files', read.files, [png])
}
{
  // items 与 files 都没有图 → 空。
  const read = readPasteImages({ items: [item('string', 'text/plain', null)], files: [fakeFile('text/plain')], types: ['text/plain'] })
  equals('都不是图时给空数组', read.files, [])
  check('只有文字时 unreadable 为假', read.unreadable === false)
}
{
  const read = readPasteImages(null)
  equals('clipboardData 为 null 时给空数组', read.files, [])
  check('空数据不算 unreadable', read.unreadable === false)
  check('空数据不算 hasText', read.hasText === false)
}
{
  // 一张图 + 一张非图，只收图。
  const png = fakeFile('image/png', 'a.png')
  const read = readPasteImages({
    items: [item('file', 'image/png', png), item('file', 'application/pdf', fakeFile('application/pdf'))],
  })
  equals('非图片文件被过滤', read.files, [png])
}

console.log('[粘贴：有图但读不出]')
{
  // 网页里只带 <img> 的 HTML：types 声称有图，但 getAsFile 返回 null。
  const read = readPasteImages({ items: [item('file', 'image/png', null)], types: ['Files', 'image/png'] })
  equals('读不出图时给空数组', read.files, [])
  check('types 声称有图但拿不到 → unreadable', read.unreadable === true)
}

console.log('[粘贴：文字优先（图文混排）]')
{
  const png = fakeFile('image/png', 'pasted.png')
  const data = {
    items: [item('file', 'image/png', png)],
    types: ['text/plain', 'image/png', 'Files'],
    getData: (format) => (format === 'text/plain' ? '一段文字' : ''),
  }
  const read = readPasteImages(data)
  equals('图文混排仍能取到图', read.files, [png])
  check('文字非空 → hasText 为真（调用方据此放行，不拦）', read.hasText === true)
}
{
  // 真空 text/plain 槽（纯截图常年带）：不能因此判定成「有文字」。
  const png = fakeFile('image/png', 'shot.png')
  const data = {
    items: [item('file', 'image/png', png)],
    types: ['text/plain', 'image/png'],
    getData: () => '',
  }
  const read = readPasteImages(data)
  check('空的 text/plain 槽不算文字', read.hasText === false)
  equals('纯截图照样取到图', read.files, [png])
}
{
  // 没有 getData（部分来源）时不该抛。
  const png = fakeFile('image/png', 'shot.png')
  const read = readPasteImages({ items: [item('file', 'image/png', png)], types: ['image/png'] })
  check('缺 getData 时不抛且 hasText 为假', read.hasText === false)
}

const passed = failures.length === 0
console.log(`\n${passed ? '✓ 全部通过（参考图粘贴解析）' : `✗ ${failures.length} 条失败`}`)
for (const failure of failures) console.error(`  - ${failure}`)
process.exit(passed ? 0 : 1)
