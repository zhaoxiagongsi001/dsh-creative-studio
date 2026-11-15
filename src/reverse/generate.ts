/**
 * 反推域：宿主侧 HTTP 处理。
 *
 * 与旧插件（`dsh-reverse-workbench/src/index.ts`）相比，这里**修了三个已知缺陷**：
 *
 *   1. **模型路由**：旧实现读 `ctx.agentDefaultModel.provider/.model`，但该服务的
 *      真实接口是 `currentSelection()`（见 `dsh-prompt-forge` 的同款处理），
 *      于是永远命中不到、固定回落到硬编码 `opencode-go/deepseek-v4.1-flash` ——
 *      用户在 DSH 里换默认模型对反推无效。这里改为 `currentSelection()`。
 *
 *   2. **loopback 校验**：旧实现没有，本机任意进程都能 POST 过来烧 token。
 *      这里复用生图域那套 `isLoopbackRequest`（对端地址 + Host + Origin 三判据）。
 *
 *   3. **超时与取消**：旧实现建了 AbortController 却没有任何 abort 触发点，
 *      上游挂住时浏览器一直 pending、按钮永远「处理中」，只能刷页面。
 *      这里加超时定时器 + 请求断开时中止。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pluginRoot } from '../plugin-root.ts'
import { badRequestBody, forbiddenBody, isLoopbackRequest, methodBody, readJsonBody, writeJson } from '../http.ts'
import { hostLog } from '../log-store.ts'
import { buildSystem, type ReverseOptions } from './rules.ts'
import { parseReverseOutput } from './protocol.ts'
import { inferType, matchCards, type MatchableCard } from './infer.ts'

/** 反推请求体上限：一张 4K JPEG 的 base64 约 8–12 MB，32 MB 足够宽松。 */
const REVERSE_BODY_BYTES = 32 * 1024 * 1024

/**
 * 单次反推的默认超时。
 *
 * 一次要出三版（还原/精简/风格），输出量约是单版的 2.5–3 倍：
 * 单版实测 20–40 秒，三版落在 60–110 秒区间，180 秒留足余量。
 * 界面全程显示已用秒数且可取消，所以放宽超时不会让用户干等不知道在干嘛。
 */
const DEFAULT_TIMEOUT_MS = 180_000

/** 宿主上下文里反推用到的那一小部分（结构化声明，不拉类型依赖）。 */
interface ReverseContext {
  get(name: string): unknown
}

/**
 * 拿宿主服务；拿不到返回 undefined（不抛）。
 *
 * 为什么可以传多个上下文：cordis 的**受限上下文**对未声明服务调 `get()` 会抛
 * （旧插件 2026-11-03 踩过，handler 直接抛出被转成 400 空响应体）。而不同服务
 * 挂在不同层：`llm` / `attachments` 在注入进来的 sctx 上就够，但
 * `agentDefaultModel` 在 `dsh-prompt-forge` 里是从**插件根 ctx** 读的。
 * 所以这里按传入顺序逐个试，任一命中即返回，全失败才退化成 undefined。
 */
function serviceOf(contexts: readonly unknown[], key: string): any {
  for (const ctx of contexts) {
    try {
      const value = typeof (ctx as ReverseContext)?.get === 'function' ? (ctx as ReverseContext).get(key) : undefined
      if (value !== undefined && value !== null) return value
    } catch {
      // 受限上下文会抛 —— 换下一个上下文继续试。
    }
  }
  return undefined
}

/** 从服务对象里读一个方法并绑好 this；形状不对返回 undefined。 */
function methodOf(service: unknown, name: string): ((...args: any[]) => any) | undefined {
  if (service === null || typeof service !== 'object') return undefined
  const fn = (service as Record<string, unknown>)[name]
  if (typeof fn !== 'function') return undefined
  return fn.bind(service)
}

/**
 * 读 DSH 当前配置的**聊天模型**。
 *
 * 反推是多模态读图，走的是聊天模型（不是 `config.json` 里那个生图模型）。
 * 唯一权威来源是 `agentDefaultModel.currentSelection()`（与 dsh-prompt-forge
 * 同款取法）。可以传多个上下文，因为 cordis 的受限上下文对未声明服务 get()
 * 会抛，而服务可能挂在不同层。
 *
 * ⚠️ 这里**故意没有兜底模型**。旧实现读不到就悄悄回落到硬编码
 * `opencode-go/deepseek-v4.1-flash`，界面照样显示成功 —— 用户以为在用
 * 自己配置的聊天模型，其实不是。这是 2026-11-07 老板指出的逻辑 bug。
 * 现在读不到就返回 undefined，调用方必须如实报错，绝不偷偷换模型。
 */
export function activeModelOf(ctx: unknown): { provider: string; model: string } | undefined {
  const contexts = Array.isArray(ctx) ? ctx : [ctx]
  for (const context of contexts) {
    try {
      const service = serviceOf([context], 'agentDefaultModel')
      const currentSelection = methodOf(service, 'currentSelection')
      if (currentSelection === undefined) continue
      const selection = currentSelection()
      if (selection === null || typeof selection !== 'object') continue
      const { provider, model } = selection as { provider?: unknown; model?: unknown }
      if (typeof provider === 'string' && provider.trim() !== '' && typeof model === 'string' && model.trim() !== '') {
        return { provider: provider.trim(), model: model.trim() }
      }
    } catch {
      // 受限上下文 get() 会抛 —— 换下一个上下文继续试，绝不向上抛。
    }
  }
  return undefined
}

/**
 * 解析反推用的 provider/model。
 *
 * 优先级：请求显式指定 → DSH 当前聊天模型 → **报错**（不再有硬编码兜底）。
 * 返回 undefined 时 `handleReverse` 会回 `no-active-model`，界面显示明确原因。
 */
export function routeOf(ctx: unknown, payload?: { provider?: unknown; model?: unknown }): { provider: string; model: string; source: string } | undefined {
  const contexts = Array.isArray(ctx) ? ctx : [ctx]
  if (typeof payload?.provider === 'string' && payload.provider.trim() !== ''
    && typeof payload?.model === 'string' && payload.model.trim() !== '') {
    return { provider: payload.provider.trim(), model: payload.model.trim(), source: 'request' }
  }
  const active = activeModelOf(contexts)
  if (active !== undefined) return { ...active, source: 'agentDefaultModel' }
  return undefined
}

/** data URL → 字节 + 媒体类型。 */
export function decodeDataUrl(
  value: unknown,
): { bytes: Buffer; mediaType: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/s.exec(value)
  if (match === null) return undefined
  const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1]
  try {
    const bytes = Buffer.from(match[2], 'base64')
    if (bytes.byteLength === 0) return undefined
    return { bytes, mediaType }
  } catch {
    return undefined
  }
}


/** 卡片库（本地推断兜底要用；读不到返回空数组）。 */
async function loadCatalogCards(): Promise<MatchableCard[]> {
  const file = path.join(pluginRoot(), 'data', 'suggestion-cards.json')
  const raw = await readFileSafe(file)
  if (raw === '') return []
  try {
    const groups = JSON.parse(raw) as Array<{ type: string; cards: Array<{ id: string; name: string; why: string; promptFragment?: string }> }>
    if (!Array.isArray(groups)) return []
    const flat: MatchableCard[] = []
    for (const group of groups) {
      if (!Array.isArray(group.cards)) continue
      for (const card of group.cards) {
        flat.push({ id: card.id, name: card.name, why: card.why, ...card.promptFragment === undefined ? {} : { promptFragment: card.promptFragment }, group: group.type })
      }
    }
    return flat
  } catch {
    return []
  }
}

/** 读文件，失败返回空串。 */
async function readFileSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/** 错误消息安全化。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * GET /dsh-creative/active-model —— 报告 DSH 当前配置的**聊天模型**。
 *
 * 界面靠它在**反推之前**显示「现在会用哪个模型反推」。反推走的是聊天模型
 * （多模态读图），不是 `config.json` 里的生图模型，两者不能混。
 *
 * 读不到时回 `ok:false` + 明确原因（不伪造、不兜底）；界面据此显示
 * 「未检测到聊天模型」并禁用反推按钮，避免点了才失败。
 */
export function handleActiveModel(ctx: ReverseContext | readonly ReverseContext[], req: IncomingMessage, res: ServerResponse): void {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, forbiddenBody())
    return
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, methodBody(req.method))
    return
  }
  const contexts = Array.isArray(ctx) ? ctx : [ctx]
  const active = activeModelOf(contexts)
  if (active === undefined) {
    writeJson(res, 200, {
      ok: false,
      code: 'no-active-model',
      message: '读不到 DSH 当前配置的聊天模型（agentDefaultModel.currentSelection 不可用）',
    })
    return
  }
  writeJson(res, 200, {
    ok: true,
    provider: active.provider,
    model: active.model,
    /** 明示这是聊天模型，避免和生图模型混淆。 */
    kind: 'chat',
  })
}

/**
 * GET /dsh-creative/cards —— 把 suggestion-cards.json 原样交给浏览器。
 *
 * 读不到也回 200 + ok:false：卡片库缺失不该让面板整块挂掉（反推主流程不依赖它）。
 */
export async function handleCards(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, forbiddenBody())
    return
  }
  if (req.method !== 'GET') {
    writeJson(res, 405, methodBody(req.method))
    return
  }
  try {
    const file = path.join(pluginRoot(), 'data', 'suggestion-cards.json')
    const text = await readFile(file, 'utf8')
    writeJson(res, 200, { ok: true, groups: JSON.parse(text) })
  } catch (error) {
    hostLog('warn', '建议卡片库读取失败：', messageOf(error))
    writeJson(res, 200, { ok: false, code: 'cards-unavailable', message: messageOf(error) })
  }
}

/**
 * POST /dsh-creative/reverse —— 反推主流程：一张图 + 一组勾选项 → 六段提示词。
 *
 * 为什么必须在宿主侧：客户端拿不到 `ctx.llm`（客户端运行时没有 llm 远程命名空间），
 * 而多模态调用要先把图片落成附件引用（ImageBlock 只接受 ImageAttachmentRef，
 * 不接受 base64 或 URL）。
 */
export async function handleReverse(ctx: ReverseContext | readonly ReverseContext[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 上下文数组：先 sctx（有注入服务）再插件根 ctx（有 agentDefaultModel）
  const contexts = Array.isArray(ctx) ? ctx : [ctx]
  // 修正点 ②：本机来源校验（旧实现没有，任何本地进程都能白烧 token）
  if (!isLoopbackRequest(req)) {
    writeJson(res, 403, forbiddenBody())
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, methodBody(req.method))
    return
  }

  const payload = await readJsonBody(req, REVERSE_BODY_BYTES)
  if (payload === undefined) {
    writeJson(res, 400, badRequestBody())
    return
  }

  const image = decodeDataUrl(payload.image)
  if (image === undefined) {
    writeJson(res, 400, { ok: false, code: 'bad-image', message: '需要 data:image/...;base64 形式的图片' })
    return
  }

  const llm = serviceOf(contexts, 'llm')
  const attachments = serviceOf(contexts, 'attachments')
  const stream = methodOf(llm, 'stream')
  const saveImages = methodOf(attachments, 'saveImages')
  if (stream === undefined) {
    writeJson(res, 200, { ok: false, code: 'llm-unavailable', message: '宿主没有挂 llm 服务' })
    return
  }
  if (saveImages === undefined) {
    writeJson(res, 200, { ok: false, code: 'attachments-unavailable', message: '宿主没有挂 attachments 服务' })
    return
  }

  // 2026-11-08 修：**所有前置检查必须在产生副作用之前**。
  // 旧顺序是先 saveImages（往内容寻址仓库写一个不可变对象）再 routeOf，
  // 于是 no-active-model 这种可预检的失败也会永久留下一个附件对象。
  // 现在的顺序：服务探测 → 模型路由 → 读技能拼 system → 最后才写附件。
  const route = routeOf(contexts, payload)
  if (route === undefined) {
    // 2026-11-07 修：不再静默回落到硬编码模型。读不到当前聊天模型就明确报错，
    // 让老板知道「反推没跑，因为拿不到你配置的模型」，而不是悄悄换个模型出结果。
    hostLog('warn', '拿不到 DSH 当前聊天模型（agentDefaultModel），反推已中止')
    writeJson(res, 200, {
      ok: false,
      code: 'no-active-model',
      message: '读不到 DSH 当前配置的聊天模型（agentDefaultModel.currentSelection 不可用）。反推必须用聊天模型做多模态读图，已中止，没有偷偷换用其它模型。请检查 DSH 模型设置后重试。',
    })
    return
  }

  const options: ReverseOptions = (payload.options ?? {}) as ReverseOptions
  let system: string
  try {
    system = await buildSystem(options)
  } catch (error) {
    writeJson(res, 200, { ok: false, code: 'system-failed', message: messageOf(error) })
    return
  }

  // 前置条件全绿，这里才开始产生副作用（写不可变附件对象）。
  let refs: any[]
  try {
    refs = await saveImages([{ data: image.bytes, mediaType: image.mediaType, name: 'reverse-source' }])
  } catch (error) {
    writeJson(res, 200, { ok: false, code: 'attach-failed', message: messageOf(error) })
    return
  }
  const ref = Array.isArray(refs) ? refs[0] : undefined
  if (ref === undefined) {
    writeJson(res, 200, { ok: false, code: 'attach-empty', message: '附件服务没有返回引用' })
    return
  }

  const timeoutMs = typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
    ? Math.min(payload.timeoutMs, 300_000)
    : DEFAULT_TIMEOUT_MS

  // 修正点 ③：超时 + 请求断开都能真的中止上游
  const controller = new AbortController()
  let abortedBy: 'timeout' | 'client' | 'none' = 'none'
  const timer = setTimeout(() => {
    abortedBy = 'timeout'
    controller.abort()
  }, timeoutMs)
  /**
   * 浏览器走人时的中止。
   *
   * **2026-11-08 修**：原来只挂了 `req.on('close')`，实测**收不到**「浏览器断开」——
   * 请求体一读完，IncomingMessage 的 close 语义就不再对应「连接没了」，于是点取消
   * 只断开前端、宿主这边 175 秒照跑，token 照烧，重试还会叠加请求。
   *
   * 现在挂真正会随连接消失而触发的那两个信号：
   *   · `res.on('close')` —— 响应没写完连接就没了（客户端 abort / 关窗 / 刷新）；
   *   · `req.on('aborted')` —— 老版本 Node 的断连事件，留着兜底。
   * 正常结束时 `res.writableEnded === true`，这里直接跳过，不会误伤。
   */
  const onClientGone = (): void => {
    if (res.writableEnded) return
    abortedBy = abortedBy === 'timeout' ? 'timeout' : 'client'
    controller.abort()
  }
  res.on('close', onClientGone)
  req.on('aborted', onClientGone)

  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'image' as const, attachment: ref },
        { type: 'text' as const, text: '请按上面要求的 0-6 六段结构，反推这张图的提示词。' },
      ],
    },
  ]

  const startedAt = Date.now()
  let assembled = ''
  try {
    for await (const chunk of stream({
      provider: route.provider,
      model: route.model,
      system,
      messages,
      temperature: 0.4,
      // opencode-go 适配器只有在 GenerateOptions.sessionId 存在时才附 x-opencode-session 头，
      // 缺了它上游直接回 400 MissingSessionID。
      sessionId: 'creative-studio-reverse',
      signal: controller.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') assembled += chunk.text
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        const failure = chunk.reason?.failure
        hostLog('warn', `反推上游失败：${failure?.code ?? 'unknown'} ${failure?.message ?? ''}`)
        writeJson(res, 200, {
          ok: false,
          code: failure?.code ?? 'upstream-error',
          message: failure?.message ?? '模型调用失败',
          provider: route.provider,
          model: route.model,
          routeSource: route.source,
          elapsedMs: Date.now() - startedAt,
        })
        return
      }
    }
  } catch (error) {
    if (abortedBy === 'timeout') {
      hostLog('warn', `反推超时（${timeoutMs} ms），已中止上游`)
      writeJson(res, 200, {
        ok: false,
        code: 'timeout',
        message: `反推超时（${Math.round(timeoutMs / 1000)} 秒没有响应），已中止。可以重试，或换一个更快的模型。`,
        provider: route.provider,
        model: route.model,
        routeSource: route.source,
        elapsedMs: Date.now() - startedAt,
      })
      return
    }
    if (abortedBy === 'client') {
      // 浏览器已经走了，没人接收响应；记一条日志就够。
      hostLog('info', '反推被浏览器取消')
      return
    }
    hostLog('warn', '反推流式调用失败：', messageOf(error))
    writeJson(res, 200, {
      ok: false,
      code: 'stream-failed',
      message: messageOf(error),
      provider: route.provider,
      model: route.model,
      routeSource: route.source,
      elapsedMs: Date.now() - startedAt,
    })
    return
  } finally {
    clearTimeout(timer)
    res.off('close', onClientGone)
    req.off('aborted', onClientGone)
  }

  const text = assembled.trim()
  if (text === '') {
    writeJson(res, 200, {
      ok: false,
      code: 'empty',
      message: '模型没有返回内容',
      provider: route.provider,
      model: route.model,
      routeSource: route.source,
      elapsedMs: Date.now() - startedAt,
    })
    return
  }

  // 按输出协议切开：两行元信息（类型 / 卡片）+ 六段正文
  const parsed = parseReverseOutput(text)
  if (parsed.warnings.length > 0) {
    hostLog('warn', `反推输出协议降级：${parsed.warnings.join('；')}`)
  }

  const body = parsed.text

  // 模型没给元信息时，用**本地推断**补齐（否则判定行与卡片预勾选永远是空）
  let type = parsed.type
  let typeSource: 'model' | 'inferred' | 'none' = type !== '' ? 'model' : 'none'
  let cards = parsed.cards
  let cardsSource: 'model' | 'inferred' | 'none' = cards.length > 0 ? 'model' : 'none'

  if (type === '' || cards.length === 0) {
    try {
      const inferredType = type === '' ? inferType(body) : type
      if (type === '' && inferredType !== '') {
        type = inferredType
        typeSource = 'inferred'
      }
      if (cards.length === 0) {
        const catalog = await loadCatalogCards()
        const matched = matchCards(body, catalog, type)
        if (matched.length > 0) {
          cards = matched
          cardsSource = 'inferred'
        }
      }
    } catch (error) {
      hostLog('warn', '本地推断失败（不影响正文）：', messageOf(error))
    }
  }

  writeJson(res, 200, {
    ok: true,
    /** 六段正文（单版；老板 2026-11-07 决定不再出三版）。 */
    text: body,
    chars: body.length,
    type,
    typeSource,
    recommendedCards: cards,
    cardsSource,
    warnings: parsed.warnings,
    provider: route.provider,
    model: route.model,
    routeSource: route.source,
    elapsedMs: Date.now() - startedAt,
  })
}
