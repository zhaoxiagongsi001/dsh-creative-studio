/**
 * 面板草稿（阶段 9）。
 *
 * 位置：`<用户主目录>/.dsh/dsh-creative-panel/draft.json`
 *
 * 为什么需要它：面板状态原来只活在模块作用域里 —— 切面板能留住，**重启 DSH 就全没了**。
 * 而「首次进入生图插件时，上次生成成功就给我空的、上次写了没生成就留着」这条规则
 * 需要一个跨重启的判据：既要那份没生成的草稿，也要「最后一次成功生成用的是哪句提示词」。
 * 所以落盘三件事：
 *   1. 草稿本体（提示词 + 核心四项参数 + 模型驱动表单那些额外字段）；
 *   2. `lastGeneratedPrompt` —— 最后一次**成功生成**用的提示词；
 *   3. 更新时间。
 *
 * 判「这份草稿是不是未生成的」**不在这里做**：宿主只负责如实存取，
 * 规则（含空串、前后空白怎么算）集中在前端一处，免得两边各有一套「脏」的定义。
 *
 * 三个刻意的决定：
 *  - **宽松收敛**：磁盘文件可能被手改过，一个坏字段不该让面板起不来 ——
 *    非法值退回默认，整体永远返回一份能直接用的草稿。
 *  - **只存文本，不存参考图**：参考图是几 MB 的 data URL，落盘会让这份小 JSON 变成
 *    一块二进制垃圾场；界面上如实显示「参考图 N 张」就够了。
 *  - **原子写**：临时文件 + rename，避免写到一半断电留下半个 JSON。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imagegenHome } from './config-store.ts'

/** 草稿文件格式版本，供将来迁移用。 */
export const DRAFT_VERSION = 1

/** 提示词的长度上限（面板输入框自己限 4000，这里放宽到 20000 只为兜住手改的文件）。 */
export const MAX_DRAFT_PROMPT = 20000

/** 单个额外字段取值的长度上限。 */
const MAX_DRAFT_VALUE = 200

/** 额外字段最多记多少个（模型的参数表最多 10 项，32 已经非常宽松）。 */
const MAX_DRAFT_EXTRA = 32

/**
 * 外部导入的参考图最多几张。
 *
 * 16 与客户端 `Composer.tsx` 的网关硬限 `GLOBAL_MAX_REFERENCES` 是同一个数
 * （上游 OpenAPI 的 `input_references.maxItems`）—— 导入是唯一能绕过界面上限的入口，
 * 所以这道闸与生成侧必须对齐，否则会导进一批发不出去的图。
 */
export const MAX_PENDING_REFERENCES = 16

/**
 * 单张导入参考图的字符上限。
 *
 * 4 MB 与客户端 `Composer.tsx` 的 `MAX_REFERENCE_BYTES`（单张上限）同口径：
 * 导入方应当在**递进来之前**就下采样（长边 2048），这里只是兜住手改/算错的调用方。
 */
export const MAX_PENDING_REFERENCE_CHARS = 4 * 1024 * 1024

/** 草稿里的核心四项参数（键与前端 `ParamState` 一致，值是字符串）。 */
export interface DraftParams {
  aspectRatio: string
  resolution: string
  count: string
  quality: string
}

/** 一份草稿。 */
export interface PanelDraft {
  version: number
  /** 输入框里的提示词（`''` = 空）。 */
  prompt: string
  /** 参数区的当前取值。 */
  params: DraftParams
  /** 模型驱动表单里那些额外字段。 */
  extra: Record<string, string>
  /** 最后一次**成功生成**用的提示词（用来判断 {@link PanelDraft.prompt} 是不是新草稿）。 */
  lastGeneratedPrompt: string
  /**
   * 最后一次**成功生成**的那张图的 id（`''` = 还没有 / 用户点过「清空」）。
   *
   * 它只回答一个问题：**回到面板时舞台上该摆哪张图**。
   *
   * 为什么值得占一个字段（2026-10-18）：切到会话/新建会话会把面板卸载，再点「生图」
   * 是重新挂载 —— 舞台原来一律是空的，老板看到的就是「刚才那张图不见了，得再生成一次
   * 才又能看到图」。模块作用域只撑得住同一次 DSH 运行，重启后又回到空舞台，
   * 所以这根「该恢复哪张图」的引用必须跟提示词一样落盘。
   *
   * 存的是 id 而不是图片本身：图片在 `out/` + `index.json` 里，这里只是指针，
   * 不产生第二份数据（也不该让这颗小 JSON 长胖）。
   */
  lastImageId: string
  /**
   * **外部导入**（反推工作台等）递进来、但面板还没消费掉的参考图（data URL 数组）。
   *
   * 为什么这里会破「只存文本」那条规矩（2026-11-03）：面板只在**挂载时**读一次草稿，
   * 之后由前端 400 ms 防抖回写；另一个插件想让「参考图」也跟提示词一起送进来，
   * 唯一能被现有读取链路捞到的载体就是这颗草稿文件。所以它只在**两次挂载之间**
   * 短暂存在：面板一读到就把它搬进内存、立刻回写清空（见 `ImageGenPanel.tsx` 的
   * `applyPendingImport`），正常情况下不会长期留在磁盘上。
   *
   * 可选而不是必填：升级前的 `draft.json` 没有这个键，读出来就是 `undefined`/`[]`，
   * 行为与本改动之前完全一致。`DRAFT_VERSION` 因此**保持 1**。
   */
  pendingReferences?: string[]
  /** 服务端写入时间（毫秒）。 */
  updatedAt: number
}

/** 草稿文件的绝对路径。 */
export function draftFilePath(): string {
  return path.join(imagegenHome(), 'draft.json')
}

/** 一份空草稿（还没有任何草稿时用它打底）。 */
export function emptyPanelDraft(): PanelDraft {
  return {
    version: DRAFT_VERSION,
    prompt: '',
    params: { aspectRatio: '', resolution: '', count: '1', quality: '' },
    extra: {},
    lastGeneratedPrompt: '',
    lastImageId: '',
    // 空数组而不是缺键：调用方（面板的「有没有待消费导入」）只判 length，
    // 三态里「没有」就是明确的 `[]`。
    pendingReferences: [],
    updatedAt: 0,
  }
}

/** 一个可用的字符串（非字符串时给兜底）。提示词这类**只认字符串**：数字没有意义。 */
function draftText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * 一个标量 → 字符串。
 *
 * 参数与额外字段走这条：与宿主侧解析生成请求时的口径一致（数字/布尔一律字符串化），
 * 免得「张数 42」这种数字在草稿里被当成坏值丢掉。
 */
function draftScalar(value: unknown, max: number): string {
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return ''
}

/**
 * 把任意来源的「待生效参考图」宽松收敛成 data URL 数组。
 *
 * 三条丢弃规则（导入是**外部插件**写进来的，不能假设它一定守规矩）：
 *   - 非数组 → 空数组（旧草稿 / 手改坏的文件）；
 *   - 非字符串、空串、不以 `data:image/` 开头 → 丢弃（参考图一定是 data URL，
 *     别的形状交给它只会变成上游 400）；
 *   - 单条超过 {@link MAX_PENDING_REFERENCE_CHARS} → 丢弃（不是截断：截半个 base64
 *     是一张坏图，比没有更糟）；总条数超过 {@link MAX_PENDING_REFERENCES} → 取前 N 张。
 * @param value - 未知来源的字段值。
 * @returns 可直接塞进面板参考图槽的 data URL 数组。
 */
export function coercePendingReferences(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (out.length >= MAX_PENDING_REFERENCES) break
    if (typeof item !== 'string') continue
    if (item.length < 'data:image/'.length || !item.startsWith('data:image/')) continue
    if (item.length > MAX_PENDING_REFERENCE_CHARS) continue
    out.push(item)
  }
  return out
}

/**
 * 把任意来源（磁盘文件、PUT body）的字段宽松地收敛成一份草稿。
 * @param raw - 未知来源的对象。
 * @returns 完整的草稿（字段缺失时用空值补齐）。
 */
export function coercePanelDraft(raw: unknown): PanelDraft {
  const base = emptyPanelDraft()
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>

  const rawParams = (typeof source.params === 'object' && source.params !== null ? source.params : {}) as Record<string, unknown>
  const params: DraftParams = {
    aspectRatio: draftScalar(rawParams.aspectRatio, 64),
    resolution: draftScalar(rawParams.resolution, 64),
    count: draftScalar(rawParams.count, 16) === '' ? base.params.count : draftScalar(rawParams.count, 16),
    quality: draftScalar(rawParams.quality, 64),
  }

  const extra: Record<string, string> = {}
  if (typeof source.extra === 'object' && source.extra !== null) {
    for (const [key, value] of Object.entries(source.extra as Record<string, unknown>)) {
      if (Object.keys(extra).length >= MAX_DRAFT_EXTRA) break
      if (key === '' || key.length > 64) continue
      const text = draftScalar(value, MAX_DRAFT_VALUE)
      if (text === '') continue
      extra[key] = text
    }
  }

  return {
    version: DRAFT_VERSION,
    prompt: draftText(source.prompt, MAX_DRAFT_PROMPT),
    params,
    extra,
    // 上限与提示词一致：它本来就是「上一句提示词」。
    lastGeneratedPrompt: draftText(source.lastGeneratedPrompt, MAX_DRAFT_PROMPT),
    // 图片 id 是宿主自己生成的短串（`gen-<36 进制时间>-<序号>-<随机>`，约 25 字符）。
    // 128 是宽松上限：手改的文件塞进来一坨长文本也不该被存下去。
    // 顺带一条：非字符串（数字 / 数组 / 对象）一律收敛成空串 —— 空的后果只是「舞台不恢复」，
    // 比拿一个假 id 去查图、最后渲染出一个裂图要好。
    lastImageId: draftText(source.lastImageId, 128),
    // 外部导入的待生效参考图。旧文件没有这个键 → `[]`，面板看到 length 0 就什么都不做。
    pendingReferences: coercePendingReferences(source.pendingReferences),
    updatedAt: typeof source.updatedAt === 'number' && Number.isFinite(source.updatedAt) ? source.updatedAt : 0,
  }
}

/**
 * 读草稿。
 * @returns 草稿；文件不存在或已损坏时返回 `undefined`（调用方按「还没有草稿」处理）。
 */
export async function readPanelDraft(): Promise<PanelDraft | undefined> {
  let text: string
  try {
    text = await readFile(draftFilePath(), 'utf8')
  } catch {
    return undefined
  }
  try {
    return coercePanelDraft(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * 写草稿（原子写：临时文件 + rename）。
 * @param draft - 要落盘的草稿（`updatedAt` 由这里覆盖成当前时间）。
 * @returns 落盘后的草稿（含新的 `updatedAt`）。
 */
export async function writePanelDraft(draft: PanelDraft): Promise<PanelDraft> {
  const next: PanelDraft = { ...coercePanelDraft(draft), version: DRAFT_VERSION, updatedAt: Date.now() }
  const file = draftFilePath()
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await rename(temp, file)
  return next
}
