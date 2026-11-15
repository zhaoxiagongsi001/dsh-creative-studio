# 图像创作（dsh-creative-studio）

> 把原来的「生图」和「图反推」两个插件合并成**一个面板**：左边放素材，右边出产物，
> 图 → 词 → 图 一条链走完，不再跨插件跳转。
>
> 版本 0.1.1 · 自用 · 2026-11-15

---

## 0. 快速开始（第一次用先看这 15 行）

1. **配生图 Key**：面板右上角「连接配置」→ 填 OpenRouter API Key（只存宿主机，不进浏览器）。
2. **确认聊天模型**：反推要用 DSH 当前的聊天模型，参数带顶部会显示是哪个；没选就先去「设置 → 模型」选一个。
3. **图 → 词**：把参考图拖进左栏（或 Ctrl+V / 点击选择）→ 点「反推」。
4. **词 → 图**：点「用这段去生图 →」自动切过去 → 点「生成」。

**三条预期，别当成故障：**

| 现象 | 说明 |
|---|---|
| 反推要等 **60–133 秒** | 走的是**聊天模型**读图，不是生图模型；慢是正常的，有骨架屏和取消按钮 |
| 反推用的是你的**聊天模型** | 参数带顶部蓝色 chip 显示当前是哪个；在 DSH 里换了模型，回来点一下 chip 即可刷新 |
| 见过「本地推断」字样 | 模型没按格式给图片类型时，插件按正文关键词本地推断。不影响正文 |
| 生图中切到别的会话 | **不会中断**：请求在面板之外执行，回来照旧显示进度 / 结果 / 报错。刷新或关页面才可能丢请求，那时显示「上次生成被中断」，不会静默消失 |

**想找文件**：图片和历史在 `~/.dsh/dsh-imagegen-panel/`（`out/` 是图，`index.json` 是索引，`logs/` 是日志）。
名字还叫 imagegen 是刻意的 —— 合并时决定沿用原目录，115 张历史图零迁移。

**如果反推按钮是灰的**：顶部 chip 显示「⚠ 未检测到聊天模型」，说明 DSH 当前没有可用的聊天模型，
先去「设置 → 模型」选一个。插件不会偷偷换用别的模型。

---

## 1. 它是什么

| 模式 | 左栏 | 右栏 |
|---|---|---|
| **图 → 词** | 参考图（拖入 / Ctrl+V / 点击）+ 判定行 + 「反推」按钮 | 反推参数带（6 行横排）+ 六段结构化提示词 |
| **词 → 图** | 参考图（拖入 / Ctrl+V / 点击）+ 提示词 + 生图参数 + 「生成」 | 大图预览 + 结果条 + 历史条 |

点「用这段去生图」把反推结果交给生图模式 —— 数据写进草稿、面板重挂读取，**不再有跨插件 HTTP**。

---

## 2. 工程结构

```
src/
  index.ts                 宿主装配：16 条路由
  http.ts                  loopback 校验 / body 上限 / JSON 应答
  plugin-root.ts           插件根目录解析（打包器同作用域，单列一份）
  config-store.ts          生图配置（7 字段 + 明文 Key，只在宿主）
  draft-store.ts           面板草稿
  image-store.ts           历史索引（200 条上限）+ 图片落盘
  log-store.ts             日志（内存缓冲 + 按日落盘 + 脱敏）
  open-file.ts             用系统默认程序打开原图
  providers.ts             四协议 plan / parse
  openrouter.ts            OpenRouter 能力表与字段裁剪
  forge.ts                 prompt-forge 模板读取
  reverse/
    generate.ts            反推主流程（LLM + 附件 + 超时/取消）
    rules.ts                三份设计规范 → system prompt（纯函数）
    protocol.ts             输出协议解析（两行元信息 + 六段正文）
    infer.ts                本地推断兜底（类型 / 推荐卡片）
  client/
    index.tsx               槽位注册（一个侧栏行 + 一个主区面板）
    StudioPanel.tsx         外壳：模式切换 + 两模式容器
    ReversePane.tsx         图→词工作区
    ImageGenPanel.tsx       生图面板（从旧插件原样搬入）
    Composer / ResultStage / ConfigModal / LogViewer / ...
    api.ts / types.ts / labels.ts / defaults.ts / optimize.ts / art.tsx
    *.module.css            三套 CSS Module（真实 design token）
data/suggestion-cards.json  60 张建议卡片（6 组）
docs/                       三份设计规范（方言 / NSFW / 换人）
locale/                     zh / en
scripts/                    构建 + 5 套自检 + 预览 + 实测
```

---

## 3. 宿主路由（前缀 `/dsh-creative/*`）

| 路由 | 方法 | 用途 |
|---|---|---|
| `/health` | GET | 自检：数据目录 / hasKey / 历史数 / 草稿状态 |
| `/config` | GET/PUT | 配置（**明文 Key 永不回传**，只回掩码） |
| `/models` | GET | 上游生图模型目录 |
| `/capabilities` | GET | 单模型权威能力与定价 |
| `/generate` | POST | 生图（32 MB body，支持取消 / 超时） |
| `/history` | GET | 历史索引（最新在前，上限 200） |
| `/save` / `/open` | POST | 另存 / 系统程序打开原图 |
| `/preset` | GET | prompt-forge 优化模板 |
| `/logs` | GET/DELETE | 宿主日志 |
| `/draft` | GET/PUT | 面板草稿 |
| `/import` | POST | 两模式交接（提示词 + 参考图 → 草稿） |
| `/image/<id>` | GET | prefix 路由，喂历史图字节 |
| `/reverse` | POST | 反推主流程 |
| `/active-model` | GET | 当前聊天模型（反推前显示、拿不到就禁用反推） |
| `/cards` | GET | 建议卡片库 |

安全：所有路由都走 `isLoopbackRequest`（对端地址 + Host + Origin 三判据），非本机同源 403。

---

## 4. 数据目录（沿用旧插件，零迁移）

```
~/.dsh/dsh-imagegen-panel/
  config.json    生图配置
  index.json     115 张历史图索引
  out/           图片原文件
  draft.json     面板草稿
  logs/          宿主日志
```

Q5 拍板沿用原目录，所以合并后**老板已有的历史图、配置、草稿全部照常可读**。

反推的 system prompt 依赖**用户级技能** `~/.dsh/skills/image-prompt-reverse/`（SKILL.md + 两份 references），改技能会改变反推质量，这是刻意设计。

---

## 5. 构建与自检

```powershell
cd D:\DSH\dsh-creative-studio
node scripts\build.mjs            # 产出 lib/index.js + lib/client.js
npm run check                     # 全套：232 项（数字以脚本输出为准）
```

| 脚本 | 项数 | 验什么 |
|---|---|---|
| `host-check.mjs` | 31 | 三处 id 一致、导出契约、路由 vs 客户端字面一致、资产就位 |
| `rules-check.mjs` | 70 | 三份规范的必写句逐条字面断言 + 拼装顺序 |
| `host-smoke.mjs` | 69 | 真起 HTTP 服务打 16 条路由 + 协议解析 + 本地推断 |
| `render-check.mjs` | 62 | 真实 React 渲染 + 槽位注册参数 + 控件与纯函数 |
| `verify-reverse-live.mjs` | 11 | **真机**：打真实 DSH 的 `/reverse`，验类型 / 卡片 / 正文 |

另有 `preview.mjs`（离线出预览页）、`probe-complexity.mjs`（参数实测）。

---

## 6. 反推输出协议

模型被要求按下面形状输出（**两行纯文本**，比 JSON 块遵守率高）：

```
类型：人像 · 写真
卡片：portrait-warm-film, portrait-blue-hour

# 0 - 任务目标（Task Objective）
…
# 6 - 约束条件（Hard Constraints）
…
```

- 模型守格式 → 用模型判定的类型与推荐卡片
- 模型没守 → `infer.ts` 本地推断兜底，界面在悬停提示里标明来源
- 解析只认行首 `类型：`/`卡片：`，认不出就当没写，**正文一行不丢**
- 单版输出（老板 2026-11-07 决定下线三版），按 GPT Image 2.6 写法

---

## 7. 三份设计规范

| 文档 | 落地内容 |
|---|---|
| `model-dialects.md` | 三档方言（GPT 1500-3000 / Gemini 300-800 / Qwen 800-1500）+ 5 条硬规则 |
| `nsfw-tiers.md` | L1/L2/L3 动作清单 + 21 组词对照 + L2 四动作 + 服装覆盖兜底句 |
| `person-replace-spec.md` | 换人 A1-A3 / 服装 B1-B3 / 姿态 C1-C3 / 重绘 D1-D3 + 身份锁与让步表 |

拼装顺序（承重，`rules-check` 断言）：
```
硬规则 → 换人 A/B/C/D → 锁定 → 创意卡片 → 额外要求 → NSFW → 方言
```

---

## 8. 已知限制（v1.1 候选）

| 项 | 状态 |
|---|---|
| R1–R5 失败降级链（多次调用 + ≤8 次预算） | 后置 |
| S1–S5 拒看兜底（图像预处理） | 后置 |
| NSFW 自动档位判定 | 后置 |
| 反推历史 / 多版本持久化 | 后置 |
| 生图请求跨进程恢复 | **做不到**：刷新/关窗打断的是这次 HTTP，只能还原成「上次生成被中断」；不重发请求以免重复计费 |
| ✨ AI 自由建议（额外一次模型调用） | 后置 |
| GPT Image 2.6 的 `complexity` 透传参数 | 实测有效但语义未知，**未接入** |

`complexity` 实测结论：三档都接受，输出尺寸与费用完全相同，只影响图片内容字节数（约 3%）；是内容复杂度的软调节，不是分辨率/质量档。

---

## 9. 回滚

见 `D:/DSH/creative-merge/ROLLBACK.md`。**旧插件目录全程没删**，只从 profile 摘掉引用。
