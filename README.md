# dsh-plugin-design-forge

**DeepSeek Harness 设计库插件** — 抓取优秀网站的真实设计，沉淀为本地设计库，并在你做网站 / 应用界面 / 文档排版时自动套用。

English summary below.

## 它做什么

| 能力 | 说明 |
|---|---|
| `design_capture` | 抓取一个网站（走 Harness 的 `ctx.web` 通道，自动继承你配置的 fetch provider —— 包括 SOCKS 代理路由），解析页面内联样式 + 全部可达样式表（含一级 `@import`），蒸馏出：调色板（含使用频次与明暗分类）、字体族与完整 font stack、字号阶梯、字重、行高、字距、间距节奏、圆角、阴影、渐变、动效时长与缓动、断点、容器宽度、`@font-face`，以及站点自己的 CSS 自定义属性 token（自动区分 light / dark 主题）。结果存为一个 JSON 条目 + 一份可直接粘贴的 `tokens.css`。 |
| `design_library` | 管理设计库：`list`（总览每条设计的调色板/字体/阶梯）、`search`（按 id/名称/颜色/字体检索）、`get`（完整分析）、`export`（`tokens` = tokens.css、`spec` = Markdown 设计规范、`json` = 原始条目）、`delete`。 |
| `design_discover` | **一次调用完成「搜索 → 筛选 → 批量收录」**：按 query 走 Harness 的搜索通道，过滤掉平台/聚合站（YouTube、GitHub、Dribbble、知乎…）、文档与子页面、图片与 PDF 等资源、以及同一域名的重复项，优先落地页（首页与浅层路径），然后逐个抓取入库，返回每个站点的调色板/字体/字阶/圆角/token 数量摘要。用 `urls` 可跳过搜索直接批量收录已知站点。 |
| 系统提示注入 | 一个 guidance section 教会每个 Agent：**做网站、应用界面、仪表盘、邮件、海报、幻灯片、文档排版之前，先查设计库**，命中则复用该设计的 token 作为设计系统（并注明来源）；库为空、或没有匹配目标气质的条目时，主动 `design_discover` 去搜集参考站；用户分享/称赞某网站时，主动建议或直接 `design_capture` 收录。 |

这就是"自动用上"的实现方式：不是替换你的指令，而是让每一次 UI/排版任务开始前，Agent 都知道本地有一套可复用的真实设计系统；不够用时，它还会自己去网上找参考并沉淀下来。

### 三个工具怎么配合

```
design_discover { query: "dark developer tool landing page", limit: 3 }   # 库里没有匹配风格 → 主动找参考并收录
design_library  { action: "list" }                                       # 看看现在有什么
design_library  { action: "export", id: "cursor", format: "tokens" }     # 取出可直接粘贴的 CSS 变量
design_capture  { url: "https://example.com", notes: "喜欢它的留白与字重" }  # 收录你指定的站点
```

抓取结果只包含设计语言（token），**不会**复制 Logo、图片或正文；`design_discover` 的候选过滤遵循同一原则 —— 只挑能用 CSS 表达的设计。

## 存储位置

默认 `~/.dsh/storages/design-forge/`：

```
index.json          # 总览索引（由 entries/ 扫描重建，可随时删除）
entries/<id>.json   # 每条设计的完整分析 + tokensCss
```

`id` 由站点名/域名生成（`acme`、`acme-2` …）；`refresh: true` 可覆盖重抓。

## 配置（cordis.patch.yml 的 design-forge 行）

| 字段 | 默认 | 说明 |
|---|---|---|
| `storeDir` | `~/.dsh/storages/design-forge` | 设计库目录 |
| `maxStylesheets` | 24 | 每页优先抓取的样式表数（按 URL 关键词 + 同源评分排序） |
| `hardMaxSheets` | 40 | 绝对上限：若前一批仍缺核心 token（调色板/字体），继续补抓直至该上限 |
| `maxImportsPerSheet` | 4 | 每张样式表跟进的一级 `@import` 数 |
| `maxStylesheetBytes` | 600000 | 单张样式表字节上限 |
| `maxTotalCssBytes` | 2500000 | 单次抓取 CSS 总量上限 |
| `fetchConcurrency` | 4 | 样式表并发抓取数 |
| `maxTokenProps` | 80 | 每个主题保留的 CSS 自定义属性上限（核心 token 优先于组件级 token） |
| `promptSection` | true | 是否注入系统提示 guidance section |

## 安装 / 启用 / 移除

从 Git 克隆（推荐）：

```powershell
git clone https://github.com/nekofinley/dsh-plugin-design-forge.git
cd dsh-plugin-design-forge
pnpm install --store-dir .\.pnpm-store   # pnpm ≥9；依赖仅 schemastery/cosmokit（hoisted）
```

然后把克隆目录接入 DSH profile（`~/.dsh/profiles/desktop`），任选其一：

- 用 `plugin_manager` 工具：`install_bundle`，target 传克隆目录的绝对路径；
- 手动：profile 的 `package.json` 中 `dsh.profile.bundles` 加入 `"dsh-plugin-design-forge"`，并以 `link:<克隆目录>` 作为该包的来源，再在 `cordis.patch.yml` 的 `insert` 列表加入 `[{ id: design-forge, name: dsh-plugin-design-forge, config: { promptSection: true } }]`。

已装好的管理：

- 停用：`plugin_manager` `set_bundle`（禁用后 provider、工具与提示注入全部撤销）。
- 移除：`plugin_manager` `remove_bundle`。

## 已知边界

- 只能看到**静态 CSS**：hover 才出现的样式、canvas / JS 注入的样式、需要登录的页面内容不在抓取范围内。
- 单张样式表超过上限时按前缀分析并在 `stats.truncatedSheets` 标注。
- 图片、Logo、正文内容不会被复制 —— 设计库复用的是设计语言（token），不是素材。

---

## English summary

A DSH bundle that captures the *real* design of excellent websites into a persistent local library and makes agents apply it automatically.

- **`design_capture`** — fetches a URL through the harness `ctx.web` seam (so the configured fetch provider, including the SOCKS proxy router, applies), parses inline styles plus every reachable stylesheet (first-level `@import` included), and distills: frequency-ranked palette (with luminance classes), font families with full stacks, type scale, weights, line heights, letter spacing, spacing rhythm, radii, shadows, gradients, motion durations/easings, media breakpoints, container widths, `@font-face` declarations, and the site's own CSS custom properties (light/dark separated by `[data-theme="dark"]`-style selectors and `prefers-color-scheme`). Stores one JSON entry plus a ready-to-paste `tokens.css`.
- **`design_library`** — `list` / `search` / `get` / `delete` / `export` (`tokens` CSS variables, `spec` Markdown design document, `json` raw).
- **`design_discover`** — one call does search → filter → batch capture: runs a web search through the harness search provider, drops platforms/aggregators, docs, assets, listing pages and duplicate hosts, prefers landing pages, captures every remaining site into the library, and returns a per-site digest (palette, fonts, type scale, radii, token counts). Pass `urls` to skip search and batch-capture known sites.
- **System-prompt section** (order 2155) — instructs every agent to check the library *before* building websites, app UIs, dashboards, emails, posters, decks, or document typography, to reuse the closest captured design's tokens, to capture sites the user praises, and to run `design_discover` when the library holds nothing close to the target.

Storage: `~/.dsh/storages/design-forge/` (`index.json` + `entries/*.json`, index rebuilt from files on demand). Zero runtime dependencies beyond `@deepseek-ai/schemastery` (Config schema); all analysis is a dependency-free brace/paren-aware CSS walker. Static CSS only — hover-only, canvas, and JS-injected styles are out of scope.
