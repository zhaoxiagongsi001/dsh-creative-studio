/**
 * 图像创作 · 面板外壳。
 *
 * 职责只有三件：
 *   1. 顶栏与模式切换（**图 → 词** / **词 → 图**）；
 *   2. 把两套工作区挂到正确的容器里（图→词是「左素材 / 右产物」两栏，词→图直接复用生图面板）；
 *   3. 两模式之间的交接：反推出提示词后点「用这段去生图」，先把提示词与参考图写进草稿，
 *      再切模式 —— 生图面板挂载时会读一次草稿，于是内容自动出现在输入框与参考图槽里。
 *
 * 为什么和旧的两个插件不一样：旧版是**两个独立面板**，靠一条跨插件 HTTP 接口
 * （`POST /dsh-imagegen/import`）传数据，坑多（面板已挂载时不生效、防抖回写会覆盖、
 * 参考图超限静默丢弃…）。合并后两半在同一个面板里，交接退化成一次草稿写入 + 一次 setState。
 *
 * 图→图 并入词→图：两者左栏元素完全相同，只是参考图必选，单列一档只是多一次点击。
 */
import { useCallback, useEffect, useState } from 'react'
import styles from './studio.module.css'
import { ImageGenPanel } from './ImageGenPanel.tsx'
import { ReversePane } from './ReversePane.tsx'
import { createHttpBackend } from './api.ts'
import type { Backend } from './types.ts'

/** 宿主健康检查路径。与 `src/index.ts` 的 `API.health` 必须字面一致。 */
const HEALTH_PATH = 'dsh-creative/health'

/** 后端单例。 */
const backend: Backend = createHttpBackend()

/**
 * 解析宿主路由的绝对路径。
 *
 * 锚点必须是 `document.baseURI` 而不是 `location.pathname`：反代挂前缀时
 * 后者会把前缀吃掉，导致 404（与 `api.ts` 的 `apiPath()` 同一套逻辑）。
 */
function apiPath(relative: string): string {
  const trimmed = relative.replace(/^\/+/, '')
  if (typeof document === 'undefined') return `/${trimmed}`
  const base = document.baseURI
  if (typeof base !== 'string' || base === '') return `/${trimmed}`
  try {
    return new URL(trimmed, base).pathname
  } catch {
    return `/${trimmed}`
  }
}

/** 模式：图 → 词 / 词 → 图。 */
type Mode = 'word' | 'image'

/** 宿主自检状态。 */
type HostState =
  | { kind: 'checking' }
  | { kind: 'ok'; stage: string; routes: string[] }
  | { kind: 'error'; message: string }

/** 面板根组件。 */
export function StudioPanel(): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('word')
  const [host, setHost] = useState<HostState>({ kind: 'checking' })
  /**
   * 交接用的「待生效」标记。
   *
   * 生图面板只在**挂载时**读一次草稿，所以顺序必须是「先写草稿 → 再切模式」。
   * 这里保存一次递增的 key，切过去时用它当 React key 强制重挂 —— 面板若已经
   * 挂着（用户从词→图切回图→词再切回来），没有这一步就不会重读草稿。
   */
  const [handoff, setHandoff] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch(apiPath(HEALTH_PATH), { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!response.ok || body?.ok !== true) {
          setHost({ kind: 'error', message: `HTTP ${response.status}` })
          return
        }
        setHost({ kind: 'ok', stage: String(body.stage ?? '?'), routes: Array.isArray(body.routes) ? body.routes : [] })
      })
      .catch((cause: unknown) => {
        if (!cancelled) setHost({ kind: 'error', message: String(cause) })
      })
    return () => { cancelled = true }
  }, [])

  /** 把反推结果交给生图面板：写草稿 → 切模式。 */
  const usePrompt = useCallback(async (text: string, image: string) => {
    try {
      await backend.importDraft({
        prompt: text,
        references: image === '' ? [] : [image],
        // 注意：**不要**传 lastGeneratedPrompt。传了与 prompt 相同的值会让生图面板
        // 判定「上次生成过」而显示空输入框，交接等于白做（IMPORT-API.md §6.1）。
      })
    } catch (error) {
      // 写草稿失败不该阻断切换 —— 退化成「模式切了但输入框是空的」，
      // 至少用户还能手动粘贴；这里把原因丢到控制台供排查。
      console.warn('[dsh-creative-studio] 交接写草稿失败：', error)
    }
    setHandoff((value) => value + 1)
    setMode('image')
  }, [])


  return (
    <div className={styles.root}>
      {host.kind === 'error' && (
        <div className={styles.hostWarn}>
          宿主路由不可用（{HEALTH_PATH}）：{host.message} —— 面板功能会大部分失效，请查看 DSH 日志。
        </div>
      )}

      <div className={styles.topBar}>
        <span className={styles.title}>图像创作</span>
        <span className={styles.sub}>
          {mode === 'word' ? '参考图 → 六段提示词' : '提示词 → 成品图'}
        </span>
        <span className={styles.spacer} />
        <div className={styles.modeSeg}>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'word' ? styles.modeOn : ''}`}
            onClick={() => setMode('word')}
          >
            图 → 词
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === 'image' ? styles.modeOn : ''}`}
            onClick={() => setMode('image')}
          >
            词 → 图
          </button>
        </div>
      </div>

      {mode === 'word' ? (
        <div className={styles.wordBody}>
          <ReversePane onUsePrompt={(text, image) => void usePrompt(text, image)} />
        </div>
      ) : (
        <div className={styles.imageBody}>
          {/* key 变化即重挂：保证每次从反推过来都重读一次草稿 */}
          <ImageGenPanel key={`imagegen-${handoff}`} />
        </div>
      )}
    </div>
  )
}

export { apiPath }
