/**
 * 反推执行体（模块作用域单例）。
 *
 * ## 为什么要把请求从组件里搬出来（老板 2026-11-08 要求修）
 *
 * 原来 `fetch('/reverse')` 是在 `ReversePane` 里发的，组件卸载时 cleanup 会 `abort()`
 * 请求。而「切到别的会话」正好会把主区面板卸载 —— 于是：
 *   · 一次反推要等 60–175 秒、按 token 计费，切一下窗口就全白费；
 *   · 客户端的 abort 在修掉宿主监听之后还会连带中止上游（省 token，但结果彻底没了）；
 *   · 切回来只能看到上一次成功的结果，等同于这次没跑。
 *
 * 现在请求挂在模块作用域：
 *   · 组件卸载**不**动它，跑完把结果写进 localStorage 并通知订阅者；
 *   · 切回来（重新挂载）直接从内存/存档读到 running 或 done；
 *   · 只有用户点「取消」才 abort；页面刷新/关窗仍会打断（浏览器行为），
 *     那次靠快照里的 `inflight` 标记识别成「上次被中断」并如实显示。
 *
 * 等价于心智模型：**反推是一次「下载」，不是一次「渲染」**——它属于页面，不属于面板。
 */
import { createHttpBackend, HostRouteError } from './api.ts'
import {
  loadReverseBootRun,
  loadReverseSnapshot,
  patchReverseSnapshot,
  saveReverseSnapshot,
  type ReverseSnapshotResult,
} from '../reverse/persist.ts'
import type { Backend, ReverseOptions } from './types.ts'

/** 后端单例（与面板共用一份实现）。 */
const backend: Backend = createHttpBackend()

/**
 * 运行态。
 *
 * 与旧版 `RunState` 形状一致（渲染代码不用改），只多了一个 `interrupted`：
 * 页面加载时发现上次跑到一半就没了，用这个态如实告诉用户，不装成什么都没发生。
 */
export type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | {
      kind: 'done'
      text: string
      type: string
      typeSource: 'model' | 'inferred' | 'none'
      cardsSource: 'model' | 'inferred' | 'none'
      provider: string
      model: string
      routeSource: string
      elapsedMs: number
      warnings: string[]
    }
  | { kind: 'error'; title: string; detail?: string; hint?: string }
  /** 上次跑了一半被中断（刷新、关窗、浏览器退出）。 */
  | { kind: 'interrupted'; startedAt: number; elapsedMs: number }

/** 当前状态（页面内唯一一份）。 */
let current: RunState = hydrate()

/** 订阅者（面板每次挂载都重新订阅）。 */
const listeners = new Set<() => void>()

/** 在飞请求的控制器：只有「取消」会动它，客户端卸载不会。 */
let inflight: AbortController | undefined

/** 模型推荐、界面还没消费掉的卡片 id。 */
let pending: string[] = loadReverseSnapshot().pendingCards

/** 页面刚加载时的状态判定：中断 / 失败 / 成功 / 空。 */
function hydrate(): RunState {
  const boot = loadReverseBootRun()
  if (boot.kind === 'done') return runFromResult(boot.result)
  if (boot.kind === 'error') {
    return { kind: 'error', title: boot.failure.title, detail: boot.failure.detail, hint: boot.failure.hint }
  }
  if (boot.kind === 'interrupted') {
    return { kind: 'interrupted', startedAt: Date.now() - boot.elapsedMs, elapsedMs: boot.elapsedMs }
  }
  return { kind: 'idle' }
}

/** 落盘结果 → 运行态。 */
function runFromResult(result: ReverseSnapshotResult): RunState {
  return {
    kind: 'done',
    text: result.text,
    type: result.type,
    typeSource: result.typeSource,
    cardsSource: result.cardsSource,
    provider: result.provider,
    model: result.model,
    routeSource: '',
    elapsedMs: result.elapsedMs,
    warnings: result.warnings,
  }
}

/** 运行态 → 落盘结果。 */
function snapshotOf(run: Extract<RunState, { kind: 'done' }>): ReverseSnapshotResult {
  return {
    text: run.text,
    chars: run.text.length,
    type: run.type,
    typeSource: run.typeSource,
    cardsSource: run.cardsSource,
    provider: run.provider,
    model: run.model,
    elapsedMs: run.elapsedMs,
    warnings: run.warnings,
  }
}

/** 改状态并通知订阅者。 */
function emit(next: RunState): void {
  current = next
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      // 一个订阅者抛错不该影响其它订阅者，更不该让执行体挂掉。
      console.warn('[dsh-creative-studio] 反推状态订阅者报错：', error)
    }
  }
}

/** 后端失败码 → 面板能直接展示的标题与建议（与旧版逐条一致）。 */
function failureOf(code: string, message: string): { title: string; detail: string; hint: string } {
  const hint = code === 'timeout'
    ? '可以在连接配置里换一个更快的模型，或直接重试。'
    : code === 'no-active-model'
      ? '反推必须用 DSH 当前配置的聊天模型。请到 DSH 模型设置里确认已选中一个可用模型，然后点上方「模型」chip 重新检测。插件不会偷偷换用其它模型。'
      : code === 'llm-unavailable' || code === 'attachments-unavailable'
        ? '宿主没有挂载所需服务，请确认 DSH 版本与插件是否匹配。'
        : code === 'bad-image'
          ? '换一张更小的图（长边 ≤ 2048）再试。'
          : '可以切到 L3 档重试，或换一个模型。'
  const title = code === 'timeout' ? '反推超时'
    : code === 'no-active-model' ? '拿不到当前聊天模型'
      : '反推失败'
  return { title, detail: message, hint }
}

/* ------------------------------------------------------------------ 对外 API */

/** 读当前状态（`useSyncExternalStore` 的 getSnapshot）。 */
export function runnerState(): RunState {
  return current
}

/**
 * 订阅状态变化。
 * @param listener - 变化回调。
 * @returns 取消订阅。
 */
export function subscribeRunner(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 开始一次反推。
 *
 * 幂等：正在跑时再点不会叠加第二个请求（旧实现会，重试越多越慢）。
 * @param image - 源图 data URL。
 * @param options - 反推参数。
 */
export function startReverse(image: string, options: ReverseOptions): void {
  if (current.kind === 'running') return
  if (image === '') return

  const startedAt = Date.now()
  const controller = new AbortController()
  inflight = controller
  emit({ kind: 'running', startedAt })
  // 先落盘：页面若在跑的过程中被刷新，下一次挂载才知道「上次没跑完」。
  patchReverseSnapshot({ inflight: { startedAt }, result: null, error: null, pendingCards: [] })
  pending = []

  void (async () => {
    try {
      const result = await backend.reverse(image, options, controller.signal)
      if (controller.signal.aborted) return
      const text = result.text ?? ''
      if (result.ok && text !== '') {
        const run: Extract<RunState, { kind: 'done' }> = {
          kind: 'done',
          text,
          type: result.type ?? '',
          typeSource: result.typeSource ?? (result.type === undefined || result.type === '' ? 'none' : 'model'),
          cardsSource: result.cardsSource ?? ((result.recommendedCards?.length ?? 0) === 0 ? 'none' : 'model'),
          provider: result.provider ?? '',
          model: result.model ?? '',
          routeSource: result.routeSource ?? '',
          elapsedMs: result.elapsedMs ?? Date.now() - startedAt,
          warnings: result.warnings ?? [],
        }
        pending = result.recommendedCards ?? []
        emit(run)
        // 执行体自己落盘：这时面板可能已经卸载，没人替它写。
        patchReverseSnapshot({
          inflight: null,
          result: snapshotOf(run),
          error: null,
          pendingCards: pending,
        })
        return
      }
      if (result.ok && text === '') {
        const failure = {
          title: '反推没有返回内容',
          detail: '宿主回了 ok 但正文是空的',
          hint: '点「重新反推」再试一次。',
        }
        emit({ kind: 'error', ...failure })
        patchReverseSnapshot({ inflight: null, error: failure })
        return
      }
      const failure = failureOf(result.code ?? 'unknown', result.message ?? '未知错误')
      emit({ kind: 'error', ...failure })
      patchReverseSnapshot({ inflight: null, error: failure })
    } catch (error) {
      if (controller.signal.aborted) {
        // 用户主动取消：回到空态，存档里连中断标记都不留（这是明确的操作，不是意外）。
        emit({ kind: 'idle' })
        patchReverseSnapshot({ inflight: null })
        return
      }
      /**
       * 宿主回的「业务失败」（超时 / 拿不到聊天模型 / 图片太大…）是**抛出**的，
       * 不是一个 `ok:false` 的返回值 —— `callHost` 见到 `ok !== true` 就抛
       * `HostRouteError`。这里必须按 code 映射，否则超时与「拿不到模型」永远只会
       * 显示成一句通用的「反推失败」（2026-11-08 顺手修的既有缺陷）。
       */
      if (error instanceof HostRouteError) {
        const failure = failureOf(error.code, error.message)
        emit({ kind: 'error', ...failure })
        patchReverseSnapshot({ inflight: null, error: failure })
        return
      }
      const failure = {
        title: '反推失败',
        detail: error instanceof Error ? error.message : String(error),
        hint: '把上面这段原文发给助手排查，或点「重反推」再试一次。',
      }
      emit({ kind: 'error', ...failure })
      patchReverseSnapshot({ inflight: null, error: failure })
    } finally {
      if (inflight === controller) inflight = undefined
    }
  })()
}

/** 取消在飞反推（只有这里会 abort）。 */
export function cancelReverse(): void {
  inflight?.abort()
}

/**
 * 清空反推运行态（换源图 / 移除源图时调，`ReversePane` 两处入口）。
 *
 * 结果、报错、中断标记都属于「上一张图」：图一换，它们就不再是当前这张图的答案，
 * 留在界面上会让人误读。在飞的那次请求一并中止——它回来的是旧图的结论。
 * 注意：这只由用户动作触发，**不是**组件卸载的副作用（卸载不动请求）。
 */
export function clearRun(): void {
  const controller = inflight
  inflight = undefined
  controller?.abort()
  pending = []
  patchReverseSnapshot({ inflight: null, result: null, meta: null, error: null, pendingCards: [] })
  emit({ kind: 'idle' })
}

/** 待消费的推荐卡片 id。 */
export function pendingCards(): string[] {
  return pending
}

/** 推荐卡片已消费：清内存与存档，防止重挂载时再覆盖用户手动取消的选择。 */
export function consumePendingCards(): void {
  if (pending.length === 0) return
  pending = []
  patchReverseSnapshot({ pendingCards: [] })
}

/** 供自检断言：把执行体复位成空态（只在测试里用）。 */
export function resetRunForTests(next: RunState = { kind: 'idle' }): void {
  inflight?.abort()
  inflight = undefined
  pending = []
  emit(next)
}

/** 把「落盘结果」直接写进存档（供自检构造现场用）。 */
export function seedRunForTests(result: ReverseSnapshotResult | null): void {
  saveReverseSnapshot({
    version: 1,
    options: loadReverseSnapshot().options,
    result,
    meta: loadReverseSnapshot().meta,
    hasImage: loadReverseSnapshot().image !== '',
    inflight: null,
    error: null,
    pendingCards: [],
    updatedAt: Date.now(),
  })
}
