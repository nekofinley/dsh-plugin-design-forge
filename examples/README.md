# 示例页面 / Examples

这三个页面只用来展示 `design_library` 的 token 怎么落到真实排版上。它们的**设计语言**来自插件捕获的站点，
文案、图形、示例代码全部原创 —— 没有复制任何 Logo、图片或正文。

| 文件 | 类型 | 设计系统来源 | 说明 |
|---|---|---|---|
| `panel-linear.html` | 小组件面板 | `linear` | 最小示例：一张卡片 + 深浅主题切换 |
| `landing-linear.html` | 营销落地页 | `linear` | 吸顶导航 / Hero / 功能网格 / 控制台示意 / 三档定价 |
| `console-cursor.html` | 应用界面 | `cursor` | 智能体控制台：图标栏 + 任务侧栏 + 指标卡 + 代码 diff + 日志 + 状态栏 |

复现这两个设计系统：

```
design_capture { url: "https://linear.app", notes: "冷黑 + Indigo,密集组件 token" }
design_discover { query: "AI coding assistant landing page", limit: 3 }
design_library { action: "export", id: "linear", format: "tokens" }
```

每个 HTML 文件顶部的 CSS 注释都写明了它复用了捕获结果里的哪些 token（调色板、字阶、圆角、阴影、缓动、
断点）。**用浏览器直接打开即可**，不需要构建、不需要服务器；离线时字体回退到系统栈，排版依然成立。

两个页面的对照也说明了同一套流程的适用范围：

- `landing-linear.html` —— 捕获自**营销站**：冷黑底、`#5e6ad2` 品牌色调、Inter Variable 字阶、12px 圆角。
- `console-cursor.html` —— 捕获自**产品站**（由 `design_discover` 自动找到并收录）：暖黑底 `#14120b`、
  2–3px 小圆角、带字距的大写微标签、product ansi 绿/红用于 diff 与日志、EB Garamond 衬线标题。
