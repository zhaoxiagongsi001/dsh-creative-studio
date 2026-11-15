/**
 * 反推工作区（图 → 词）。
 *
 * 版式取自已确认的细化原型：左栏素材 + 触发，右栏「参数带 + 提示词产物」。
 * 参数带放在**右栏顶部横排**（不是左栏折叠块）—— 这是老板 2026-11-03 明确要求
 * 改掉的布局，不能退回旧形态。
 *
 * 与旧反推插件的差别：
 *   · 结果不再「送往生图」跨插件跑，而是点一下直接切到本面板的「词 → 图」模式；
 *   · 失败态给模型原文 + 可操作建议（超时/拒绝/未配置），不再只显示一行红字；
 *   · 反推中显示骨架屏与已用时，可取消。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import styles from './reverse.module.css'
import { createHttpBackend } from './api.ts'
import {
  cancelReverse,
  clearRun,
  consumePendingCards,
  pendingCards,
  runnerState,
  startReverse,
  subscribeRunner,
  type RunState,
} from './reverse-runner.ts'
import {
  DEFAULT_LOCKS,
  LOCK_DIMENSIONS,
  MAX_IMAGE_CHARS,
  MAX_IMAGE_SOFT_CHARS,
  loadReverseSnapshot,
  patchReverseSnapshot,
  saveReverseImage,
  type LoadedReverse,
} from '../reverse/persist.ts'
import type { ActiveModelResult, Backend, ReverseCard, ReverseCardGroup, ReverseOptions } from './types.ts'

/** 后端单例（整个面板共用一份，避免每次渲染重建）。 */
const backend: Backend = createHttpBackend()

/** 上传前把图缩到长边 1536：反推只需要看清构图与光影，原图直传会让请求体膨胀。 */
const MAX_EDGE = 1536
/** JPEG 质量。 */
const JPEG_QUALITY = 0.85

/**
 * 六个锁定维度与默认勾选清单已移到 `src/reverse/persist.ts`。
 *
 * 为什么搬走：持久化层也要用同一份清单去收敛「手改过的 locks 数组」，
 * 两处各写一份迟早漂移（表现为「存档里的维度名不在界面上，勾不出也取消不了」）。
 * 这里保留 re-export，原来的引用方不用改。
 */

/** 三种输出方言。 */
const DIALECTS = [
  { id: 'gpt', label: 'GPT Image' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'qwen', label: 'Qwen Image' },
] as const

/** NSFW 档位。 */
const NSFW_TIERS = [
  { id: '', label: '不处理' },
  { id: 'L1', label: 'L1 轻度' },
  { id: 'L2', label: 'L2 露骨' },
  { id: 'L3', label: 'L3 极端' },
] as const

/** 换人档位（四选一，互斥）。文案与档位来自 `person-replace-spec.md` §2。 */
const PERSON_MODES = [
  { id: 'none' as const, label: '不换人', hint: '不做身份替换，人物按原图描述' },
  { id: 'A1' as const, label: 'A1 只换脸', hint: '面部取自参考图 1，发型服装姿态照原图（推荐默认）' },
  { id: 'A2' as const, label: 'A2 换脸+身材', hint: 'A1 + 身形比例取自参考图 1，删掉三围等具体数字' },
  { id: 'A3' as const, label: 'A3 全身含姿态', hint: 'A2 + 整体姿态与肢体关系取自参考图 1，构图可让步' },
]

/** 锁脸强度（P121-123）。 */
const LOCK_STRENGTHS = [
  { id: 'short' as const, label: '短', hint: '「面部 100% 取自参考图 1，不做任何改动。」适合精简版/Gemini 短句' },
  { id: 'medium' as const, label: '中', hint: '推荐：写明五官/脸型/肤色/发际线以参考图为准，不做美化整形' },
  { id: 'strong' as const, label: '强', hint: '难图用：禁止依据文字重设任何面部特征，冲突时以参考图为准' },
]

/** 服装档位（B1/B2/B3）。 */
const CLOTHING_MODES = [
  { id: 'B1' as const, label: 'B1 保留原图', hint: '款式/领型/面料/图案完全按原图，不改颜色不加配饰（默认）' },
  { id: 'B2' as const, label: 'B2 跟参考图', hint: '服装取自目标人物图；前提是那张图能看清服装' },
  { id: 'B3' as const, label: 'B3 自填', hint: '手工描述：款式/颜色/面料/领型/下摆五项' },
]

/** 姿态档位（仅 A2/A3）。 */
const POSE_MODES = [
  { id: 'C1' as const, label: 'C1 保持原图', hint: '姿态完全按原图，只换身材' },
  { id: 'C2' as const, label: 'C2 跟参考图', hint: '姿态与肢体关系取自目标人物图' },
  { id: 'C3' as const, label: 'C3 自填', hint: '手写姿态：重心 / 躯干朝向 / 双臂 / 视线' },
]

/** 重绘强度（D1/D2/D3）。 */
const REDRAW_MODES = [
  { id: 'D1' as const, label: 'D1 保守', hint: '除脸以外一律维持原样，改动只限面部区域' },
  { id: 'D2' as const, label: 'D2 平衡', hint: '保骨架，允许背景道具褶皱自然重绘（默认）' },
  { id: 'D3' as const, label: 'D3 激进', hint: '只锁脸/姿态/影调，其余重新组织' },
]

/** B3 自填的最小校验：「款式/颜色/面料/领型/下摆」至少提到两项且 ≥10 字。 */
const CLOTHING_KEYWORDS = ['款', '颜色', '色', '面料', '材质', '领', '下摆', '袖', '版型']

/**
 * 校验 B3 自填描述。
 * @returns 不通过时返回给用户看的一句话；通过返回 undefined。
 */
function clothingIssue(text: string): string | undefined {
  const value = text.trim()
  if (value === '') return 'B3 需要填写服装描述'
  if (value.length < 10) return '太短了，至少 10 个字'
  const hits = CLOTHING_KEYWORDS.filter((keyword) => value.includes(keyword)).length
  if (hits < 2) return '请补全款式 / 颜色 / 面料 / 领型 / 下摆'
  return undefined
}

/** 运行态类型搬到了执行体（`./reverse-runner.ts`）：状态不再只属于这一次挂载。 */

/** 图片元信息（判定行的数据源）。 */
interface ImageMeta {
  width: number
  height: number
  aspect: string
}

/** 从像素尺寸粗推画幅标签。 */
function aspectOf(width: number, height: number): string {
  if (width <= 0 || height <= 0) return '—'
  const ratio = width / height
  const candidates: Array<[string, number]> = [
    ['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['3:2', 3 / 2], ['2:3', 2 / 3],
  ]
  let best = candidates[0]
  for (const candidate of candidates) {
    if (Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio)) best = candidate
  }
  return best[0]
}

/** 把文件读成 data URL。 */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 读图片自然尺寸。 */
function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({ width: 0, height: 0 })
    image.src = src
  })
}

/** 缩图到长边 ≤ MAX_EDGE，输出 JPEG（PNG 带透明度时保 PNG）。 */
async function shrink(dataUrl: string): Promise<string> {
  const size = await imageSize(dataUrl)
  const longest = Math.max(size.width, size.height)
  if (longest <= MAX_EDGE) return dataUrl
  const scale = MAX_EDGE / longest
  const targetWidth = Math.round(size.width * scale)
  const targetHeight = Math.round(size.height * scale)
  const isPng = dataUrl.startsWith('data:image/png')
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const context = canvas.getContext('2d')
      if (context === null) { resolve(dataUrl); return }
      context.drawImage(image, 0, 0, targetWidth, targetHeight)
      resolve(isPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', JPEG_QUALITY))
    }
    image.onerror = () => resolve(dataUrl)
    image.src = dataUrl
  })
}

/**
 * 存进 localStorage 前的二次压缩：长边 1024、JPEG 0.78。
 *
 * 只作用于「记住这张图」，不影响本次反推实际用的图（那是 `shrink()` 到 1536 的版本）。
 * 恢复后如果直接点「重反推」，用的是这张 1024 的副本 —— 分辨率仍够模型看清构图与光影。
 * @param dataUrl - 原始 data URL。
 * @returns 压缩后的 data URL；画布不可用时原样返回（调用方会按长度决定存不存）。
 */
async function recompressForStorage(dataUrl: string): Promise<string> {
  const size = await imageSize(dataUrl)
  if (size.width <= 0 || size.height <= 0) return dataUrl
  const scale = Math.min(1, 1024 / Math.max(size.width, size.height))
  const targetWidth = Math.max(1, Math.round(size.width * scale))
  const targetHeight = Math.max(1, Math.round(size.height * scale))
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = targetWidth
      canvas.height = targetHeight
      const context = canvas.getContext('2d')
      if (context === null) { resolve(dataUrl); return }
      context.drawImage(image, 0, 0, targetWidth, targetHeight)
      resolve(canvas.toDataURL('image/jpeg', 0.78))
    }
    image.onerror = () => resolve(dataUrl)
    image.src = dataUrl
  })
}

/** 六段正文的解析结果。 */
interface PromptSection {
  title: string
  /** 标题里的英文小标签（如 `Task Objective`）。 */
  en?: string
  lines: string[]
}

/**
 * 把模型回的文本切成六段。
 *
 * 模型偶尔不按格式输出（少一段、用了 `##`、或干脆一段散文），这时返回空数组，
 * 调用方回退到「原样显示」——绝不假装结构化去猜分界。
 */
function parseSections(text: string): PromptSection[] {
  const lines = text.split(/\r?\n/)
  const sections: PromptSection[] = []
  let current: PromptSection | undefined
  for (const line of lines) {
    const header = /^#{1,3}\s*(\d+)\s*[-–—.、]\s*(.+)$/.exec(line.trim())
    if (header !== null) {
      const rawTitle = header[2].trim()
      // 拆掉标题里的英文括注：`任务目标（Task Objective）` / `Task Objective`
      const enMatch = /[（(]\s*([A-Za-z][A-Za-z\s/]*[A-Za-z])\s*[)）]/.exec(rawTitle)
      const title = enMatch === null ? rawTitle : rawTitle.replace(enMatch[0], '').trim()
      current = { title: `# ${header[1]} - ${title}`, ...enMatch === null ? {} : { en: enMatch[1] }, lines: [] }
      sections.push(current)
      continue
    }
    if (current !== undefined && line.trim() !== '') current.lines.push(line.trim())
  }
  return sections.length >= 3 ? sections : []
}

/** 把 `**加粗**` 渲染成 <b>。 */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <b key={index}>{part.slice(2, -2)}</b>
    }
    return <span key={index}>{part}</span>
  })
}

/** 反推工作区。 */
export interface ReversePaneProps {
  /** 「用这段去生图」：只把提示词交给外壳切模式（源图不带过去，老板 2026-11-08 拍板）。 */
  onUsePrompt: (text: string) => void
}

export function ReversePane({ onUsePrompt }: ReversePaneProps): React.JSX.Element {
  /**
   * 挂载时从 localStorage 恢复一次。
   *
   * 老板 2026-11-08 报的现象：切到别的会话再切回来，刚才那张图和六段正文全没了。
   * 根因是主区面板在切会话时被卸载，而这里的图 / 正文 / 参数只活在 `useState` 里。
   * 用 ref 缓存第一次读到的结果：后续渲染不再重复读几百 KB 的图。
   */
  const bootRef = useRef<LoadedReverse | undefined>(undefined)
  if (bootRef.current === undefined) bootRef.current = loadReverseSnapshot()
  const boot = bootRef.current

  const [image, setImage] = useState(boot.image)
  const [meta, setMeta] = useState<ImageMeta>(
    boot.meta === null ? { width: 0, height: 0, aspect: '—' } : boot.meta,
  )
  // 默认参数集中在持久化层：读不到存档时也要用同一份，避免两处各写一套。
  const [options, setOptions] = useState<ReverseOptions>(boot.options)
  /**
   * 运行态来自模块作用域的执行体（`./reverse-runner.ts`）。
   *
   * 这么做是为了让「切走」不再等于「取消」：请求挂在执行体上，组件卸载只是退订，
   * 跑完照样落盘；重新挂载时这里立刻拿到 running（带真实已用秒数）或 done。
   */
  const run: RunState = useSyncExternalStore(subscribeRunner, runnerState, runnerState)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | undefined>(undefined)
  const [groups, setGroups] = useState<ReverseCardGroup[]>([])
  const [groupsNote, setGroupsNote] = useState<string | undefined>(undefined)
  const [groupIndex, setGroupIndex] = useState(0)
  /**
   * 当前 DSH 配置的**聊天模型**（反推要用它做多模态读图）。
   * `undefined` = 还在探测；`ok:false` = 拿不到，此时反推按钮禁用并说明原因。
   */
  const [activeModel, setActiveModel] = useState<ActiveModelResult | undefined>(undefined)
  const [extraOpen, setExtraOpen] = useState(false)

  const noticeTimer = useRef<number | undefined>(undefined)

  /* ------------------------------------------------------------ 跨卸载持久化

     切到别的会话时主区面板会被卸载，切回来是重新挂载。下面三段 effect 就是为这条
     生命周期写的：状态一变就写进 localStorage，挂载时（见上面的 bootRef）再读回来。
     参数 + 正文那条小，图那条大，分两条键各写各的。 */

  /**
   * 参数 + 尺寸落盘。
   *
   * 只写自己负责的字段（读-改-写）：结果、中断标记、待消费卡片由执行体写，
   * 而执行体可能在面板已经卸载之后才写 —— 两边整份覆盖会互相抹掉对方的字段。
   */
  useEffect(() => {
    patchReverseSnapshot({
      options,
      meta: meta.width > 0 && meta.height > 0 ? meta : null,
      hasImage: image !== '',
    })
  }, [options, meta, image])

  /**
   * 源图单独一条键：只在图本身变化时写。
   *
   * 超过 {@link MAX_IMAGE_SOFT_CHARS} 先压到长边 1024；压完仍超过 {@link MAX_IMAGE_CHARS}
   * 就放弃存图 —— 一张巨图会把整个 origin 的配额占满，连带把参数与正文也写不进去。
   * `imageWriteToken` 用来丢过期结果：连点两次选图时，慢的那次不该覆盖新的。
   */
  const imageWriteToken = useRef(0)
  useEffect(() => {
    const token = imageWriteToken.current + 1
    imageWriteToken.current = token
    if (image === '') { saveReverseImage(null); return }
    void (async () => {
      let value = image
      if (value.length > MAX_IMAGE_SOFT_CHARS) value = await recompressForStorage(value)
      if (imageWriteToken.current !== token) return
      if (value.length > MAX_IMAGE_CHARS) {
        saveReverseImage(null)
        console.warn(`[dsh-creative-studio] 源图 ${Math.round(image.length / 1024)} KB 超过 localStorage 预算，这张图不记住（参数与正文照常记住）`)
        return
      }
      saveReverseImage(value)
    })()
  }, [image])

  /** 恢复回来的图若没带尺寸（旧存档 / 手改过），补测一次。 */
  useEffect(() => {
    if (image === '' || (meta.width > 0 && meta.height > 0)) return
    let cancelled = false
    void imageSize(image).then((size) => {
      if (cancelled || size.width <= 0 || size.height <= 0) return
      setMeta({ width: size.width, height: size.height, aspect: aspectOf(size.width, size.height) })
    })
    return () => { cancelled = true }
  }, [image, meta])

  /** 行内提示，几秒后自动消失。 */
  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text })
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), kind === 'ok' ? 2000 : 6000)
  }, [])

  /**
   * 卸载时只清行内提示的定时器。
   *
   * **刻意不再 abort 在飞请求**（2026-11-08 修）：切到别的会话 = 面板卸载，
   * 原来这里会把一次 175 秒的反推一起掐掉。请求现在归执行体管，
   * 只有用户点「取消」才中止。
   */
  useEffect(() => () => {
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current)
  }, [])

  // 卡片库：进面板拉一次，失败只用提示，不影响反推
  useEffect(() => {
    const controller = new AbortController()
    backend.loadCards(controller.signal).then((result) => {
      setGroups(result.groups)
      setGroupsNote(result.message)
    }).catch(() => { /* loadCards 内部已兜底，这里只防未捕获拒绝 */ })
    return () => controller.abort()
  }, [])

  /**
   * 当前聊天模型：进面板拉一次，并在**每次切回图→词模式**时刷新。
   * 老板在 DSH 里换了默认模型，切回面板就能看到新的，不必重启插件。
   */
  useEffect(() => {
    const controller = new AbortController()
    setActiveModel(undefined)
    backend.activeModel(controller.signal).then(setActiveModel).catch((error: unknown) => {
      setActiveModel({ ok: false, code: 'active-model-unreachable', message: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort()
  }, [])

  /** 「重新检测模型」按钮：老板在 DSH 换模型后手动刷新。 */
  const refreshActiveModel = useCallback(() => {
    const controller = new AbortController()
    setActiveModel(undefined)
    backend.activeModel(controller.signal).then(setActiveModel).catch((error: unknown) => {
      setActiveModel({ ok: false, code: 'active-model-unreachable', message: error instanceof Error ? error.message : String(error) })
    })
  }, [])

  /**
   * 已用秒数：从 `run.startedAt` 现算，不存进 state。
   *
   * 这样「切走再回来」看到的是真实已用时间（不是从 0 重新计），而 running 态
   * 只要一个 500ms 心跳把它刷新出来。
   */
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (run.kind !== 'running') return
    const timer = window.setInterval(() => setNowTick(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [run])
  const elapsed = run.kind === 'running'
    ? Math.max(0, Math.round((nowTick - run.startedAt) / 1000))
    : run.kind === 'interrupted' ? Math.round(run.elapsedMs / 1000) : 0

  /**
   * 拿不到聊天模型时自动重探一次（与旧版行为一致：失败后立刻刷新那个 model chip）。
   */
  useEffect(() => {
    if (run.kind === 'error' && run.title === '拿不到当前聊天模型') refreshActiveModel()
  }, [run, refreshActiveModel])

  /**
   * 消费模型预勾选的推荐卡片。
   *
   * 执行体把卡片 id 存在执行体状态 / 存档里（切走也留得住），这里映射成卡片对象
   * 塞进参数，然后立刻清掉标记 —— 否则每次重挂载都会把用户手动取消的卡片又勾回来。
   */
  useEffect(() => {
    const ids = pendingCards()
    if (run.kind !== 'done' || ids.length === 0 || groups.length === 0) return
    const byId = new Map<string, ReverseCard>()
    for (const group of groups) for (const card of group.cards) byId.set(card.id, card)
    const picked = ids
      .map((id) => byId.get(id))
      .filter((card): card is ReverseCard => card !== undefined)
      .map((card) => ({
        name: card.name,
        why: card.why,
        ...card.promptFragment === undefined ? {} : { fragment: card.promptFragment },
      }))
    if (picked.length > 0) setOptions((current) => ({ ...current, cards: picked }))
    consumePendingCards()
  }, [run, groups])

  const setOpt = useCallback(<K extends keyof ReverseOptions>(key: K, value: ReverseOptions[K]) => {
    setOptions((current) => ({ ...current, [key]: value }))
  }, [])

  const toggleLock = useCallback((dimension: string) => {
    setOptions((current) => {
      const locks = current.locks ?? []
      const next = locks.includes(dimension) ? locks.filter((item) => item !== dimension) : [...locks, dimension]
      return { ...current, locks: next }
    })
  }, [])

  const toggleCard = useCallback((card: ReverseCard) => {
    setOptions((current) => {
      const cards = current.cards ?? []
      const exists = cards.some((item) => item.name === card.name)
      const next = exists
        ? cards.filter((item) => item.name !== card.name)
        : [...cards, { name: card.name, why: card.why, ...card.promptFragment === undefined ? {} : { fragment: card.promptFragment } }]
      return { ...current, cards: next }
    })
  }, [])

  /** 选图：读 → 缩 → 记尺寸。 */
  const acceptFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      flash('err', '只支持图片文件')
      return
    }
    try {
      const original = await readAsDataUrl(file)
      const reduced = await shrink(original)
      const size = await imageSize(reduced)
      setImage(reduced)
      setMeta({ width: size.width, height: size.height, aspect: aspectOf(size.width, size.height) })
      // 换图意味着上一条结果作废（它是旧图的），连中断标记一起清掉。
      clearRun()
      setNotice(undefined)
    } catch (error) {
      flash('err', `读取图片失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [flash])

  // 拖入 / 粘贴
  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer?.files?.[0]
    if (file !== undefined) void acceptFile(file)
  }, [acceptFile])

  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items
      if (items === undefined) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file !== null) { void acceptFile(file); return }
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [acceptFile])

  /**
   * 反推前置条件：有图 + 不在跑 + **拿得到当前聊天模型**。
   * 第三个条件是 2026-11-07 加的：以前读不到模型会静默回落到硬编码模型，
   * 现在宿主如实回 no-active-model，界面在反推前就禁用，不让用户白等。
   */
  const canReverse = image !== '' && run.kind !== 'running' && activeModel?.ok === true

  /**
   * 反推。
   *
   * 请求不在这里发，交给执行体（`startReverse`）：组件随时可能被卸载，
   * 而一次反推要跑 60–175 秒 —— 请求必须活得比面板久。
   */
  const reverse = useCallback(() => {
    if (image === '' || run.kind === 'running') return
    setNotice(undefined)
    startReverse(image, options)
  }, [image, options, run])

  /** 取消在飞反推：这是唯一会中止上游（省 token）的入口。 */
  const cancel = useCallback(() => {
    cancelReverse()
    flash('err', '已取消')
  }, [flash])

  /** 正文（单版）。 */
  const currentText = run.kind === 'done' ? run.text : ''
  const sections = useMemo(() => parseSections(currentText), [currentText])

  /**
   * 提示词卡片 + 六段导航（2026-11-08 界面改版新增）。
   *
   * 六段正文动辄 3000 字，卡片要滚很久才看到第 5、6 段。导航条只做两件事：
   * 点一下跳到某段、滚动时告诉你在第几段。**不碰正文渲染** —— 解析失败时
   * `sections` 为空，导航整条不出现，正文照旧走纯文本兜底。
   */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [activeSection, setActiveSection] = useState(0)

  const jumpToSection = useCallback((index: number) => {
    const box = cardRef.current
    if (box === null) return
    const heading = box.querySelectorAll('h4').item(index)
    if (heading === null) return
    const delta = heading.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTo({ top: box.scrollTop + delta - 8, behavior: 'smooth' })
    setActiveSection(index)
  }, [])

  const syncActiveSection = useCallback(() => {
    const box = cardRef.current
    if (box === null) return
    const headings = box.querySelectorAll('h4')
    const top = box.getBoundingClientRect().top
    let index = 0
    for (let i = 0; i < headings.length; i += 1) {
      const heading = headings.item(i)
      if (heading !== null && heading.getBoundingClientRect().top - top <= 32) index = i
    }
    setActiveSection(index)
  }, [])

  const selectedLocks = options.locks ?? []
  const selectedCards = options.cards ?? []
  const activeGroup = groups[groupIndex]

  /** 是否在做身份替换（决定锁脸强度与姿态档是否可用）。 */
  const personActive = (options.person ?? 'none') !== 'none'
  /** 姿态档只在 A2 / A3 可选（A1 时规范要求隐藏）。 */
  const poseAvailable = options.person === 'A2' || options.person === 'A3'
  /** B3 自填的问题提示（通过时为 undefined）。 */
  const clothingProblem = options.clothing === 'B3' ? clothingIssue(options.clothingText ?? '') : undefined

  const selectedCount =
    selectedLocks.length
    + selectedCards.length
    + (personActive ? 1 : 0)
    + (poseAvailable && (options.pose ?? 'C1') !== 'C1' ? 1 : 0)
    + ((options.clothing ?? 'B1') === 'B1' ? 0 : 1)
    + ((options.redraw ?? 'D2') === 'D2' ? 0 : 1)
    + (options.nsfw === '' || options.nsfw === undefined ? 0 : 1)

  const copyPrompt = useCallback(async () => {
    if (currentText === '') return
    try {
      await navigator.clipboard.writeText(currentText)
      flash('ok', '提示词已复制')
    } catch {
      flash('err', '复制失败：浏览器拒绝了剪贴板权限')
    }
  }, [currentText, flash])

  return (
    <>
      {/* ------------------------------ 左：素材 ------------------------------ */}
      <div className={styles.left}>
        <div className={styles.rowLabel}>
          参考图
          <span className={styles.hint}>拖入 / Ctrl+V / 点击</span>
        </div>

        <div className={styles.imgZone}>
          {image === '' ? (
            <button
              type="button"
              className={styles.imgDrop}
              onClick={() => document.getElementById('studio-reverse-file')?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={onDrop}
            >
              <b>把图片拖到这里</b>
              <span>或按 Ctrl+V 粘贴 · 或点击选择文件</span>
            </button>
          ) : (
            <>
              <img className={styles.imgPreview} src={image} alt="反推源图" />
              <button
                type="button"
                className={styles.imgClear}
                title="移除这张图"
                onClick={() => { setImage(''); setMeta({ width: 0, height: 0, aspect: '—' }); clearRun() }}
              >
                ✕
              </button>
            </>
          )}
          <div className={styles.metaBar}>
            <span className={styles.k}>{meta.width > 0 ? `${meta.width} × ${meta.height}` : '未选图'}</span>
              <span className={styles.k}>{meta.aspect}</span>
              {/* 反推成功后显示图片类型；来源只放进 title（悬停可见），默认行内保持干净 */}
            <span
              className={styles.k}
              title={
                run.kind === 'done' && run.type !== ''
                  ? run.typeSource === 'inferred'
                    ? '模型没给类型，这是按正文关键词本地推断的'
                    : '由反推模型判定'
                  : undefined
              }
            >
              {run.kind === 'done' && run.type !== ''
                ? run.type
                : DIALECTS.find((item) => item.id === (options.dialect ?? 'gpt'))?.label}
            </span>
            <span style={{ marginLeft: 'auto' }}>{image === '' ? '等待图片' : '就绪'}</span>
          </div>
        </div>

        <input
          id="studio-reverse-file"
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file !== undefined) void acceptFile(file)
            event.target.value = ''
          }}
        />

        <div className={styles.leftFoot}>
          {run.kind === 'running' ? (
            <button type="button" className={styles.reverseBtn} onClick={cancel}>
              ◐ 反推中 {elapsed}s · 点此取消
            </button>
          ) : (
            <button type="button" className={styles.reverseBtn} disabled={!canReverse} onClick={() => void reverse()}>
              ✦ {run.kind === 'done' ? '重新反推' : '反推'}
            </button>
          )}
          <div className={styles.footNote}>
            {run.kind === 'done' ? `上次 ${(run.elapsedMs / 1000).toFixed(1)}s · 失败不计费` : '六段结构 · 失败不计费'}
          </div>
          {notice !== undefined && (
            <div className={`${styles.notice} ${notice.kind === 'ok' ? styles.noticeOk : styles.noticeErr}`} title={notice.text}>
              {notice.text}
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------ 右：产物 ------------------------------ */}
      <div className={styles.right}>
        {/* 参数带：4 行横排 */}
        <div className={styles.band}>
          <div className={styles.bandTop}>
            反推参数
            <span className={styles.cnt}>已选 {selectedCount}</span>
            {/* 当前聊天模型：反推前就显示，让老板确认「现在用哪个模型反推」 */}
            <span
              className={styles.modelChip}
              title={
                activeModel === undefined
                  ? '正在读取 DSH 当前配置的聊天模型'
                  : activeModel.ok
                    ? `反推用的聊天模型：${activeModel.provider ?? '?'} / ${activeModel.model ?? '?'}（来自 DSH 当前配置，不是生图模型）。点一下可重新检测。`
                    : (activeModel.message ?? '读不到当前聊天模型')
              }
              onClick={refreshActiveModel}
            >
              {activeModel === undefined
                ? '模型检测中…'
                : activeModel.ok
                  ? `模型 ${activeModel.provider ?? '?'} / ${activeModel.model ?? '?'}`
                  : '⚠ 未检测到聊天模型'}
            </span>
            <span className={styles.right1}>{groupsNote ?? '悬停卡片看推荐理由'}</span>
          </div>
          {activeModel !== undefined && !activeModel.ok && (
            <div className={styles.modelError} title={activeModel.message ?? ''}>
              拿不到 DSH 当前配置的聊天模型，反推已禁用（不会偷偷换用其它模型）。{activeModel.message ?? ''}
            </div>
          )}

          {/* 换人四档（互斥；规范里不存在「只换身材不换脸」） */}
          <div className={styles.optRow}>
            <span className={styles.cl}>换人</span>
            {PERSON_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                className={`${styles.ck} ${(options.person ?? 'none') === mode.id ? styles.ckOn : ''}`}
                onClick={() => setOpt('person', mode.id)}
              >
                <i />{mode.label}
              </button>
            ))}
            {personActive && (
              <>
                <span className={styles.cl} style={{ marginLeft: 8 }}>锁脸</span>
                {LOCK_STRENGTHS.map((strength) => (
                  <button
                    key={strength.id}
                    type="button"
                    title={strength.hint}
                    className={`${styles.ck} ${(options.lockStrength ?? 'medium') === strength.id ? styles.ckOn : ''}`}
                    onClick={() => setOpt('lockStrength', strength.id)}
                  >
                    {strength.label}
                  </button>
                ))}
              </>
            )}
          </div>

          {/* 服装三档 + B2 前提确认 + B3 自填 */}
          <div className={styles.optRow}>
            <span className={styles.cl}>服装</span>
            {CLOTHING_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                className={`${styles.ck} ${(options.clothing ?? 'B1') === mode.id ? styles.ckOn : ''}`}
                onClick={() => setOpt('clothing', mode.id)}
              >
                <i />{mode.label}
              </button>
            ))}
            {options.clothing === 'B2' && (
              <button
                type="button"
                className={`${styles.ck} ${options.clothingVisible === true ? styles.ckOn : ''}`}
                title="B2 的前提：目标人物图里必须能看清服装；不勾则自动降为 B1"
                onClick={() => setOpt('clothingVisible', options.clothingVisible !== true)}
              >
                <i />目标图能看清服装
              </button>
            )}
            {options.clothing === 'B3' && clothingProblem !== undefined && (
              <span className={styles.warnText}>{clothingProblem}</span>
            )}
          </div>

          {options.clothing === 'B3' && (
            <div className={styles.optRow}>
              <span className={styles.cl}>自填</span>
              <input
                className={styles.textInput}
                placeholder="款式 / 颜色 / 面料 / 领型 / 下摆，例如：米白细针织长袖圆领，下摆及髋"
                value={options.clothingText ?? ''}
                onChange={(event) => setOpt('clothingText', event.target.value)}
              />
            </div>
          )}

          {/* 姿态三档（仅 A2/A3 可选）+ 重绘强度 */}
          <div className={styles.optRow}>
            <span className={styles.cl} style={{ opacity: poseAvailable ? 1 : 0.4 }}>姿态</span>
            {POSE_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                disabled={!poseAvailable}
                title={poseAvailable ? mode.hint : '姿态档只在 A2 换脸+身材 / A3 全身含姿态 时可选'}
                className={`${styles.ck} ${poseAvailable && (options.pose ?? 'C1') === mode.id ? styles.ckOn : ''}`}
                onClick={() => setOpt('pose', mode.id)}
              >
                <i />{mode.label}
              </button>
            ))}
            <span className={styles.cl} style={{ marginLeft: 8 }}>重绘</span>
            {REDRAW_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                title={mode.hint}
                className={`${styles.ck} ${(options.redraw ?? 'D2') === mode.id ? styles.ckOn : ''}`}
                onClick={() => setOpt('redraw', mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>

          {poseAvailable && options.pose === 'C3' && (
            <div className={styles.optRow}>
              <span className={styles.cl}>姿态描述</span>
              <input
                className={styles.textInput}
                placeholder="重心 / 躯干朝向 / 双臂动作 / 视线，例如：重心落左脚，躯干侧 45°，双臂自然垂落，看向镜头"
                value={options.poseText ?? ''}
                onChange={(event) => setOpt('poseText', event.target.value)}
              />
            </div>
          )}

          <div className={styles.optRow}>
            <span className={styles.cl}>锁定</span>
            {LOCK_DIMENSIONS.map((dimension) => (
              <button
                key={dimension}
                type="button"
                className={`${styles.ck} ${selectedLocks.includes(dimension) ? styles.ckOn : ''}`}
                onClick={() => toggleLock(dimension)}
              >
                <i />{dimension}
              </button>
            ))}
          </div>

          <div className={styles.optRow}>
            <span className={styles.cl}>建议</span>
            {groups.length > 1 && (
              <span className={styles.sel}>
                <select value={groupIndex} onChange={(event) => setGroupIndex(Number(event.target.value))}>
                  {groups.map((group, index) => (
                    <option key={group.type} value={index}>{group.label}</option>
                  ))}
                </select>
              </span>
            )}
            {(activeGroup?.cards ?? []).slice(0, 5).map((card) => (
              <button
                key={card.id}
                type="button"
                title={card.why}
                className={`${styles.cc} ${selectedCards.some((item) => item.name === card.name) ? styles.ccOn : ''}`}
                onClick={() => toggleCard(card)}
              >
                {card.name}
              </button>
            ))}
            {(activeGroup?.cards.length ?? 0) > 5 && (
              <span className={`${styles.cc} ${styles.ccMore}`} title={`这一套还有 ${(activeGroup?.cards.length ?? 0) - 5} 张`}>
                ＋{(activeGroup?.cards.length ?? 0) - 5}
              </span>
            )}
            {groups.length === 0 && (
              <span className={styles.hintText}>
                {groupsNote ?? '卡片库加载中…'}
              </span>
            )}
          </div>

          <div className={styles.optRow}>
            <span className={styles.cl}>NSFW</span>
            {NSFW_TIERS.map((tier) => (
              <button
                key={tier.id === '' ? 'none' : tier.id}
                type="button"
                className={`${styles.ck} ${(options.nsfw ?? '') === tier.id ? styles.ckOn : ''}`}
                onClick={() => setOpt('nsfw', tier.id)}
              >
                {tier.label}
              </button>
            ))}
            <span className={styles.cl} style={{ marginLeft: 8 }}>方言</span>
            <span className={styles.sel}>
              <select
                value={options.dialect ?? 'gpt'}
                onChange={(event) => setOpt('dialect', event.target.value as ReverseOptions['dialect'])}
              >
                {DIALECTS.map((dialect) => (
                  <option key={dialect.id} value={dialect.id}>{dialect.label}</option>
                ))}
              </select>
            </span>
            <button
              type="button"
              className={styles.ck}
              onClick={() => setExtraOpen((open) => !open)}
              title="追加一句临时要求"
            >
              {extraOpen ? '收起追加' : '＋追加要求'}
            </button>
          </div>

          {extraOpen && (
            <div className={styles.optRow}>
              <textarea
                className={styles.textArea}
                placeholder="例如：换成夜景 / 保持五官不变 / 衣服改成米色针织"
                value={options.extra ?? ''}
                onChange={(event) => setOpt('extra', event.target.value)}
              />
            </div>
          )}
        </div>

        {/* 提示词标题行（单版：老板 2026-11-07 决定不再出三版） */}
        <div className={styles.promptHead}>
          <span className={styles.label}>提示词</span>
          {run.kind === 'done' && (
            <span className={styles.hintText}>
              {DIALECTS.find((item) => item.id === (options.dialect ?? 'gpt'))?.label} 写法
            </span>
          )}
          <span style={{ marginLeft: 'auto' }} />
          {run.kind === 'done' && (
            <button type="button" className={styles.mini} onClick={() => void reverse()}>⟳ 重反推</button>
          )}
        </div>

        {/* 六段导航：只在正文真的解析出结构时出现，解析失败不占位 */}
        {run.kind === 'done' && sections.length > 0 && (
          <div className={styles.nav}>
            {sections.map((section, index) => {
              const label = section.title.replace(/^#\s*\d+\s*-\s*/, '')
              return (
                <button
                  key={index}
                  type="button"
                  className={`${styles.navPill} ${activeSection === index ? styles.navPillOn : ''}`}
                  title={`跳到第 ${index} 段：${label}`}
                  onClick={() => jumpToSection(index)}
                >
                  {index} {label}
                </button>
              )
            })}
          </div>
        )}

        {/* 提示词正文：四种态 */}
        {run.kind === 'running' ? (
          <div className={styles.stateBox}>
            <div className={styles.skelWrap}>
              <div className={styles.skelLine} style={{ height: 13 }} />
              <div className={styles.skelLine} />
              <div className={styles.skelLine} />
              <div className={styles.skelLine} />
              <div className={styles.skelLine} style={{ height: 13, marginTop: 6 }} />
              <div className={styles.skelLine} />
              <div className={styles.skelLine} />
            </div>
            <div style={{ marginTop: 10 }}>◐ 正在读图并生成提示词… {elapsed}s</div>
          </div>
        ) : run.kind === 'error' ? (
          <div className={`${styles.stateBox} ${styles.stateBoxErr}`}>
            <div className={styles.errTitle}>✕ {run.title}</div>
            {run.detail !== undefined && <div className={styles.errRaw}>{run.detail}</div>}
            {run.hint !== undefined && <div className={styles.errHint}>{run.hint}</div>}
          </div>
        ) : run.kind === 'interrupted' ? (
          // 刷新 / 关窗会把浏览器那边一起打死（改不了），但必须如实说，不装成没跑过。
          <div className={styles.stateBox}>
            <div style={{ fontSize: 20, opacity: 0.6 }}>◷</div>
            <div>上次反推被中断（刷新或关窗时打断）</div>
            <div className={styles.errHint}>
              已跑 {elapsed} 秒，结果没拿到；图和参数都还在，点「反推」重跑一次即可。
            </div>
          </div>
        ) : run.kind === 'done' ? (
          <div className={styles.promptCard} ref={cardRef} onScroll={syncActiveSection}>
            {sections.length === 0 ? (
              // 模型没按六段输出：原样显示，不假装结构化
              <pre className={styles.promptPlain}>{currentText}</pre>
            ) : sections.map((section, index) => (
              <div key={index}>
                <h4>
                  <span className={styles.secNo}>{index}</span>
                  {section.title.replace(/^#\s*\d+\s*-\s*/, '')}
                  {section.en !== undefined && <span className={styles.en}>{section.en}</span>}
                </h4>
                {section.lines.map((line, lineIndex) => (
                  <p key={lineIndex}>{renderInline(line)}</p>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.stateBox}>
            <div style={{ fontSize: 22, opacity: 0.5 }}>✦</div>
            <div>还没有提示词</div>
            <div style={{ fontSize: 11.5 }}>左边放一张图，点「反推」；参数在右上方，改完直接生效</div>
          </div>
        )}

        {/* 动作条 */}
        <div className={styles.actBar}>
          <button type="button" className={styles.mini} disabled={run.kind !== 'done'} onClick={() => void copyPrompt()}>
            复制
          </button>
          <button
            type="button"
            className={styles.mini}
            disabled={currentText === ''}
            onClick={() => {
              if (currentText === '') return
              const blob = new Blob([currentText], { type: 'text/plain;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = `prompt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.txt`
              anchor.click()
              URL.revokeObjectURL(url)
            }}
          >
            另存 txt
          </button>
          {run.kind === 'done' && (
            <span className={styles.actMeta}>
              <span className={styles.actNum}>{currentText.length} 字</span>
              {run.type !== '' && <span className={styles.actTag}>{run.type}</span>}
              {run.model !== '' && (
                <span className={styles.actNum}>{run.provider === '' ? run.model : `${run.provider}/${run.model}`}</span>
              )}
              <span className={styles.actNum}>{(run.elapsedMs / 1000).toFixed(1)}s</span>
            </span>
          )}
          <span className={styles.actSpacer} />
          <button
            type="button"
            className={styles.goBtn}
            disabled={currentText === ''}
            onClick={() => { if (currentText !== '') onUsePrompt(currentText) }}
          >
            用这段去生图 →
          </button>
        </div>
      </div>
    </>
  )
}

/** 供自检脚本使用：六段解析与画幅推断是纯函数，可以离线断言。 */
export { parseSections, aspectOf, shrink, LOCK_DIMENSIONS, DEFAULT_LOCKS }
