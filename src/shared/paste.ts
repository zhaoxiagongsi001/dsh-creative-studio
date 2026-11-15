/**
 * 剪贴板粘贴解析（纯函数，无 DOM 依赖）。
 *
 * 抽出来的唯一原因：`paste` 的取图规则（items → files 两级兜底、图文混排让文字优先）
 * 是这次改版最容易回归的一段，但浏览器事件在离线自检里根本触发不了。把「从剪贴板
 * 数据里读出什么」与「读出来之后怎么进参考图槽」拆开，前者就能在 node 里用假对象
 * 直接断言（见 `scripts/paste-check.mjs`）。
 *
 * 这里刻意只用结构化最小接口，不 import `File` / `ClipboardEvent`：
 * 宿主 bundle 也会打包本文件，带上 DOM 类型会让 node 侧编译目标不干净。
 */

/** `DataTransferItem` 里我们关心的那几个字段。 */
export interface PasteItemLike {
  /** `'file'` 才是文件；`'string'` 是文字/HTML。 */
  readonly kind?: string
  /** MIME 类型，如 `image/png`。 */
  readonly type?: string
  /** 取回对应的文件；Chromium 对只带 HTML `<img>` 的来源会返回 null。 */
  getAsFile?: () => { readonly type?: string } | null
}

/** 一次 `paste` 事件里用到的剪贴板数据子集。 */
export interface PasteDataLike {
  readonly items?: ArrayLike<PasteItemLike> | null
  readonly files?: ArrayLike<{ readonly type?: string }> | null
  readonly types?: ArrayLike<string> | null
  getData?: (format: string) => string | undefined | null
}

/** 解析结果。 */
export interface PasteImages<T> {
  /** 剪贴板里拿得到的图片文件（按出现顺序）。 */
  readonly files: T[]
  /** 剪贴板自称有图，却一个 File 都没给出来（只带 `<img>` 的网页 HTML 常见）。 */
  readonly unreadable: boolean
  /** 同时带着**非空**文字 —— 图文混排时文字优先，调用方不该拦这次粘贴。 */
  readonly hasText: boolean
}

/**
 * 从一次粘贴里取出图片文件。
 *
 * 取图两级兜底：先看 `items` 里的 file 项，再退回 `files`
 * （部分录屏 / 截图工具、终端只填后者）。
 *
 * @param data - 粘贴事件里的 `clipboardData`。
 * @returns 图片文件、是否「有图但读不出」、是否同时带文字。
 */
export function readPasteImages<T extends { readonly type?: string }>(
  data: PasteDataLike | null | undefined,
): PasteImages<T> {
  const files: T[] = []
  if (data !== null && data !== undefined) {
    const items = data.items
    if (items !== null && items !== undefined) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]
        if (item === undefined) continue
        if (item.kind !== 'file') continue
        const type = typeof item.type === 'string' ? item.type : ''
        if (!type.startsWith('image/')) continue
        const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null
        if (file !== null && file !== undefined) files.push(file as unknown as T)
      }
    }
    if (files.length === 0) {
      const fallback = data.files
      if (fallback !== null && fallback !== undefined) {
        for (let index = 0; index < fallback.length; index += 1) {
          const file = fallback[index]
          if (file === undefined) continue
          const type = typeof file.type === 'string' ? file.type : ''
          if (type.startsWith('image/')) files.push(file as unknown as T)
        }
      }
    }
  }
  // 用 getData 而不是 types.includes('text/plain')：剪贴板常年挂着一个空的 text/plain 槽，
  // 拿它判会把纯截图也一起拦掉（真机踩过）。
  const text = typeof data?.getData === 'function' ? data.getData('text/plain') : null
  const hasText = typeof text === 'string' && text !== ''
  const types = data?.types ?? []
  let claimsImage = false
  for (let index = 0; index < types.length; index += 1) {
    const type = types[index]
    if (typeof type === 'string' && type.startsWith('image/')) {
      claimsImage = true
      break
    }
  }
  return { files, unreadable: files.length === 0 && claimsImage, hasText }
}
