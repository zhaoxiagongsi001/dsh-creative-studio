/**
 * 本地推断层：模型没按协议给元信息时，用**纯本地规则**补出「图片类型」与「推荐卡片」。
 *
 * 为什么需要它：实测（2026-11-07）默认模型 `qwen3.8-max` 会把 system 里的 MET​A 块
 * **整块忽略**，只输出六段正文。没有兜底的话，判定行永远显示目标方言、建议卡片
 * 永远不勾 —— 界面看起来像坏了，其实是模型没守约定。
 *
 * 设计原则：
 *   · **只做加分，不做判断**。推断结果一定带 `source: 'inferred'`，界面会标明「本地推断」，
 *     不冒充模型判定。
 *   · 全部是纯函数（不读盘、不联网），可以离线断言。
 *   · 宁可少给，不要瞎给：分数不够就返回空数组。
 */

/** 推断来源：模型给的，还是本地算的。 */
export type MetaSource = 'model' | 'inferred' | 'none'

/** 类型词表：每一类给一组高区分度关键词。 */
const TYPE_KEYWORDS: Array<{ type: string; keys: string[] }> = [
  { type: '人像 · 写真', keys: ['人像', '人物', '女性', '男性', '少女', '肖像', '面部', '五官', '妆容', '肤色', '发丝', '半身', '全身照', '写真', '模特', '侧脸', '眼神'] },
  { type: '产品 · 静物', keys: ['产品', '商品', '包装', '瓶身', '罐', '礼盒', '电商', '静物', '陈列', '材质光泽', '卖点', '白底', '特写质感'] },
  { type: '海报 · 平面', keys: ['海报', '排版', '版式', '标题字', '文案', '宣传', '广告', '活动主视觉', 'banner', 'KV'] },
  { type: '风景 · 建筑', keys: ['风景', '山脉', '远山', '天空', '云层', '海岸', '森林', '日出', '日落', '地平线', '建筑', '室内空间', '墙面', '地板', '街景'] },
  { type: '插画 · 动漫', keys: ['插画', '手绘', '线稿', '扁平', '矢量', '笔触', '水彩', '漫画', '赛璐璐', '厚涂'] },
  { type: '美食 · 饮品', keys: ['美食', '食物', '料理', '菜品', '餐', '饮品', '咖啡', '食材', '甜点', '摆盘'] },
  { type: '宠物 · 动物', keys: ['宠物', '猫', '狗', '动物', '毛发'] },
]

/**
 * 从正文推断图片类型。
 * @param text - 六段正文（或任意一段）。
 * @returns 类型字符串；分数不够就返回空串（界面就不显示类型）。
 */
export function inferType(text: string): string {
  if (typeof text !== 'string' || text.trim() === '') return ''
  let best = { type: '', score: 0 }
  for (const candidate of TYPE_KEYWORDS) {
    let score = 0
    for (const key of candidate.keys) {
      // 长词权重更高：'面部' 比 '餐' 更能说明问题
      const weight = key.length >= 2 ? 2 : 1
      let from = 0
      let hit = 0
      for (;;) {
        const at = text.indexOf(key, from)
        if (at < 0) break
        hit += 1
        from = at + key.length
        if (hit >= 4) break // 同一个词出现 4 次以上不再加权，避免长文里高频词刷分
      }
      score += hit * weight
    }
    if (score > best.score) best = { type: candidate.type, score }
  }
  // 至少命中两个强词（或等价的分数）才认，避免「一张图里有个猫」被判成宠物
  return best.score >= 4 ? best.type : ''
}

/** 卡片（只取匹配要用的字段）。 */
export interface MatchableCard {
  id: string
  name: string
  why: string
  promptFragment?: string
  /** 所属分组类型（portrait / product / …），组匹配时给加分。 */
  group?: string
}

/** 分组类型 ↔ 推断类型的对应关系。 */
const GROUP_OF_TYPE: Array<{ prefix: string; group: string }> = [
  { prefix: '人像', group: 'portrait' },
  { prefix: '产品', group: 'product' },
  { prefix: '海报', group: 'poster' },
  { prefix: '风景', group: 'landscape' },
  { prefix: '插画', group: 'illustration' },
]

/**
 * 按正文关键词匹配推荐卡片。
 *
 * 打分规则（简单但可解释）：
 *   · 卡片名命中正文 → +6（名字是这张卡的代表词，命中最有说服力）
 *   · 卡片 fragment 里的词命中正文 → 每个 +1（最多算 6 个）
 *   · 卡片所在分组与推断类型一致 → +3
 *   · 总分 ≤ 0 的丢弃；最多返回 4 张。
 *
 * @param text - 六段正文。
 * @param cards - 卡片库（扁平数组）。
 * @param inferredType - `inferType()` 的结果，用于加分。
 * @returns 推荐卡片 id（按分数降序）。
 */
export function matchCards(text: string, cards: MatchableCard[], inferredType = ''): string[] {
  if (typeof text !== 'string' || text.trim() === '' || cards.length === 0) return []
  const scored: Array<{ id: string; score: number }> = []

  for (const card of cards) {
    let score = 0
    if (card.name !== '' && text.includes(card.name)) score += 6

    const fragment = card.promptFragment ?? ''
    if (fragment !== '') {
      // 从 fragment 里取 2–4 字的中文片段当特征词，看正文里有没有
      const tokens = fragment.split(/[，、；：。\s（）()]+/).filter((token) => token.length >= 2 && token.length <= 6)
      let hits = 0
      for (const token of tokens) {
        if (hits >= 6) break
        if (text.includes(token)) hits += 1
      }
      score += hits
    }

    if (inferredType !== '' && card.group !== undefined) {
      const mapped = GROUP_OF_TYPE.find((item) => inferredType.startsWith(item.prefix))
      if (mapped !== undefined && mapped.group === card.group) score += 3
    }

    if (score > 0) scored.push({ id: card.id, score })
  }

  return scored
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map((item) => item.id)
}
