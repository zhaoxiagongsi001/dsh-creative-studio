/**
 * 计费口径判定（纯函数，无 DOM / 宿主依赖）。
 *
 * 面板在错误卡片上要写一句账单承诺：要么「本次未计费」，要么「上游可能已计费，
 * 以账单为准」。写错方向都很难看 —— 说未计费而实际扣了钱，用户会去查账；
 * 该说未计费却吓唬人，用户会不敢重试。所以把判定做成一张显式表，并在离线自检里
 * 钉死（`scripts/persist-check.mjs`）。
 *
 * 方向选择：**默认「可能已计费」，只有明确的前置校验失败才敢承诺未计费。**
 * 宿主将来新增一个失败 code 时，最坏结果只是多说一句「以账单为准」，
 * 而不是对着已经扣钱的一次请求宣称「本次未计费」。
 */

/**
 * 确定没发到上游的 code（前置校验 / 鉴权）。
 *
 * - `bad-model` / `bad-prompt` / `bad-id`：参数不合法，请求根本没组装出去。
 * - `capabilities-unsupported`：模型不支持该参数组合，发之前就拦下。
 * - `no-key` / `forbidden`：没配置或 key 无效，上游连不上。
 */
const KNOWN_UNBILLED_CODES = new Set([
  'bad-model',
  'bad-prompt',
  'bad-id',
  'capabilities-unsupported',
  'no-key',
  'forbidden',
])

/**
 * 某个宿主 code 对应的计费口径。
 *
 * @param code - 宿主返回的机器可读 code（无 code 时传 `'unknown'`）。
 * @returns `undefined` = 确定未计费；`'unknown'` = 请求可能已到上游并计费。
 */
export function billingOfCode(code: string): 'unknown' | undefined {
  return KNOWN_UNBILLED_CODES.has(code) ? undefined : 'unknown'
}
