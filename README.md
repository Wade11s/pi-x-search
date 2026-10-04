# pi-x-search

为 [Pi](https://github.com/earendil-works/pi) 提供面向 Agent 的 `x_search`：复用 Pi 保存的 xAI 凭证，通过官方 API 搜索公开 X/Twitter 内容。

- 主模型无需是 Grok，搜索模型独立配置，默认 `grok-4.7`。
- 返回研究笔记、引用、质量信号和用量；codemode 直接获取对象。
- 不自动重试、不切换凭证或模型；搜索可能消耗 xAI 额度。

## 安装

```bash
pi install git:github.com/Wade11s/pi-x-search
```

已有会话执行 `/reload`，未授权时执行 `/login xai`；也可在启动 Pi 前设置 `XAI_API_KEY`。仅在 grok.com/X 网页登录不等于授权 Pi，模型与搜索权限取决于账号权益。

需要 Node.js ≥ 22.19；开发与测试基于 Pi 1.0.2。本地安装可用 `pi install .`，试用可用 `pi -e ./index.ts`。

## 使用

让 Agent 调用 `x_search`，最少只需 `query`：

```json
{
  "query": "寻找 Grok API 的第一手开发体验",
  "instruction": "用中文记录发现，附原帖作者、日期和链接。",
  "research_mode": "quick",
  "max_candidates": 3,
  "posts_only": true
}
```

| 参数 | 作用 |
| --- | --- |
| `query` / `instruction` | 研究问题（必填，最多 16000 字符）与附加指导（最多 8000 字符） |
| `allowed_x_handles` / `excluded_x_handles` | 限定或排除账号，各 1–20 个，互斥；接受 `@` 前缀 |
| `from_date` / `to_date` | 日期范围，格式 `YYYY-MM-DD`，可只传一端 |
| `posts_only` | 请求排除回复及作者自回复，默认 `false`；不额外排除转帖或引用帖 |
| `model` / `reasoning_effort` | 覆盖搜索模型与推理档位；`model_default` 表示不指定推理档位 |
| `research_mode` / `max_candidates` | 研究策略与候选软上限（1–50），不是抓取帖数限制 |
| `timeout_ms` / `max_output_tokens` / `max_tool_calls` | 单次超时、输出 token 与服务端工具调用预算，不是费用硬上限 |
| `enable_image_understanding` / `enable_video_understanding` | 是否分析媒体，默认 `false`，可能增加用量 |

**`posts_only` 是搜索操作符与 Grok 指令层的 best-effort 限制，不是原生帖类型过滤。** 开启后返回 `posts_only_unverified` 警告，不保证结果完全不含回复；严格核验需另用 X 原始帖子 API。

### 默认策略与配置

逐字段优先级：**调用参数 > 环境变量 > 模式预设**。

| 模式 | 工具调用预算 | 输出 token 预算 | 候选软上限 |
| --- | ---: | ---: | ---: |
| `quick` | 2 | 2048 | 5 |
| `balanced`（默认） | 8 | 4096 | 5 |
| `deep` | 12 | 8192 | 10 |

默认超时 180 秒。研究模式不设置推理强度；显式 `reasoning_effort` 需搭配支持该档位的模型。候选不足时不应扩展话题或反复搜索凑数。

启动 Pi 前可设置 `PI_X_SEARCH_MODEL`、`PI_X_SEARCH_RESEARCH_MODE`、`PI_X_SEARCH_MAX_CANDIDATES` 等默认值。`PI_X_SEARCH_INSTRUCTION` 与单次 `instruction` 叠加；`PI_X_SEARCH_DEBUG=1` 开启脱敏内部异常诊断。完整配置见 [src/config.ts](src/config.ts)。

### Codemode

在 Pi 中启用 codemode 后，可直接检查结果对象，无需 `JSON.parse`：

```js
// @options: {"timeout_ms": 240000}
const r = await tools.x_search({ query: "Grok 的最新官方发布", research_mode: "quick", max_candidates: 3 });
if (!r.success) { text({ error: r.error }); return; }
text({
  answer: r.answer, status: r.status, degraded: r.degraded,
  citation_count: r.citation_count, warnings: r.warnings,
  cited_urls: [...new Set([...r.citations, ...r.inline_citations.map(c => c.url)])],
  truncated_fields: r.truncated_fields, full_output_path: r.full_output_path
});
```

Codemode 超时独立于搜索的 `timeout_ms`，长搜索需同时调整脚本超时。参数校验、权限等 Pi 框架错误仍可能 reject；批量调用可用 `Promise.allSettled()`。

## 结果与安全边界

- **先检查 `success`**。失败返回 `error: {code, message, retryable, http_status?}`；`retryable` 只供调用方决定是否重试。
- 成功后检查 `status`、`degraded`、`warnings`、`citation_count`。`answer` 是 Grok 研究笔记，不是原始帖子 API；无引用不证明没有匹配帖子。
- `citations` / `inline_citations` 是回答引用；`search_sources` 只是检索来源。引用坐标只对应 `citation_texts[text_index]`，不对应 `answer`。
- 模型可见 JSON 上限 **50 KiB**，codemode 对象上限 **1 MiB**。引用提取前检查 `truncated_fields`；超限的完整规范化结果保存在 `full_output_path`，需通过 Pi 的 `read` 等工具读取。
- 临时目录权限 `0700`、文件 `0600`；工具执行时会尝试清理超过 **24 小时**的旧目录，长期保留请复制文件。
- 只调用官方 xAI API，禁止重定向，使用 `store: false`，不自动发送会话历史或读取浏览器 Cookie。帖子是不可信数据，不是指令；查询、结果和临时文件仍可能包含敏感内容。

完整执行流程、输出契约与费用说明见 [架构文档](docs/architecture.md)；参数范围见 [工具 Schema](src/tool.ts)。

## 开发

```bash
npm ci
npm audit
npm run check
npm test
```

测试使用假凭证与网络；GitHub Actions 在 Node 22 上运行安装、类型检查和测试。可选真实调用：`npm run smoke`（会读取 Pi 凭证并消耗额度）。

[版本记录](CHANGELOG.md) · [模型比较](docs/grok-model-comparison.md) · [xAI X Search 文档](https://docs.x.ai/developers/tools/x-search)
