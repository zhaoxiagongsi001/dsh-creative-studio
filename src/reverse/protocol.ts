/**
 * 反推输出协议：把模型那一坨文本切成「元信息 + 正文」。
 *
 * ## 演进史（重要，别退回去）
 *
 * v1（2026-11-07 上午）用的是一个 JSON 块 + 三版分隔标记：
 *
 * ```
 * <<META>>{"type":"…","cards":["…"]}<</META>>
 * ===VERSION:还原版===
 * ```
 *
 * **实测失败**：默认模型 `qwen3.8-max` 把 JSON 块和三版标记**整块忽略**，
 * 直接输出六段正文 —— 结果就是「类型没判定、卡片没推荐、三版只剩一版」。
 * 教训：**模型对 JSON 块 + 自定义分隔符的遵守率很低**，尤其当 system 里
 * 还塞了技能正文、模板、分类学、60 张卡片目录之后。
 *
 * v2（当前）改成**两行普通中文短行**放在最前面：
 *
 * ```
 * 类型：人像 · 写真
 * 卡片：portrait-warm-film, portrait-blue-hour
 *
 * # 0 - 任务目标
 * …
 * ```
 *
 * 三条理由：
 *   1. 纯文本两行，不需要闭合标记，模型漏写一半也不会污染正文；
 *   2. 解析只认「行首是 类型/卡片 + 冒号」，识别不出来就当没写，正文从第一行
 *      不是元信息的行开始算，**永远不会吃掉正文**；
 *   3. 即便模型完全不理，还有 `infer.ts` 的本地推断兜底（界面会标「本地推断」）。
 *
 * 三版输出已按老板 2026-11-07 反馈**下线**：只要一版，且按 GPT Image 2.6 的
 * 写法（长句、自然语言、不要符号堆叠）。
 */

/** 解析后的结构。 */
export interface ParsedReverse {
  /** 正文（六段）。 */
  text: string
  /** 模型给的图片类型；没给就是空串。 */
  type: string
  /** 模型推荐的卡片 id（可能为空）。 */
  cards: string[]
  /** 解析过程中的降级说明（给日志用，不显示给用户）。 */
  warnings: string[]
}

/** 元信息行的识别规则：`类型：xxx` / `卡片：a, b`，也容忍 `Type:` / `Cards:`。 */
const TYPE_LINE = /^\s*(?:类型|图片类型|type)\s*[:：]\s*(.+)$/i
const CARDS_LINE = /^\s*(?:卡片|推荐卡片|建议卡片|cards?)\s*[:：]\s*(.+)$/i

/** 一行是否像元信息（用于判断正文从哪儿开始）。 */
function isMetaLine(line: string): boolean {
  return TYPE_LINE.test(line) || CARDS_LINE.test(line)
}

/**
 * 解析模型输出。
 * @param raw - 模型返回的原始文本。
 * @returns 正文 + 元信息（失败的项为空）。
 */
export function parseReverseOutput(raw: string): ParsedReverse {
  const warnings: string[] = []
  const text = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n') : ''
  if (text.trim() === '') {
    return { text: '', type: '', cards: [], warnings: ['模型没有返回内容'] }
  }

  let type = ''
  const cards: string[] = []
  const lines = text.split('\n')

  // 只看前 6 行找元信息：模型如果把元信息写在正文后面，那就是没遵守，
  // 不去它肚子里翻（翻了容易把正文里的「卡片」两个字误当元信息）。
  let bodyStart = 0
  for (let index = 0; index < lines.length && index < 6; index += 1) {
    const line = lines[index]
    const typeMatch = TYPE_LINE.exec(line)
    if (typeMatch !== null) {
      type = typeMatch[1].trim().replace(/[*`]/g, '')
      bodyStart = index + 1
      continue
    }
    const cardsMatch = CARDS_LINE.exec(line)
    if (cardsMatch !== null) {
      const value = cardsMatch[1].trim().replace(/[*`]/g, '')
      // 支持中英文逗号、顿号、空格分隔
      for (const part of value.split(/[,，、;；\s]+/)) {
        const id = part.trim()
        if (id !== '' && id !== '无' && id !== 'null' && !cards.includes(id)) cards.push(id)
      }
      bodyStart = index + 1
      continue
    }
    // 空行可以跳过（元信息与正文之间通常有空行）
    if (line.trim() === '' && bodyStart === index) {
      bodyStart = index + 1
      continue
    }
    // 遇到第一个既不是元信息也不是空行的行 → 正文从这里开始
    break
  }

  const body = lines.slice(bodyStart).join('\n').trim()

  if (type === '' && cards.length === 0) {
    warnings.push('模型没有输出元信息行（类型/卡片），将由本地推断补齐')
  }
  if (body === '') {
    // 极端情况：整段都被当成了元信息
    warnings.push('正文为空，整段按正文处理')
    return { text: text.trim(), type, cards, warnings }
  }

  // 兜底：模型把元信息写在正文里（罕见），把整段也交回去让界面能显示内容
  if (body.length < 20 && text.length > body.length * 3) {
    warnings.push('正文疑似被裁掉，回退为整段文本')
    return { text: text.trim(), type, cards, warnings }
  }

  return { text: body, type, cards, warnings }
}

/**
 * 生成要求模型遵守协议的那段指令。
 *
 * 措辞刻意**短且硬**：实测模型对长指令里的细节遵守率明显下降，
 * 所以这里只保留三件事（元信息两行、六个标题、GPT 2.6 的句式要求）。
 */
export function protocolInstruction(dialect: string = 'gpt'): string {
  // 第 4 条只对 GPT 档成立：Gemini / Qwen 各有自己的句式与长度规则（见方言段）。
  const targetLine = dialect === 'gemini'
    ? '4. 目标模型是 Gemini（nano-banana）：短句 + 强指令，一句一个约束，300–800 字。'
    : dialect === 'qwen'
      ? '4. 目标模型是 Qwen Image：中文分条，每条以「必须/禁止/优先」开头，800–1500 字。'
      : '4. 目标模型是 GPT Image 2.6（gpt-image-2.6-flare）：它擅长「可数项」（姿势、道具、光效、纹样、材质），不擅长精确数值——所以写「三色：米白/暖灰/近黑」，不要写十六进制色值；写「大面积留白」，不要写百分比。'
  return [
    '【输出格式】你的回复必须是下面这个形状，第一行就叫「类型」，第二行就叫「卡片」：',
    '',
    '类型：<大类 · 细类>',
    '卡片：<从卡片库里挑 2-4 个 id，逗号分隔；没有合适的就写「无」>',
    '',
    '# 0 - 任务目标（Task Objective）',
    '…',
    '# 1 - 主体 / 核心视觉元素（Subject）',
    '…',
    '# 2 - 风格（Style）',
    '…',
    '# 3 - 镜头与构图（Shot）',
    '…',
    '# 4 - 场景元素与环境（Setting）',
    '…',
    '# 5 - 场景光照与影调（Scene Lighting）',
    '…',
    '# 6 - 约束条件（Hard Constraints）',
    '…',
    '',
    '硬要求：',
    '1. 前两行之后必须空一行再开始 `# 0`；标题保留英文括注。',
    '2. 正文里不要再出现「类型：」「卡片：」这两行，也不要写任何前言、结语或自我说明。',
    '3. 整段正文用**自然语言长句**写，不要把句子拆成短语标签，不要用表格、箭头、项目符号串。',
    '4. 目标模型是 GPT Image 2.6（`gpt-image-2.6-flare`）：它擅长「可数项」（姿势、道具、光效、纹样、材质），',
    '   不擅长精确数值——所以写「三色：米白/暖灰/近黑」，不要写十六进制色值；写「大面积留白」，不要写百分比。',
  ].join('\n')
}
