/**
 * 反推规则层：把「界面上的勾选项」翻译成「给模型看的中文口径指令」。
 *
 * 规则来源（三份设计规范，都在 `docs/` 下）：
 *   · `model-dialects.md`  —— 三档方言（GPT 合并 / Gemini 抽条 / Qwen 留结构）
 *   · `nsfw-tiers.md`      —— L1/L2/L3 分档改写 + 21 组词对照 + 服装覆盖兜底句
 *   · `person-replace-spec.md` —— 换人 A1–A3 / 服装 B1–B3 / 姿态 C1–C3 / 重绘 D1–D3
 *
 * 拼装顺序是**承重**的（`person-replace-spec.md` §9 明确规定）：
 *   A/B/C/D 骨架 → 建议卡片（只进 2/5 段）→ 额外要求 → NSFW 改写 → 方言改写
 * 反过来（先锁脸再降档、或先定方言再改写）会把措辞固定死，后面就改不动了。
 *
 * 这一层是**纯函数**（除了读技能文件与卡片库），改口径不需要碰路由。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { protocolInstruction } from './protocol.ts'
import { pluginRoot } from '../plugin-root.ts'

/** 换人档位：不换 / A1 只换脸 / A2 换脸+身材 / A3 全身含姿态。 */
export type PersonMode = 'none' | 'A1' | 'A2' | 'A3'
/** 服装档位：B1 保留原图 / B2 跟参考图 / B3 自填。 */
export type ClothingMode = 'B1' | 'B2' | 'B3'
/** 姿态档位：C1 保持原图 / C2 跟参考图 / C3 自填。 */
export type PoseMode = 'C1' | 'C2' | 'C3'
/** 重绘强度：D1 保守 / D2 平衡 / D3 激进。 */
export type RedrawMode = 'D1' | 'D2' | 'D3'
/** 锁脸强度：短 / 中 / 强。 */
export type LockStrength = 'short' | 'medium' | 'strong'

/** 反推选项（由浏览器下发）。 */
export interface ReverseOptions {
  /** 换人档位（四选一，互斥）。 */
  person?: PersonMode
  /** 服装档位。 */
  clothing?: ClothingMode
  /** B2 前提：用户确认目标人物图里能看清服装。 */
  clothingVisible?: boolean
  /** B3 自填描述（需含款式/颜色/面料/领型/下摆）。 */
  clothingText?: string
  /** 姿态档位（仅 A2/A3 有效）。 */
  pose?: PoseMode
  /** C3 自填姿态。 */
  poseText?: string
  /** 重绘强度。 */
  redraw?: RedrawMode
  /** 锁脸强度。 */
  lockStrength?: LockStrength
  /** 生图阶段是否会同时上传原图（决定提示词里能不能出现「参考图 2」）。 */
  keepSource?: boolean
  /** 年龄定调（默认「成年」）。 */
  ageText?: string
  /** 锁定的维度名字数组，例如 ['构图','光线']。 */
  locks?: string[]
  /** 勾选的建议卡片（名字 + 理由 + 提示词片段）。 */
  cards?: Array<{ name: string; why: string; fragment?: string }>
  /** 自由建议的补充说明。 */
  extra?: string
  /** NSFW 档位：L1 / L2 / L3；空表示不处理。 */
  nsfw?: '' | 'L1' | 'L2' | 'L3'
  /** 目标方言：gpt / gemini / qwen。 */
  dialect?: 'gpt' | 'gemini' | 'qwen'
}

/* ============================================================ 硬规则（三档共同）

   来自 `model-dialects.md` §common 与 `nsfw-tiers.md` 的红线：这三条与方言无关，
   任何一档都必须遵守。 */

const HARD_RULES = [
  '【硬规则】（任何档位都必须遵守）',
  '1. 人物一律写明「成年」；不给未成年的任何设定，不写「看起来未成年」。',
  '2. 禁止项**不要**写成否定词堆叠：OpenAI 图像 API 没有 negative prompt 字段，',
  '   要写成正向描述 + 一句「画面中不出现……」；Gemini 档允许单列一行「禁止：」。',
  '3. 量化一律降级为定性：不写 hex 色值、不写百分比、不写像素级尺寸；',
  '   写「米白、暖灰、近黑三色」「大面积」「强主光」这种量级词。只保留语义可数项（几件、几个）。',
  '4. 不写真实品牌 Logo、不写可辨认的商标文字。',
  '5. 只描述画面本身，不输出任何解释、判定过程、自我评价或 Markdown 代码围栏。',
].join('\n')

/* ============================================================ 方言三档

   摘自 `model-dialects.md`（GPT D28-54 / Gemini D100-126 / Qwen D157-183）。
   注意一个**有意偏离**：规范说 Gemini 档不需要保留 0–6 标题，但我们把 0–6 标题
   当作**内部结构约定**（面板靠它切段渲染），所以三档都保留标题，只让内容风格
   随方言变化。这一点写进了给模型的指令里，避免它自作主张删标题。 */

function dialectBlock(dialect: ReverseOptions['dialect']): string {
  if (dialect === 'gemini') {
    return [
      '【方言 · Gemini（nano-banana）】',
      '· 短句 + 强指令：一句一个约束，祈使句为主（「画面主体为……」「镜头使用……」「禁止……」）。',
      '· 六段标题保留（这是内部结构约定），但段内用短标签句式：「画面 / 主体 / 镜头 / 光线 / 色调 / 禁止」，每段 1–3 句。',
      '· 形容词必须具体到能画出来，不要「唯美」「高级感」「氛围拉满」这类无法执行的词。',
      '· 构图、机位、画幅、留白必须写死；多参考图时要写清分工（「参考图 1 决定脸」）。',
      '· 300–800 字，5–12 行；超过 1000 字反而丢约束。密集否定链要改正向描述。',
      '· 皮肤微观质感属弱效，别写毛孔级细节。',
    ].join('\n')
  }
  if (dialect === 'qwen') {
    return [
      '【方言 · Qwen Image】',
      '· 中文原生结构化：0–6 六段标题 + 段内分条，每条约束独立成行。',
      '· 每条以「必须 / 禁止 / 优先」开头，模型对中文祈使句响应稳定。',
      '· 不要为了「像英语 prompt」而翻译成英文——中文反而更准，画面内文字尤其如此。',
      '· 800–1500 字，每段 2–6 条；分条优于长段落，同一条约束独立成行命中率更高。',
      '· 禁止项**单列一节**，不要与正文混写，也不要为了省 token 把禁止项删掉。',
    ].join('\n')
  }
  return [
    '【方言 · GPT Image 系列】',
    '· 自然语言长句：把「谁、在哪、做什么、怎么打光」串成连贯描述，不要罗列短语。',
    '· 六段标题保留（内部结构约定），段内必须是完整句子，不要写成标签列表；只有多主体或服装极复杂才用 1.1/1.2 小节。',
    '· 允许中文全角标点；少用 ｜、→、【】 这类符号堆叠，模型会把符号当噪音。',
    '· 没有 negative prompt 字段：禁止项必须写成正向句 +「画面中不出现……」。',
    '· 大量色值与百分比无效——写「米白、暖灰、近黑三色」比写三个 hex 有效。',
    '· 1500–3000 字；超过 3500 字收益递减，优先保 0/1/3/5 段再补 2/4/6。',
  ].join('\n')
}

/* ============================================================ 换人 A/B/C/D

   摘自 `person-replace-spec.md`。四组是**互斥档位**而不是独立勾选：
   选了 A2 就必然包含 A1 的全部动作（规范里不存在「只换身材不换脸」）。 */

/** 锁脸句三档强度（P121-123 原文）。 */
const LOCK_SENTENCES: Record<LockStrength, string> = {
  short: '面部 100% 取自参考图 1，不做任何改动。',
  medium:
    '面部 100% 取自参考图 1：五官形状、脸型骨相、肤色、发际线与可辨识特征均以参考图 1 为准，不做美化、整形与年轻化处理。',
  strong:
    '面部与头部完全由参考图 1 决定：禁止依据文字描述重新设计任何面部特征；若文字描述与参考图 1 冲突，一律以参考图 1 为准，删除冲突的文字。',
}

/** A1 的 6 段追加（P65-66 原文）。 */
const A1_CONSTRAINTS = [
  '必须保留：① 面部 100% 取自参考图 1，不得二次创作五官；② 原图的构图、机位、景别、光源方向与色温；③ 原图的服装款式、背景与道具。',
  '严格禁止：改动脸型与五官比例、替换成第二张脸、按文字描述重新设计面部、过度磨皮抹掉皮肤纹理与辨识特征。',
]

/** A2 的 6 段追加（P80-81 原文）。 */
const A2_CONSTRAINTS = [
  '必须保留：身形比例取自参考图 1，服装款式与图案保持原图不变。',
  '冲突让步：服装合身度可让步（允许按参考图 1 身材出现自然松紧与褶皱），服装款式与图案不让步。',
]

/** A3 的 6 段追加（P100-101 原文）。 */
const A3_CONSTRAINTS = [
  '必须保留：姿态与肢体关系取自参考图 1；画幅比例、机位高度、光源方向保持原图。',
  '冲突让步：构图位置可让步（允许人物在画幅内移动、允许裁掉部分肢体末端），姿态不让步；光效可让步（允许为照亮姿态小幅调整灯位与光比），面部结构不让步。',
]

/** 取 / 不取清单标准句式（P111、P115 原文）。 */
const TAKE_LIST =
  '取自参考图 1：① 面部结构与五官形状；② 脸型、骨相、下颌线；③ 肤色与皮肤质感；④ 发际线与可辨识的痣、疤等特征；⑤【A2 起】身材比例与体态；⑥【A3 起】整体姿态与肢体关系。'
const NOT_TAKE_LIST =
  '不取自参考图 1：① 服装款式、面料与图案；② 背景、道具与环境；③ 光源方向、光比与色温；④ 镜头焦段、机位高度与景别；⑤ 色调与后期风格；⑥ 妆容类型（妆感按原图，五官按参考图 1）。'

/** 冲突优先级（P135 原文）。 */
const PRIORITY =
  '冲突优先级：① 身份保真（脸） ＞ ② 光效（光源方向 / 光比 / 色温） ＞ ③ 色彩（色调 / 饱和度 / 色系） ＞ ④ 构图（取景 / 位置 / 裁切）。妆感与皮肤质感可让步，脸不让步。'

/** 一致性验收句（P127 原文，写进 6.4）。 */
const ACCEPTANCE =
  '验收：100% 放大后，面部各特征点位置与参考图 1 一致（眼距、鼻宽、唇厚、下颌角、眉形走向），可通过并排比对确认是同一人；不同角度下不出现「看得出是另一个人」的偏差；皮肤保留真实毛孔与纹理，无塑料感与蜡像感。'

/** 重绘强度三档措辞（P151-155 原文）。 */
const REDRAW_TEXT: Record<RedrawMode, string> = {
  D1: '以保留参考图 1 与原图的全部可辨信息为第一目标；除身份替换外，构图、服装、背景、光效、色调、细节位置一律维持原样，允许的改动仅限面部区域。',
  D2: '在保留原图构图、服装、光效骨架的前提下，允许对背景细节、道具摆放、布料褶皱作自然重绘；身份与整体氛围不变。',
  D3: '仅锁定身份（脸）、大体姿态与整体影调，其余背景、道具、细节允许重新组织；不追求逐像素还原，追求同一组拍摄条件下的另一张成片。',
}

/** 姿态三档（仅 A2/A3 可选，P185-187 原文）。 */
function poseLine(pose: PoseMode, poseText: string, keepSource: boolean): string {
  if (pose === 'C2') {
    return keepSource
      ? '姿态：整体姿态、身体重心、四肢角度与手部动作取自参考图 2；保留原图的机位高度与视线方向。'
      : '姿态：整体姿态、身体重心、四肢角度与手部动作取自参考图（即本图），保持原图机位高度与视线方向。'
  }
  if (pose === 'C3') {
    const text = poseText.trim() === '' ? '（用户未填写，按原图姿态）' : poseText.trim()
    return `姿态：${text}；身体重心、躯干朝向、双臂动作与视线按上述描述执行。与参考图冲突时以自填为准。`
  }
  return '姿态：姿态、重心与四肢角度完全按原图；仅身材取自参考图，不改变肢体关系。'
}

/** 组装换人 + 服装 + 姿态 + 重绘那一大块。 */
function personBlock(options: ReverseOptions): string {
  const person = options.person ?? 'none'
  const clothing = options.clothing ?? 'B1'
  const redraw = options.redraw ?? 'D2'
  const lock = options.lockStrength ?? 'medium'
  const keepSource = options.keepSource === true
  const age = typeof options.ageText === 'string' && options.ageText.trim() !== '' ? options.ageText.trim() : '成年'

  const lines: string[] = []

  // ---- 服装（三档独立于 A 组，P161）
  let clothingLine: string
  if (clothing === 'B2') {
    const visible = options.clothingVisible === true
    clothingLine = visible
      ? keepSource
        ? '服装：款式、面料、图案与配色取自参考图 2；保留原图的服装在画面中的占比、走向与光影关系（例如原图是短外套 + 高腰裤，新图也保持上下装的分段与腰线位置），仅替换具体款式。'
        : '服装：款式、面料、图案与配色取自参考图（即本图）；保持服装在画面中的占比、走向与光影关系，仅替换具体款式。'
      : '服装：用户未确认目标图中能看清服装，按 B1 口径处理——款式、领型、袖型、下摆长度、面料与图案完全按原图，不改颜色、不加配饰；允许因的身形而出现自然的合身度与褶皱差异。'
  } else if (clothing === 'B3') {
    const text = typeof options.clothingText === 'string' ? options.clothingText.trim() : ''
    clothingLine = text === ''
      ? '服装：用户选择自填但未提供内容——在 1.4 服装段留出明确占位并标注「需补充款式/颜色/面料/领型/下摆」。'
      : `服装：${text}（须含款式/颜色/面料/领型/下摆五项）；服装完整覆盖躯干与四肢，贴合但不紧绷，面料有真实的褶皱与垂坠感。与身材冲突时以合身度让步、款式不让步。`
  } else {
    clothingLine = '服装：款式、领型、袖型、下摆长度、面料与图案完全按原图，不改颜色、不加配饰；允许因参考图的身形出现自然的合身度与褶皱差异。'
  }

  if (person === 'none') {
    lines.push(
      '【本次不换人】不做身份替换：人物按原图描述，不写「取自参考图」这类归属句，也不要写锁脸句。',
    )
    lines.push(clothingLine)
    lines.push(`重绘强度（6 段要体现）：${REDRAW_TEXT[redraw]}`)
    return lines.join('\n')
  }

  // ---- A 组
  const tier = person
  lines.push(`【换人档位 · ${tier}】按下面口径重写 0–6 六段，其余段落保持原图内容。`)
  lines.push(
    tier === 'A1'
      ? '1 段重排为：1.1 身份 / 1.2 身形 / 1.3 站位与视线 / 1.4 服装 / 1.5 神情与道具；删掉 1.1 里全部五官描述，换成锁脸句。'
      : tier === 'A2'
        ? '1 段重排为：1.1 身份 / 1.2 身形 / 1.3 站位与视线 / 1.4 服装 / 1.5 神情与道具；1.1 删五官改锁脸句，1.2 身形改为取自参考图 1，**删掉三围/罩杯/腿长比例等具体数字**。'
        : '1 段重排为：1.1 身份 / 1.2 身形与姿态 / 1.3 站位与视线 / 1.4 服装 / 1.5 神情与道具；1.1 删五官改锁脸句，1.2/1.3 的姿态整体替换为取自参考图 1，删掉原姿态描述。',
  )
  lines.push(`1.1 段首句必须写（强度：${lock === 'short' ? '短' : lock === 'strong' ? '强' : '中'}）：${LOCK_SENTENCES[lock]}`)
  lines.push(`年龄口径：${age}；只写量级词，不写具体生日或年龄数字细节。`)
  lines.push(TAKE_LIST)
  lines.push(NOT_TAKE_LIST)

  if (tier === 'A2' || tier === 'A3') {
    lines.push(
      '6 段里删掉「不得偏离东亚面孔 / 眼过大 / 下巴过尖」这类**描述脸**的禁止项，改一句「不得改变参考图的面部结构」。',
    )
  }
  if (tier === 'A3') {
    lines.push(
      '3 段末必须追加：取景以「完整呈现参考图的姿态」为准：画幅比例、机位高度与景别保持原图，允许人物在画幅内小幅位移与取景范围微调，不得为了凑构图而改变姿态。',
    )
  }

  // ---- C 组（仅 A2/A3）
  if (tier === 'A2' || tier === 'A3') {
    lines.push(poseLine(options.pose ?? 'C1', options.poseText ?? '', keepSource))
  }

  lines.push(clothingLine)

  // ---- 6 段身份锁
  const constraints = tier === 'A1' ? A1_CONSTRAINTS : tier === 'A2' ? A2_CONSTRAINTS : A3_CONSTRAINTS
  lines.push('6 段必须追加（3–4 条身份锁 + 让步表）：')
  for (const line of constraints) lines.push(`· ${line}`)
  lines.push(`· ${PRIORITY}`)
  lines.push(`· 6.4 写一致性验收：${ACCEPTANCE}`)

  // ---- D 组
  lines.push(`重绘强度（6 段要体现）：${REDRAW_TEXT[redraw]}`)

  return lines.join('\n')
}

/* ============================================================ NSFW 分档

   摘自 `nsfw-tiers.md`。**只做单次改写**（R1 术语化 + 词表 + 兜底句）；
   多级重试链 R1–R5 要多次模型调用与预算控制，属于 v1.1（老板 R4=①）。 */

/** 词对照表（N48-130，21 组里取最常用的 15 组，其余按档位规则推导）。 */
const NSFW_WORDS: Record<'L1' | 'L2' | 'L3', string[]> = {
  L1: [
    '内衣/情趣内衣 → 蕾丝边吊带背心，叠合同色不透明内衬',
    '泳装/比基尼 → 连体泳衣，竞技剪裁',
    '透视网纱/半透明/透光 → 裸色缎面提花薄纱（只写织物质感与提花）',
    '深 V 到胸口上缘 → 深 U 型领口 + 领内同色不透明内衬',
    '大腿/长腿特写/沙漏腰 → 下摆至膝上 15cm 的短裙，腿部露出由剪裁自然形成；身形匀称修长、剪裁合体',
    '性感/很欲/撩人 → 高定短裙、布料贴合身形；唇部自然闭合、唇线清晰',
    '手抚胸口/手放大腿内侧 → 双臂上举、双手轻扣脑后',
  ],
  L2: [
    '裸体/全裸 → 艺术人体研究：以侧光塑形的肩背、腰腹与四肢结构，不写实暴露',
    '裸露上身 → 露背高定礼服，背部以单侧硬光塑形，前身布料完整覆盖',
    '胸沟/胸部特写 → 领口结构与胸线剪裁（领型、内衬、包边），不描述胸线以下',
    '臀部/翘臀特写 → 下摆与腰线的剪裁、背面廓形与外轮廓',
    '开叉到腰/高开叉 → 侧开叉至大腿中段，开叉内衬同色不透明，行走时自然摆动',
    '湿身/汗湿贴身 → 微湿发梢、缎面折光、衣物完整覆盖躯干',
    '绳索/束缚 → 编织腰带、缠绕式腰封（改材质与用途）',
  ],
  L3: [
    '明确性行为 → 双人形体构成：仅保留低照度侧光下的轮廓与构图关系，不描述任何具体动作',
    '生殖器特写 → 抽象解剖学线稿（骨骼、肌肉走向），不含实物写实',
    '液体/体液 → 删除，改「水汽/薄雾/雨痕」',
    '极端姿势（悬吊/倒置）→ 静态人体雕塑姿态（古典雕塑语汇：站、坐、倚、卧）',
    '双人深度纠缠 → 单人主体，另一人以布料或阴影暗示，不出现第二具身体',
    '特写多角度拼贴 → 单人正面半身，镜面反射只作构图元素',
  ],
}

/** 服装覆盖兜底句（N97 原文，L2/L3 必加）。 */
const COVER_CLAUSE =
  '服装完整覆盖躯干与四肢，贴合得体；画面保持商业时装广告的端庄尺度，无任何暴露内容；身体的呈现只通过剪裁、面料与光影完成。'

/** 组装 NSFW 段。 */
function nsfwBlock(tier: 'L1' | 'L2' | 'L3'): string {
  const lines: string[] = [`【NSFW 档位 · ${tier}】按下面口径改写，**不要**在结果里提及分档或改写过程。`]
  if (tier === 'L1') {
    lines.push('L1 三个动作：')
    lines.push('· 换场景定性：私拍/私房/酒店 → 摄影棚搭建场景 + 商业时装广告型录；语气从「描写一个人」改成「描述一件衣服和一次布光」。')
    lines.push('· 换服装措辞：保留款式轮廓，只留织物质感、不留透视关系。')
    lines.push('· 换动作与情绪：暗示动作改成明确可执行的非暗示动作；「欲 / 撩 / 撩人」整句删除，不做替换。')
  } else if (tier === 'L2') {
    lines.push('L2 必须**同时**做四件事（只改措辞无效，触发语义会在原文各处累加）：')
    lines.push('· 删：所有「身体部位 + 暴露程度」的句子一句不留（是删句，不是改词）。')
    lines.push('· 降语义密度：全文压缩 40–60%，从「描写一个人」转为「描述服装与布光」。')
    lines.push('· 换语言：身体描述 → 剪裁语言（领型、下摆、腰线、面料、覆盖范围）。')
    lines.push('· 换结构：裸露部位改为「布料完整覆盖 + 光影塑形」；动作改为替代动作。')
    lines.push('L2 的定位：保留风格/光效/构图/色调/场景骨架，**放弃**「身体裸露程度」这一项还原目标。')
    lines.push(`6 段必须写进这句兜底：${COVER_CLAUSE}`)
  } else {
    lines.push('L3 三个动作：')
    lines.push('· 拆骨架：只保留 0（改成商业用途）/2/3/5/6 段。')
    lines.push('· 重写主体：1 段整体重写为**非写实或半抽象人体构成**（雕塑 / 剪影 / 布料包裹 / 背影 / 局部肢体）。')
    lines.push('· 换框架：明写「古典雕塑 / 艺术人体研究 / 时装大片剪影」。')
    lines.push(`6 段必须写进这句兜底：${COVER_CLAUSE}`)
  }
  lines.push(`词对照（原文 → 改写，逐条套用；未列出的按同档规则推导）：`)
  for (const pair of NSFW_WORDS[tier]) lines.push(`· ${pair}`)
  return lines.join('\n')
}

/* ============================================================ 通用：锁定 / 卡片 / 额外要求 */

function locksBlock(locks: string[]): string {
  return `【锁定】以下维度必须原样保留，并在 6-约束条件里列为「必须保留」：${locks.join('、')}。`
}

function cardsBlock(cards: Array<{ name: string; why: string; fragment?: string }>): string {
  const lines = [
    '【创意方向】**只**改写 2-Style 与 5-Scene lighting 两段，不得碰 1 段与 6 段（否则会冲掉身份锁）：',
  ]
  for (const card of cards) lines.push(`· ${card.name}：${card.fragment ?? card.why}`)
  return lines.join('\n')
}

/* ============================================================ 对外

   组装顺序严格按 `person-replace-spec.md` §9：
   A/B/C/D → 卡片 → 额外要求 → NSFW → 方言。 */

export function instructionsOf(options: ReverseOptions): string {
  const blocks: string[] = [HARD_RULES, personBlock(options)]

  const locks = options.locks ?? []
  if (locks.length > 0) blocks.push(locksBlock(locks))

  const cards = options.cards ?? []
  if (cards.length > 0) blocks.push(cardsBlock(cards))

  if (typeof options.extra === 'string' && options.extra.trim() !== '') {
    blocks.push(`【额外要求】${options.extra.trim()}`)
  }

  // NSFW 在方言**之前**（先降档、再定文体）
  if (options.nsfw === 'L1' || options.nsfw === 'L2' || options.nsfw === 'L3') {
    blocks.push(nsfwBlock(options.nsfw))
  }

  blocks.push(dialectBlock(options.dialect ?? 'gpt'))

  return blocks.join('\n\n')
}

/* ============================================================ system 组装 */

/** 用户级技能目录：`$DSH_HOME/skills`（默认 `~/.dsh/skills`）。 */
function skillsRoot(): string {
  const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  return path.join(home, 'skills')
}

/** 读一段文本，读不到就返回空串（技能缺失不该让路由 500）。 */
async function readTextSafe(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/** 卡片库的一条。 */
interface CatalogCard {
  id: string
  name: string
  why: string
}

/** 卡片库的一组。 */
interface CatalogGroup {
  type: string
  label: string
  cards: CatalogCard[]
}

/**
 * 读卡片库，压成「组 → id/名字/理由」的紧凑文本。
 *
 * 为什么要塞进 system：模型要**自己挑**推荐卡片（预勾选），不告诉它有哪些卡，
 * 它只会编 id。60 张卡压缩后约 4 KB，对一次调用可以接受。
 */
async function catalogText(): Promise<string> {
  const raw = await readTextSafe(path.join(pluginRoot(), 'data', 'suggestion-cards.json'))
  if (raw === '') return ''
  let groups: CatalogGroup[]
  try {
    groups = JSON.parse(raw) as CatalogGroup[]
  } catch {
    return ''
  }
  if (!Array.isArray(groups)) return ''
  const lines: string[] = ['【可用卡片库】（挑推荐的时只能从下面这些 id 里选）']
  for (const group of groups) {
    if (!Array.isArray(group.cards) || group.cards.length === 0) continue
    lines.push(`· ${group.label}（${group.type}）`)
    for (const card of group.cards) {
      lines.push(`  - ${card.id}：${card.name} —— ${card.why}`)
    }
  }
  return lines.join('\n')
}

/**
 * 组 system：技能正文 + 输出模板 + 分类学 + 卡片库 + 本次口径 + 输出格式。
 *
 * 技能是**用户级**的（`~/.dsh/skills/image-prompt-reverse/`），不是插件自带的 ——
 * 老板改技能，反推质量跟着变，这是刻意设计。
 *
 * 两处顺序是有讲究的：
 *   · **输出格式放最后** —— 实测模型对「最近的一条指令」遵守率最高；2026-11-07
 *     上午第 v1 版把 META 协议放在中间，被模型整块忽略。
 *   · **口径在格式之前** —— 口径是「写什么」，格式是「怎么排版」，后者收尾。
 */
export async function buildSystem(options: ReverseOptions): Promise<string> {
  const root = path.join(skillsRoot(), 'image-prompt-reverse')
  const skill = await readTextSafe(path.join(root, 'SKILL.md'))
  const template = await readTextSafe(path.join(root, 'references', 'prompt-template.md'))
  const taxonomy = await readTextSafe(path.join(root, 'references', 'image-type-taxonomy.md'))

  const parts: string[] = []
  if (skill !== '') parts.push(skill)
  if (template !== '') parts.push('---\n\n' + template)
  if (taxonomy !== '') parts.push('---\n\n' + taxonomy)

  const catalog = await catalogText()
  if (catalog !== '') parts.push('---\n\n' + catalog)

  parts.push(
    '---\n\n【本次任务】上面的技能与模板是背景。现在请按下面的口径与输出格式产出结果：全中文，不要输出解释、判定过程或 Markdown 代码块围栏。',
  )
  parts.push('【本次口径】\n' + instructionsOf(options))
  parts.push('---\n\n' + protocolInstruction(options.dialect ?? 'gpt'))
  return parts.join('\n\n')
}

/** 技能是否就位（界面用它提示「技能缺失，反推效果会退化」）。 */
export async function skillReady(): Promise<boolean> {
  const file = path.join(skillsRoot(), 'image-prompt-reverse', 'SKILL.md')
  return (await readTextSafe(file)) !== ''
}
