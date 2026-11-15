/**
 * 生图运行态的浏览器存档（localStorage）。
 *
 * ## 为什么是 localStorage 而不是宿主落盘
 *
 * 与反推那份同因（老板 2026-11-08 拍板选 C）：要存的东西只有「这次生成有没有在跑、
 * 上次报了什么错」，量小且挂载首帧就要同步读到，塞进宿主草稿只会让草稿的读写时序
 * 再复杂一层。代价同样是按 origin 隔离：换端口 / 清站点数据会丢 —— 但那时丢的只是
 * 「上次的报错」，图本身在宿主历史索引里。
 *
 * ## 为什么只存运行态
 *
 * 提示词 / 参数 / 历史 / 模型配置已经由面板的 `panelStore`（内存，撑一次运行）与宿主
 * `draft.json`（磁盘，撑重启）各存一份。这里再存一份只会多一个迟早漂移的副本。
 *
 * ## 形状里两个字段各自回答什么问题
 *
 * - `inflight`：页面重新加载后，**上次那次生成是不是跑到一半就没了**。生图执行体活在
 *   模块作用域（`src/client/generate-runner.ts`），切会话不打断；但刷新 / 关窗会连
 *   浏览器那侧的请求一起打死，界面据此显示「上次被中断」而不是装成什么都没发生。
 * - `error`：上次失败的原因。老板 2026-11-15 明确要求「报错就保留报错信息」——
 *   只留在组件 state 里的话，切走再回来（面板重新挂载）就没了。
 *
 * 这一层只放纯收敛函数与存储封装：坏 JSON、手改过、旧版本写脏的存档一律收敛成
 * 能用的值，绝不把异常抛到渲染路径上。
 */

/** 存档键（版本号进键名：换形状时不必再写迁移）。 */
export const GENERATE_STATE_KEY = 'dsh-creative.generate.state.v1'

/** 快照形状版本。 */
export const GENERATE_SNAPSHOT_VERSION = 1

/** 单段文本（提示词 / 报错原文）最多存多少字符。 */
export const MAX_GENERATE_TEXT = 20000

/** 报错标题最多存多少字符（标题是短句，超长一定是被手改过）。 */
export const MAX_GENERATE_TITLE = 500

/** 页面实例 id 最多存多少字符（正常是 20 位左右的随机串）。 */
export const MAX_GENERATE_OWNER = 64

/**
 * 「上次在跑」最多认多久。
 *
 * 生图正常几十秒到几分钟；超过 30 分钟的 inflight 一定是一次死掉的会话，
 * 显示成「中断」只会让人以为刚才那次还在跑。
 */
export const MAX_GENERATE_INTERRUPTED_MS = 30 * 60 * 1000

/**
 * 「上次失败」最多认多久。
 *
 * 老板要的是「切走再回来报错还在」，不是「昨天那次失败永远顶在首屏」。
 * 1 小时足够覆盖一次调试来回，再久就是陈年存档。
 */
export const MAX_GENERATE_ERROR_MS = 60 * 60 * 1000

/** 面板能直接展示的失败原因（与 `GenerateError` 的两个字段对齐）。 */
export interface GenerateFailure {
  /** 一句话标题，如「生成失败」。 */
  message: string
  /** 展开后的原文（含 code 与宿主 diagnostics）。 */
  detail: string
  /**
   * 计费口径存疑时标 `'unknown'`。
   *
   * 「这次请求没有拿到结果」不等于「本次未计费」：请求可能已经到上游并出了图。
   * 面板据此换掉那句「本次未计费」，不要给出错误的账单承诺。
   */
  billing?: 'unknown'
}

/** 「某时刻开始、还没写回结果」的标记。 */
export interface GenerateInflight {
  /** 发起时间（毫秒时间戳）。 */
  startedAt: number
  /** 发起时的提示词（截断后）；只用于「被中断」时说清那次要生什么。 */
  prompt: string
  /**
   * 发起这次请求的页面实例 id（存在 sessionStorage，刷新不变、新标签页会换）。
   *
   * 没有它的时候，开第二个标签页会把第一个标签页正在跑的请求误判成「上次被中断」，
   * 用户一刷新再点重试就是两次付费请求。空串表示老存档 / 拿不到 sessionStorage。
   */
  owner: string
}

/** 一次失败的存档。 */
export interface GenerateErrorRecord extends GenerateFailure {
  /** 失败的那次用的提示词（截断后）。 */
  prompt: string
  /** 失败发生时间（毫秒时间戳）。 */
  at: number
}

/** 落盘的整份快照。 */
export interface GenerateSnapshot {
  version: number
  inflight: GenerateInflight | null
  error: GenerateErrorRecord | null
  updatedAt: number
}

/**
 * 页面刚加载时该显示哪种运行态。
 *
 * 只有两档：上次没跑完（中断）/ 上次失败了。成功的结果不回放 —— 舞台恢复靠
 * `lastImageId` + 宿主历史，这里再存一张图（可能几十 KB 的 data URL）不划算。
 */
export type GenerateBoot =
  | { kind: 'idle' }
  | { kind: 'interrupted'; elapsedMs: number; prompt: string; owner: string }
  | { kind: 'error'; failure: GenerateFailure; prompt: string }

/* ------------------------------------------------------------------ 收敛 */

/** 取一段文本，超长截断；非字符串给空串。 */
function generateTextOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 取一个非负整数；认有限数字与数字字符串（手改的 JSON 里常见）。 */
function generateIntOf(value: unknown, max: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(num) || num < 0) return 0
  return Math.min(Math.round(num), max)
}

/** 收敛 inflight 标记；形状不对或时间戳无效一律当没有。 */
export function coerceGenerateInflight(value: unknown): GenerateInflight | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const startedAt = generateIntOf(record.startedAt, Number.MAX_SAFE_INTEGER)
  if (startedAt <= 0) return null
  return {
    startedAt,
    prompt: generateTextOf(record.prompt, MAX_GENERATE_TEXT),
    owner: generateTextOf(record.owner, MAX_GENERATE_OWNER),
  }
}

/** 收敛失败记录；标题与原文都空的记录没有意义，当没有。 */
export function coerceGenerateError(value: unknown): GenerateErrorRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const message = generateTextOf(record.message, MAX_GENERATE_TITLE).trim()
  const detail = generateTextOf(record.detail, MAX_GENERATE_TEXT)
  if (message === '' && detail === '') return null
  return {
    message: message === '' ? '生成失败' : message,
    detail,
    prompt: generateTextOf(record.prompt, MAX_GENERATE_TEXT),
    at: generateIntOf(record.at, Number.MAX_SAFE_INTEGER),
    ...(record.billing === 'unknown' ? { billing: 'unknown' as const } : {}),
  }
}

/**
 * 收敛整份快照。
 * @param raw - `JSON.parse` 之后的任意值（可能是手改过的垃圾）。
 * @returns 能用的快照；根本不是对象时给 `undefined`。
 */
export function coerceGenerateSnapshot(raw: unknown): GenerateSnapshot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  return {
    version: GENERATE_SNAPSHOT_VERSION,
    inflight: coerceGenerateInflight(record.inflight),
    error: coerceGenerateError(record.error),
    updatedAt: generateIntOf(record.updatedAt, Number.MAX_SAFE_INTEGER),
  }
}

/* ------------------------------------------------------------------ 判定 */

/**
 * 决定页面加载后的运行态。
 *
 * 顺序固定：先看 inflight（上次没跑完），再看 error（上次失败）。
 * 时间戳落在未来（时钟回拨 / 手改）或过期都当没有 —— 宁可给空面板，
 * 也不要一条假的中断或一句陈年报错。
 * @param snapshot - 读回来的快照。
 * @param now - 当前时间（毫秒），测试里可以注入。
 * @returns 该显示的运行态。
 */
export function resolveGenerateBoot(snapshot: GenerateSnapshot | undefined, now: number = Date.now()): GenerateBoot {
  if (snapshot === undefined) return { kind: 'idle' }
  if (snapshot.inflight !== null) {
    const elapsedMs = now - snapshot.inflight.startedAt
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs <= MAX_GENERATE_INTERRUPTED_MS) {
      return {
        kind: 'interrupted',
        elapsedMs,
        prompt: snapshot.inflight.prompt,
        owner: snapshot.inflight.owner,
      }
    }
  }
  if (snapshot.error !== null) {
    const age = now - snapshot.error.at
    if (Number.isFinite(age) && age >= 0 && age <= MAX_GENERATE_ERROR_MS) {
      return {
        kind: 'error',
        failure: {
          message: snapshot.error.message,
          detail: snapshot.error.detail,
          ...(snapshot.error.billing === 'unknown' ? { billing: 'unknown' as const } : {}),
        },
        prompt: snapshot.error.prompt,
      }
    }
  }
  return { kind: 'idle' }
}

/* ------------------------------------------------------------------ 存储 */

/**
 * 本机浏览器存储；拿不到（SSR / 隐私模式 / 被禁用）时返回 `undefined`。
 *
 * 与 `src/reverse/persist.ts` 里那套同形，但**刻意不互相 import**：两套快照的
 * 失效判定完全不同（反推认 6 小时中断、生图只认 30 分钟），共享一个存储抽象
 * 只会让两边都不敢改。这 20 行重复换的是两个模块可以各自演进。
 */
function generateStorageOf(): Storage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: Storage }).localStorage
    return candidate ?? undefined
  } catch {
    return undefined
  }
}

/** 读一条键；不存在或读失败都返回 `undefined`。 */
function generateReadRaw(key: string): string | undefined {
  const storage = generateStorageOf()
  if (storage === undefined) return undefined
  try {
    const value = storage.getItem(key)
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/** 写一条键；失败返回 false（配额满 / 被禁用）。 */
export function writeGenerateRaw(key: string, value: string): boolean {
  const storage = generateStorageOf()
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
function generateRemoveKey(key: string): void {
  const storage = generateStorageOf()
  if (storage === undefined) return
  try {
    storage.removeItem(key)
  } catch {
    // 删不掉只意味着下次多一份旧数据，不该打断界面。
  }
}

/** 读一条键并 JSON 解析；坏 JSON 返回 `undefined`。 */
function generateReadJson(key: string): unknown {
  const raw = generateReadRaw(key)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 一份空快照（还没写过任何东西时用它打底）。 */
export function emptyGenerateSnapshot(): GenerateSnapshot {
  return {
    version: GENERATE_SNAPSHOT_VERSION,
    inflight: null,
    error: null,
    updatedAt: 0,
  }
}

/** 读回存档快照；没有 / 坏掉时给空快照（调用方不必判 undefined）。 */
export function loadGenerateSnapshot(): GenerateSnapshot {
  return coerceGenerateSnapshot(generateReadJson(GENERATE_STATE_KEY)) ?? emptyGenerateSnapshot()
}

/**
 * 落盘一份快照。
 * @param snapshot - 当前状态。
 * @returns 是否写成功。
 */
export function saveGenerateSnapshot(snapshot: GenerateSnapshot): boolean {
  const next: GenerateSnapshot = {
    ...coerceGenerateSnapshot(snapshot) ?? emptyGenerateSnapshot(),
    version: GENERATE_SNAPSHOT_VERSION,
    updatedAt: Date.now(),
  }
  return writeGenerateRaw(GENERATE_STATE_KEY, JSON.stringify(next))
}

/**
 * 只改快照的一部分，其余原样保留。
 *
 * 与反推那份同因：这份存档有两个写者 —— 面板组件清 `error`（用户重新生成时），
 * 执行体写 `inflight` / `error`（跑完时，那时面板**可能已经卸载**）。整份覆盖会让
 * 后写的一方把对方的字段抹回旧值。
 * @param patch - 要覆盖的字段。
 * @returns 是否写成功。
 */
export function patchGenerateSnapshot(patch: Partial<GenerateSnapshot>): boolean {
  return saveGenerateSnapshot({ ...loadGenerateSnapshot(), ...patch })
}

/** 清掉整个存档（测试 / 「清空」用）。 */
export function clearGenerateSnapshot(): void {
  generateRemoveKey(GENERATE_STATE_KEY)
}

/**
 * 页面加载时该显示哪种运行态（读存档 + 判定）。
 * @param now - 当前时间（毫秒），测试里可以注入。
 * @returns 运行态判定结果。
 */
export function loadGenerateBootRun(now: number = Date.now()): GenerateBoot {
  return resolveGenerateBoot(coerceGenerateSnapshot(generateReadJson(GENERATE_STATE_KEY)), now)
}

/**
 * 同样的判定，但按「本页面实例」过滤：别人的 in-flight 不算本页中断。
 *
 * 存档是 localStorage（跨标签页共享）。A 标签页发起后写了 inflight，B 标签页加载
 * 时若照旧显示「上次生成被中断」，用户在 B 点重试就是第二次付费请求 —— 而 A 那次
 * 其实还在跑。owner 对不上就当没有，安静给 idle。
 * @param snapshot - 读回来的快照。
 * @param owner - 本页面实例 id（空串表示不认识自己，按老行为处理）。
 * @param now - 当前时间（毫秒），测试里可以注入。
 * @returns 该显示的运行态。
 */
export function resolveGenerateBootFor(
  snapshot: GenerateSnapshot | undefined,
  owner: string,
  now: number = Date.now(),
): GenerateBoot {
  const boot = resolveGenerateBoot(snapshot, now)
  if (boot.kind === 'interrupted' && boot.owner !== '' && boot.owner !== owner) return { kind: 'idle' }
  return boot
}
