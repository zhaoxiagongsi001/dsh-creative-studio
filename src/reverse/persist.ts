/**
 * 反推状态的本地持久化（浏览器 localStorage）。
 *
 * ## 为什么需要
 *
 * 切到别的会话时，主区面板会被**卸载**；切回来是重新挂载。反推的源图、六段正文、
 * 参数带全躺在组件 `useState` 里，卸载即归零 —— 老板 2026-11-08 报的
 * 「切走再切回上一个图生文就消失了」就是这个。生图那一半早用
 * `draft-store.ts` 落过盘（同一份注释里记过同一机制），反推这一半当时没做。
 *
 * ## 为什么是 localStorage 而不是宿主落盘（老板 2026-11-08 拍板选 C）
 *
 *   · 宿主加路由必须重启一次 DSH 桌面端才生效；这里只改客户端 bundle，刷新页面即可。
 *   · **代价（已知并接受）**：localStorage 按 origin（协议+主机+端口）隔离。
 *     桌面端换端口、清站点数据、换浏览器 profile 就丢。它不等于把数据存进
 *     `.dsh/`，别宣传成「跨重启永久保留」。
 *
 * ## 为什么拆两条键
 *
 *   · `…state.v1` 只有几 KB（参数 + 正文 + 尺寸），参数一改就写，不心疼；
 *   · `…image.v1` 是几百 KB 的 data URL，只在选图 / 清图时写。
 *     混成一条会让「改个勾选」把整张图重新序列化一遍，输入会明显卡。
 *
 * ## 三条纪律
 *
 *   1. **纯函数不碰 DOM**：宿主半边的 `lib/index.js` 也导出它们，
 *      `scripts/persist-check.mjs` 才能在 node 里断言「坏数据不炸面板」。
 *   2. **坏数据一律收敛**：localStorage 可能被手改、被旧版本写脏；一个坏字段
 *      只该退回默认值，不该让面板启动就崩。
 *   3. **写失败不打扰**：配额满 / 隐私模式禁用时写不进去，面板照常能用，
 *      只是下次挂载恢复不回来。只在控制台留一条 warn。
 */
import type { ReverseOptions } from '../client/types.ts'

/** 参数 + 正文 + 尺寸那条键。 */
export const REVERSE_STATE_KEY = 'dsh-creative.reverse.state.v1'
/** 源图 data URL 那条键（单独一条，见文件头）。 */
export const REVERSE_IMAGE_KEY = 'dsh-creative.reverse.image.v1'
/** 上次停在哪一模式（图→词 / 词→图）。 */
export const STUDIO_MODE_KEY = 'dsh-creative.studio.mode.v1'

/** 快照格式版本，供将来迁移用。 */
export const REVERSE_SNAPSHOT_VERSION = 1

/** 六个锁定维度（顺序即界面顺序，对应 `person-replace-spec.md` 的锁定项）。 */
export const LOCK_DIMENSIONS: readonly string[] = ['构图', '光线', '服装', '姿态', '背景', '色调']
/** 默认勾选的锁定维度（与旧插件一致）。 */
export const DEFAULT_LOCKS: readonly string[] = ['构图', '光线', '姿态', '色调']

/** 正文长度上限（与 `draft-store.ts` 的 `MAX_DRAFT_PROMPT` 同口径）。 */
export const MAX_SNAPSHOT_TEXT = 20000
/** 参数里那些自由文本（服装描述 / 姿态描述 / 追加要求）的长度上限。 */
export const MAX_SNAPSHOT_OPTION_TEXT = 300
/** 单张卡片片段的长度上限。 */
export const MAX_SNAPSHOT_FRAGMENT = 2000
/** 最多记住多少张建议卡片。 */
export const MAX_SNAPSHOT_CARDS = 8
/** 记住的警告条数。 */
export const MAX_SNAPSHOT_WARNINGS = 10
/**
 * 源图 data URL 的硬上限（base64 字符数，约 1.5 MB 二进制）。
 *
 * 超过就不存：宁可「下次没有图」，也不要因为一张巨图把整个 origin 的配额占满
 * —— 那会连带把参数和正文也写不进去。
 */
export const MAX_IMAGE_CHARS = 2_000_000
/** 超过这个长度先二次压缩再存（客户端侧做，见 `ReversePane.tsx` 的 `persistImage`）。 */
export const MAX_IMAGE_SOFT_CHARS = 900_000

/** 类型 / 卡片推荐的来源，与 `RunState` 里同名字段一致。 */
export type SnapshotSource = 'model' | 'inferred' | 'none'
/** 面板模式。 */
export type StudioMode = 'word' | 'image'

/** 持久化的反推结果（只存成功态；`running` / `error` 不值得恢复）。 */
export interface ReverseSnapshotResult {
  text: string
  chars: number
  type: string
  typeSource: SnapshotSource
  cardsSource: SnapshotSource
  provider: string
  model: string
  elapsedMs: number
  warnings: string[]
}

/** 源图尺寸（画幅标签也一起存，省一次测量）。 */
export interface ReverseSnapshotMeta {
  width: number
  height: number
  aspect: string
}

/** 一次失败的可读信息（刷新 / 切窗口后也要告诉用户为什么没结果）。 */
export interface ReverseFailure {
  title: string
  detail: string
  hint: string
}

/** 落盘的整份快照。 */
export interface ReverseSnapshot {
  version: number
  options: ReverseOptions
  result: ReverseSnapshotResult | null
  meta: ReverseSnapshotMeta | null
  /** 只在「图确实写进了 image 键」时为 true；仅供参考，恢复时以 image 键为准。 */
  hasImage: boolean
  /**
   * 「某时刻开始、还没写回结果」的标记（2026-11-08 修「切走即取消」时加）。
   *
   * 它只回答一个问题：**页面重新加载后，上次那次反推是不是跑到一半就没了。**
   * 反推现在活在模块作用域的 runner 里（`src/client/reverse-runner.ts`），切会话
   * 不中断；但刷新页面 / 关窗会连浏览器那边一起打死 —— 那时快照里就会留下这个标记，
   * 界面据此显示「上次被中断、已跑 X 秒、要重跑吗」，而不是装成什么都没发生。
   */
  inflight: { startedAt: number } | null
  /** 上次失败的信息；成功一次后清空。 */
  error: ReverseFailure | null
  /** 模型推荐、但界面还没消费掉的卡片 id（消费后立刻清空，避免反复覆盖用户手动取消的选择）。 */
  pendingCards: string[]
  updatedAt: number
}

/** 一次挂载要恢复的全部内容。 */
export interface LoadedReverse {
  image: string
  options: ReverseOptions
  result: ReverseSnapshotResult | null
  meta: ReverseSnapshotMeta | null
  inflight: { startedAt: number } | null
  error: ReverseFailure | null
  pendingCards: string[]
}

/**
 * 页面刚加载时该显示哪种运行态。
 *
 * 三条判据有**先后顺序**，别调换：
 *   1. 有 `inflight` → 上次没跑完（刷新 / 关窗打断），显示「被中断」；
 *   2. 有 `error` → 上次失败，把原因原样交给界面；
 *   3. 有 `result` → 上次成功，直接显示结果；
 *   4. 都没有 → 空面板。
 */
export type BootRun =
  | { kind: 'idle' }
  | { kind: 'done'; result: ReverseSnapshotResult }
  | { kind: 'error'; failure: ReverseFailure }
  | { kind: 'interrupted'; elapsedMs: number }

/** 中断态最多认多久（超过就是一张陈年存档，不如当没有）。 */
export const MAX_INTERRUPTED_MS = 6 * 60 * 60 * 1000

/**
 * 决定页面加载后的运行态。
 * @param snapshot - 读回来的快照。
 * @param now - 当前时间（毫秒），测试里可以注入。
 * @returns 该显示的运行态。
 */
export function resolveBootRun(snapshot: ReverseSnapshot | undefined, now: number = Date.now()): BootRun {
  if (snapshot === undefined) return { kind: 'idle' }
  if (snapshot.inflight !== null) {
    const elapsedMs = Math.max(0, now - snapshot.inflight.startedAt)
    if (elapsedMs <= MAX_INTERRUPTED_MS) return { kind: 'interrupted', elapsedMs }
  }
  if (snapshot.error !== null) return { kind: 'error', failure: snapshot.error }
  if (snapshot.result !== null) return { kind: 'done', result: snapshot.result }
  return { kind: 'idle' }
}

/* ------------------------------------------------------------------ 收敛 */

/** 取一段文本，超长截断；非字符串给空串。 */
function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 取一个布尔；认 `'true'` / `'false'` 字符串（手改的 JSON 里常见）。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** 取一个枚举值；不在白名单里就退默认。 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback
}

/** 取一个非负整数；认有限数字与数字字符串。 */
function intOf(value: unknown, max: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.min(Math.round(num), max)
}

/** 取一个字符串数组（逐条截断、去空、限量）。 */
function textsOf(value: unknown, limit: number, max: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= limit) break
    const text = textOf(item, max)
    if (text !== '') out.push(text)
  }
  return out
}

/** 来源标记：只认三档，别的一律 `none`。 */
function sourceOf(value: unknown): SnapshotSource {
  return oneOf<SnapshotSource>(value, ['model', 'inferred', 'none'], 'none')
}

/**
 * 一份默认参数（与面板首屏一致）。
 *
 * 刻意放在这一层：持久化要给出「读不到时用什么」，两处各写一份迟早漂移。
 * @returns 全新的默认参数对象（每次调用都是新数组，调用方可以随手改）。
 */
export function defaultReverseOptions(): ReverseOptions {
  return {
    person: 'none',
    clothing: 'B1',
    pose: 'C1',
    redraw: 'D2',
    lockStrength: 'medium',
    ageText: '',
    locks: [...DEFAULT_LOCKS],
    cards: [],
    nsfw: '',
    dialect: 'gpt',
    extra: '',
  }
}

/** 收敛建议卡片：名字必填，其余可缺；形状不对的条目直接丢。 */
function coerceCards(raw: unknown): Array<{ name: string; why: string; fragment?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ name: string; why: string; fragment?: string }> = []
  for (const item of raw) {
    if (out.length >= MAX_SNAPSHOT_CARDS) break
    if (typeof item !== 'object' || item === null) continue
    const source = item as Record<string, unknown>
    const name = textOf(source.name, 40).trim()
    if (name === '') continue
    const fragment = textOf(source.fragment, MAX_SNAPSHOT_FRAGMENT).trim()
    out.push({
      name,
      why: textOf(source.why, MAX_SNAPSHOT_OPTION_TEXT),
      ...fragment === '' ? {} : { fragment },
    })
  }
  return out
}

/**
 * 把任意来源的参数收敛成一份可直接用的 {@link ReverseOptions}。
 * @param raw - 本地存储里读出来的 `options`。
 * @returns 全字段齐备的参数（缺的用默认值补）。
 */
export function coerceReverseOptions(raw: unknown): ReverseOptions {
  const base = defaultReverseOptions()
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const locks: string[] = []
  if (Array.isArray(source.locks)) {
    for (const item of source.locks) {
      if (typeof item !== 'string') continue
      if (!LOCK_DIMENSIONS.includes(item)) continue
      if (locks.includes(item)) continue
      locks.push(item)
    }
  }

  return {
    person: oneOf(source.person, ['none', 'A1', 'A2', 'A3'] as const, base.person ?? 'none'),
    clothing: oneOf(source.clothing, ['B1', 'B2', 'B3'] as const, base.clothing ?? 'B1'),
    clothingVisible: boolOf(source.clothingVisible, false),
    clothingText: textOf(source.clothingText, MAX_SNAPSHOT_OPTION_TEXT),
    pose: oneOf(source.pose, ['C1', 'C2', 'C3'] as const, base.pose ?? 'C1'),
    poseText: textOf(source.poseText, MAX_SNAPSHOT_OPTION_TEXT),
    redraw: oneOf(source.redraw, ['D1', 'D2', 'D3'] as const, base.redraw ?? 'D2'),
    lockStrength: oneOf(source.lockStrength, ['short', 'medium', 'strong'] as const, base.lockStrength ?? 'medium'),
    // 年龄口径是「成年」这类短词，不是自由文本。
    ageText: textOf(source.ageText, 40),
    locks,
    cards: coerceCards(source.cards),
    nsfw: oneOf(source.nsfw, ['', 'L1', 'L2', 'L3'] as const, ''),
    dialect: oneOf(source.dialect, ['gpt', 'gemini', 'qwen'] as const, 'gpt'),
    extra: textOf(source.extra, MAX_SNAPSHOT_OPTION_TEXT),
  }
}

/** 收敛一份结果；正文为空的直接当作「没有结果」（恢复一个空壳没有意义）。 */
function coerceResult(raw: unknown): ReverseSnapshotResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const text = textOf(source.text, MAX_SNAPSHOT_TEXT)
  if (text.trim() === '') return null
  return {
    text,
    chars: intOf(source.chars, MAX_SNAPSHOT_TEXT) || text.length,
    type: textOf(source.type, 60),
    typeSource: sourceOf(source.typeSource),
    cardsSource: sourceOf(source.cardsSource),
    provider: textOf(source.provider, 80),
    model: textOf(source.model, 120),
    elapsedMs: intOf(source.elapsedMs, 3_600_000),
    warnings: textsOf(source.warnings, MAX_SNAPSHOT_WARNINGS, 300),
  }
}

/** 收敛源图尺寸；宽高必须都是正数才算有效。 */
function coerceMeta(raw: unknown): ReverseSnapshotMeta | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const width = intOf(source.width, 100000)
  const height = intOf(source.height, 100000)
  if (width <= 0 || height <= 0) return null
  return { width, height, aspect: textOf(source.aspect, 8) || '—' }
}

/** 收敛中断标记；时间戳必须是个正数。 */
function coerceInflight(raw: unknown): { startedAt: number } | null {
  if (typeof raw !== 'object' || raw === null) return null
  const startedAt = intOf((raw as Record<string, unknown>).startedAt, 8.64e15)
  return startedAt > 0 ? { startedAt } : null
}

/** 收敛失败信息；标题为空就当没有（一个没标题的错误卡比没有更糟）。 */
function coerceFailure(raw: unknown): ReverseFailure | null {
  if (typeof raw !== 'object' || raw === null) return null
  const source = raw as Record<string, unknown>
  const title = textOf(source.title, 120).trim()
  if (title === '') return null
  return {
    title,
    detail: textOf(source.detail, 4000),
    hint: textOf(source.hint, 1000),
  }
}

/** 收敛待消费的推荐卡片 id。 */
function coercePendingCards(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (out.length >= MAX_SNAPSHOT_CARDS) break
    const id = textOf(item, 80).trim()
    if (id !== '') out.push(id)
  }
  return out
}

/**
 * 把任意来源收敛成一份快照。
 * @param raw - 存储里读出来的值（可能是旧版本、手改或别的东西）。
 * @returns 快照；`raw` 根本不是对象时返回 `undefined`（调用方按「没有存档」处理）。
 */
export function coerceReverseSnapshot(raw: unknown): ReverseSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  return {
    version: REVERSE_SNAPSHOT_VERSION,
    options: coerceReverseOptions(source.options),
    result: coerceResult(source.result),
    meta: coerceMeta(source.meta),
    hasImage: boolOf(source.hasImage, false),
    // 三个是 2026-11-08 新增：中断标记、失败信息、待消费的推荐卡片。
    // 旧存档没有这些键 → 分别收敛成 null / null / []，行为与改动前一致。
    inflight: coerceInflight(source.inflight),
    error: coerceFailure(source.error),
    pendingCards: coercePendingCards(source.pendingCards),
    updatedAt: intOf(source.updatedAt, 8.64e15),
  }
}

/**
 * 收敛存下来的源图。
 * @param value - image 键里读出来的值。
 * @returns data URL；不是图片、超长或空串时返回 `undefined`。
 */
export function coerceStoredImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (!value.startsWith('data:image/')) return undefined
  if (value.length > MAX_IMAGE_CHARS) return undefined
  return value
}

/**
 * 收敛面板模式。
 * @param value - 存储里读出来的值。
 * @returns 只可能是 `word` / `image`；别的一律当首屏默认 `word`。
 */
export function coerceStudioMode(value: unknown): StudioMode {
  return oneOf<StudioMode>(value, ['word', 'image'], 'word')
}

/* ------------------------------------------------------------------ 存储 */

/** 本机浏览器存储；拿不到（SSR / 隐私模式 / 被禁用）时返回 `undefined`。 */
function storageOf(): Storage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage
    return candidate ?? undefined
  } catch {
    // 某些浏览器在读 localStorage 属性时就抛（跨域 iframe / 禁用 cookie）。
    return undefined
  }
}

/** 读一条键；不存在或读失败都返回 `undefined`。 */
function readRaw(key: string): string | undefined {
  const storage = storageOf()
  if (storage === undefined) return undefined
  try {
    const value = storage.getItem(key)
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/** 写一条键；失败返回 false（配额满 / 被禁用）。 */
export function writeKey(key: string, value: string): boolean {
  const storage = storageOf()
  if (storage === undefined) return false
  try {
    storage.setItem(key, value)
    return true
  } catch (error) {
    console.warn(`[dsh-creative-studio] localStorage 写入 ${key} 失败（可能是配额已满）：`, error)
    return false
  }
}

/** 删一条键；删不掉也不算错。 */
export function removeKey(key: string): void {
  const storage = storageOf()
  if (storage === undefined) return
  try {
    storage.removeItem(key)
  } catch {
    // 删不掉只意味着下次多一份旧数据，不该打断界面。
  }
}

/** 读一条键并 JSON 解析；坏 JSON 返回 `undefined`。 */
function readJson(key: string): unknown {
  const raw = readRaw(key)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * 读回源图。
 * @returns data URL；没有或不可用时返回空串。
 */
export function loadReverseImage(): string {
  return coerceStoredImage(readRaw(REVERSE_IMAGE_KEY)) ?? ''
}

/**
 * 写源图；`null` / 空串表示清掉。
 * @param value - 已经过尺寸预算检查的 data URL。
 * @returns 是否真的写进去了。
 */
export function saveReverseImage(value: string | null): boolean {
  if (value === null || value === '') {
    removeKey(REVERSE_IMAGE_KEY)
    return true
  }
  return writeKey(REVERSE_IMAGE_KEY, value)
}

/**
 * 挂载时一次性读回全部可恢复内容。
 * @returns 图 + 参数 + 结果 + 尺寸 + 中断/失败/待消费卡片（没有存档时给默认值，绝不抛）。
 */
export function loadReverseSnapshot(): LoadedReverse {
  const image = loadReverseImage()
  const snapshot = coerceReverseSnapshot(readJson(REVERSE_STATE_KEY))
  if (snapshot === undefined) {
    return {
      image,
      options: defaultReverseOptions(),
      result: null,
      meta: null,
      inflight: null,
      error: null,
      pendingCards: [],
    }
  }
  return {
    image,
    options: snapshot.options,
    result: snapshot.result,
    meta: snapshot.meta,
    inflight: snapshot.inflight,
    error: snapshot.error,
    pendingCards: snapshot.pendingCards,
  }
}

/**
 * 落盘一份快照。
 * @param snapshot - 当前状态。
 * @returns 是否写成功。
 */
export function saveReverseSnapshot(snapshot: ReverseSnapshot): boolean {
  const next: ReverseSnapshot = {
    ...coerceReverseSnapshot(snapshot) ?? {
      version: REVERSE_SNAPSHOT_VERSION,
      options: defaultReverseOptions(),
      result: null,
      meta: null,
      hasImage: false,
      inflight: null,
      error: null,
      pendingCards: [],
      updatedAt: 0,
    },
    version: REVERSE_SNAPSHOT_VERSION,
    updatedAt: Date.now(),
  }
  return writeKey(REVERSE_STATE_KEY, JSON.stringify(next))
}

/**
 * 读回上次停在哪一模式。 */
export function loadStudioMode(): StudioMode {
  return coerceStudioMode(readRaw(STUDIO_MODE_KEY))
}

/** 记住当前模式。 */
export function saveStudioMode(mode: StudioMode): boolean {
  return writeKey(STUDIO_MODE_KEY, mode)
}

/** 一份空快照（还没写过任何东西时用它打底）。 */
export function emptyReverseSnapshot(): ReverseSnapshot {
  return {
    version: REVERSE_SNAPSHOT_VERSION,
    options: defaultReverseOptions(),
    result: null,
    meta: null,
    hasImage: false,
    inflight: null,
    error: null,
    pendingCards: [],
    updatedAt: 0,
  }
}

/**
 * 只改快照的一部分，其余原样保留。
 *
 * 为什么需要「读-改-写」而不是各自整份覆盖（2026-11-08）：这份快照有**两个写者**——
 *   · 面板组件写 `options` / `meta` / `hasImage`（用户改参数时）；
 *   · 反推执行体写 `inflight` / `result` / `error` / `pendingCards`（跑完时）。
 * 面板可能在跑完那一刻**已经卸载**，于是执行体必须能自己落盘；两边若都整份覆盖，
 * 谁后写谁就把对方的字段抹回旧值（表现为「参数被改回默认」或「结果凭空消失」）。
 * @param patch - 要覆盖的字段。
 * @returns 是否写成功。
 */
export function patchReverseSnapshot(patch: Partial<ReverseSnapshot>): boolean {
  const current = coerceReverseSnapshot(readJson(REVERSE_STATE_KEY)) ?? emptyReverseSnapshot()
  return saveReverseSnapshot({ ...current, ...patch })
}

/**
 * 页面加载时该显示哪种运行态（读存档 + 判定）。
 * @param now - 当前时间（毫秒），测试里可以注入。
 * @returns 运行态判定结果。
 */
export function loadReverseBootRun(now: number = Date.now()): BootRun {
  return resolveBootRun(coerceReverseSnapshot(readJson(REVERSE_STATE_KEY)), now)
}
