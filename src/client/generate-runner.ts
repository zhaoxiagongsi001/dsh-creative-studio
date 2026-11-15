/**
 * 生图执行体（模块作用域单例）。
 *
 * ## 为什么请求要搬出组件（老板 2026-11-15 要求修）
 *
 * 原来 `backend.generate()` 在 `ImageGenPanel.generate()` 里直接 await，`run` 也只是
 * 组件的 useState —— 而卸载 cleanup 会 `abort()` 在飞请求。偏偏「切到别的会话」
 * 就会卸载主区面板，于是：
 *   · 一次生图要等几十秒、按张计费，切一下窗口就白等（上游可能已经出图并扣了费）；
 *   · 切回来面板从「idle」重新开始，既看不到「还在跑」，也看不到刚才那张图；
 *   · 失败信息随组件一起消失，老板只能靠记忆复述报错。
 *
 * 现在请求挂在模块作用域（与 `reverse-runner.ts` 同一心智模型）：
 *   · 组件卸载**不**动它，跑完/失败把结果写进 localStorage 并通知订阅者；
 *   · 切回来（重新挂载）从内存 / 存档读到 running、done 或 error；
 *   · 只有用户点「取号重来 / 取消」才 abort；页面刷新 / 关窗仍会打断（浏览器行为），
 *     那次靠快照里的 `inflight` 标记识别成「上次被中断」并如实显示。
 *
 * 心智模型：**一次生图是一次「下载」，不是一次「渲染」**——它属于页面，不属于面板。
 */
import { createHttpBackend } from './api.ts'
import { loadGenerateSnapshot, patchGenerateSnapshot, resolveGenerateBootFor } from '../generate/persist.ts'
import {
  GenerateError,
  type Backend,
  type GenerateRequest,
  type PanelConfig,
  type RunState,
} from './types.ts'

/** 后端单例（与面板共用一份实现）。 */
const backend: Backend = createHttpBackend()

/** 页面实例 id 的存储键（sessionStorage：刷新保留、新标签页独立）。 */
const OWNER_KEY = 'dsh-creative.generate.owner'

/**
 * 本页面实例的 id。
 *
 * 用来区分「本页上次没跑完」和「另一个标签页正在跑」——两者的存档长得一样，
 * 但只有前者该显示「上次生成被中断」，后者显示中断会诱导用户再点一次重试，
 * 变成两次付费请求。拿不到 sessionStorage 时给空串（按老行为处理）。
 */
function ownerOf(): string {
  try {
    const storage = (globalThis as { sessionStorage?: Storage }).sessionStorage
    if (storage === undefined) return ''
    const existing = storage.getItem(OWNER_KEY)
    if (existing !== null && existing !== '') return existing.slice(0, 64)
    const fresh = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    storage.setItem(OWNER_KEY, fresh)
    return fresh
  } catch {
    return ''
  }
}

/** 本次页面实例的 id。 */
const owner = ownerOf()

/** 当前状态（页面内唯一一份）。 */
let current: RunState = hydrate()

/** 订阅者（面板每次挂载都重新订阅）。 */
const listeners = new Set<() => void>()

/**
 * 在飞请求的控制器。
 *
 * 只有「取消」会动它；组件卸载、切模式、切会话一律不碰 —— 这是本模块存在的全部理由。
 */
let inflight: AbortController | undefined

/**
 * 页面刚加载时的状态判定：中断 / 失败 / 空。
 *
 * 「中断」没有自己的 RunState 档位（`ResultStage` 只认 idle / running / done / error）：
 * 它本质上就是一次**没拿到结果的失败**，转成 error 态并写明原因即可，界面不用加分支。
 * 同时把存档里的 `inflight` 换成一条 error —— 再刷新时看到的是同一条说明，
 * 而不是反复倒计时的「上次生成被中断」。
 */
function hydrate(): RunState {
  const boot = resolveGenerateBootFor(loadGenerateSnapshot(), owner)
  if (boot.kind === 'error') {
    return { kind: 'error', ...boot.failure }
  }
  if (boot.kind === 'interrupted') {
    // 走到这里说明 owner 与本页一致（别人的 in-flight 已在 resolveGenerateBootFor 里滤掉）。
    const seconds = Math.max(1, Math.round(boot.elapsedMs / 1000))
    const failure = {
      message: '上次生成被中断',
      detail: `页面刷新或关闭打断了这次请求，图没有回来（已进行约 ${seconds} 秒）。提示词和参数还在面板上，点「重新生成」即可再跑一次。`,
      // 请求已经发出去了，上游可能出了图也扣了费 —— 不能再承诺「本次未计费」。
      billing: 'unknown' as const,
    }
    patchGenerateSnapshot({
      inflight: null,
      error: { ...failure, prompt: boot.prompt, at: Date.now() },
    })
    return { kind: 'error', ...failure }
  }
  return { kind: 'idle' }
}

/** 改状态并通知订阅者。 */
function emit(next: RunState): void {
  current = next
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      // 一个订阅者抛错不该影响其它订阅者，更不该让执行体挂掉。
      console.warn('[dsh-creative-studio] 生图状态订阅者报错：', error)
    }
  }
}

/** 异常 → 面板能直接展示的 message / detail。 */
function failureOf(error: unknown): { message: string; detail: string } {
  if (error instanceof GenerateError) return { message: error.message, detail: error.detail }
  return {
    message: '生成失败',
    detail: error instanceof Error ? error.message : String(error),
  }
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
 * 开始一次生图。
 *
 * 幂等：正在跑时再点不会叠加第二个请求（旧实现会在面板上并发两次，白色花钱）。
 * @param config - 面板配置（Base URL / 模型）。
 * @param request - 这一次的完整请求体（提示词、参数、参考图）。
 */
export function startGenerate(config: PanelConfig, request: GenerateRequest): void {
  if (current.kind === 'running') return

  const startedAt = Date.now()
  const controller = new AbortController()
  inflight = controller
  emit({ kind: 'running', startedAt })
  // 先落盘：页面若在跑的过程中被刷新，下一次挂载才知道「上次没跑完」。
  // owner 一起写：别的标签页读到它时才知道这是「别人的请求」，不该报中断。
  patchGenerateSnapshot({ inflight: { startedAt, prompt: request.prompt, owner }, error: null })

  void (async () => {
    try {
      const image = await backend.generate(config, request, controller.signal)
      /**
       * 成功就是成功 —— **不再因为 `signal.aborted` 丢掉结果**。
       *
       * 原来的写法是「aborted 就直接 return」，但有个卡死的边界：用户点取消的同时
       * 上游刚好返回（`fetch` 已 resolve、abort 稍后生效），那个 return 会把
       * 状态永远留在 running —— 面板一直转圈、没有取消按钮也没有图。
       * 而这张图其实已经生成并计费了，没有理由不给用户。真正的取消场景里
       * `fetch` 会 reject，走下面的 abort 分支，不会到这里。
       */
      emit({ kind: 'done', image })
      // 执行体自己落盘：这时面板可能已经卸载，没人替它写。
      patchGenerateSnapshot({ inflight: null, error: null })
    } catch (error) {
      if (controller.signal.aborted) {
        /**
         * 用户主动取消：回到空态，存档里连中断标记都不留（这是明确操作，不是意外）。
         *
         * 但先认一下「这个 controller 还是当前在飞的那一个吗」：`cancelGenerate`
         * 已经把自己的收尾做完了（emit idle + 清 inflight），此时若用户已经点了
         * 新的生成，`inflight` 指向的是新 controller —— 这里再 emit idle 会把
         * 新请求的 running 状态清掉。归属不符就直接退出。
         */
        if (inflight !== controller) return
        emit({ kind: 'idle' })
        patchGenerateSnapshot({ inflight: null })
        return
      }
      const failure = failureOf(error)
      emit({ kind: 'error', ...failure })
      // 失败原因必须落盘：老板要的是「切走再回来报错还在」，面板卸载后就没人写了。
      patchGenerateSnapshot({
        inflight: null,
        error: { ...failure, prompt: request.prompt, at: Date.now() },
      })
    } finally {
      if (inflight === controller) inflight = undefined
    }
  })()
}

/**
 * 取消在飞生图（只有这里会 abort）。
 *
 * 先把状态切回空态再 abort：`abort()` 到 `fetch` 真的 reject 之间有一段很短、
 * 但用户感觉得到的时间 —— 那会儿面板还显示「取消中 / 转圈」。先 emit 让按钮
 * 立刻回到「生成」。事件体里的 abort 分支会再 emit 一次 idle，幂等无害。
 */
export function cancelGenerate(): void {
  const controller = inflight
  inflight = undefined
  if (current.kind === 'running') emit({ kind: 'idle' })
  // 取消是明确操作，不是意外中断：存档里连 inflight 都不留。
  patchGenerateSnapshot({ inflight: null })
  controller?.abort()
}

/**
 * 收掉「上一次失败」那张卡片。
 *
 * 面板上有个动作会让报错态显得不合理：**用户点了历史里的一张图**——舞台却还挂着
 * 上次的报错卡片，看着像点了没用。所以点历史图时把报错态让位给「看这张图」。
 * 存档里的 error 一并清掉，否则下次挂载会把这张早就看过的错误卡片又摆回来。
 */
export function dismissGenerateError(): void {
  if (current.kind !== 'error') return
  emit({ kind: 'idle' })
  patchGenerateSnapshot({ error: null })
}

/**
 * 收掉「已完成」的那张图。
 *
 * 清空历史时调用：done 是终态、不会自己回 idle，而完成回灌的 effect 会拿
 * `run.image` 把舞台和 `lastImageId` 又摆回来（还顺手写回草稿盘）。清完历史
 * 留一张孤儿图在舞台上，看起来像没清干净。把 done 收成 idle 即可。
 */
export function clearGeneratedStage(): void {
  if (current.kind !== 'done') return
  emit({ kind: 'idle' })
}

/** 供自检断言：把执行体复位成给定状态（只在测试里用）。 */
export function resetGenerateForTests(next: RunState = { kind: 'idle' }): void {
  inflight?.abort()
  inflight = undefined
  emit(next)
}
