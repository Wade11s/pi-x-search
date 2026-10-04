# Grok 4.5 / 4.6 / 4.7 在 pi-x-search 中的比较

## 资料范围

本次仅查阅公开资料和本插件源码，没有发起收费的 xAI 搜索或三模型 A/B 测试。
官方定价和推理文档所示更新时间为 2026-09-29；AA 的 4.5 / 4.7 发布评测分别为 2026-07-08 / 2026-09-21。价格、模型权限和评测可能继续变化。

## 结论

- 保留 `grok-4.7` 作为默认模型是合理的选择：官方强调更好的自检和长上下文处理，AA 的通用知识幻觉指标也有所改善。但这不是本插件的 X 检索召回率或幻觉率实测结论。[2][4]
- 三者标准非缓存输入/输出单价相同，不能仅因 4.5/4.6 较旧就认定更便宜。4.5 的缓存输入单价较低。[1]
- 实际成本还取决于内部推理、累计输入、缓存命中、帖子/用户抓取数，以及主 Agent 调用插件的次数。[1][6][8]

## 搜索能力：工具接口和规划模型应分开

插件在 `src/xai.ts` 中调用 `POST https://api.x.ai/v1/responses`，启用官方 `x_search`；换模型不改变插件的账号、日期等筛选字段或输出契约。

官方 X Search 包含关键词搜索、语义搜索、用户搜索和线程抓取。[6]
没有找到按 4.5/4.6/4.7 分别披露不同 X 索引范围、同预算召回率或 X Search 引用准确率的公开对照。因此不能宣称新版会自动解锁更多帖子，或给出它多找出多少帖的比例。

官方公开的模型改进重点：

| 模型 | 与研究有关的能力描述 | 能否视为 X Search 实测 |
| --- | --- | --- |
| 4.5 | 支持 Agent、技术任务和知识工作；官方成本跟踪示例明确使用 4.5 + `x_search` | 否 [8][9] |
| 4.6 | 加强长程 Agent、多步研究、信息分析及自检 | 否 [3] |
| 4.7 | 更好地验证自己的工作、管理长上下文，改进一般知识工作 | 否 [2] |

在这个插件中的潜在差异是查询构造、后续搜索选择、证据筛选和归纳，而不是插件本地新增了另一种搜索引擎。上述官方整体能力改进不证明每条 X 查询都会更好。

## 幻觉：可引用通用指标，但不能冒充 X Search 指标

Artificial Analysis 发布评测给出的 AA-Omniscience Hallucination Rate：

| 模型 / 推理设置 | 报告值 | 来源 |
| --- | --- | --- |
| Grok 4.5 / high | 54% | 4.5 发布评测与模型页 [5][10] |
| Grok 4.6 / high | 34% | 4.7 发布评测的对照 [4] |
| Grok 4.7 / xhigh | 29% | 4.7 发布评测 [4] |

解释边界：

- 该指标定义为 `incorrect / (incorrect + partial answers + not attempted)`，不是所有回答中错误答案的比例。[7]
- 这是跨领域知识与校准评测，不是启用本插件 `x_search` 后的幻觉率。
- 发表时间和推理档位不同，尤其 4.7 使用 xhigh、4.6 使用 high；不是相同预算、相同推理档位的公平控制实验。
- 4.7 与 4.6 的 AA-Omniscience Accuracy 分别为 47% / 48%。较低幻觉指标也与是否愿意承认不知道有关，不代表知识准确率全面提高。[4]
- 帖子真实存在、引用支持模型结论、帖子所说的内容本身为真，是三个不同问题。插件保留引用和质量信号，但没有验证每条事实。
- `posts_only` 对所有模型仍是操作符与指令层 best-effort 限制；换成 4.7 不会使其成为独立验证的帖子类型硬过滤。

## 官方 API 价格

单位：USD / 1M tokens；标准全局端点；prompt < 200k tokens。[1]

| 模型 | 非缓存输入 | 缓存输入 | 输出（推理也计费） |
| --- | ---: | ---: | ---: |
| grok-4.5 | $2.00 | $0.30 | $6.00 |
| grok-4.6 | $2.00 | $0.50 | $6.00 |
| grok-4.7 | $2.00 | $0.50 | $6.00 |

prompt 达到 200k 的长上下文门槛后，上述三者全部 token 类型的单价翻倍；不是只对超出部分加价。[1]

X Search 另收费，三者不因模型名不同而改变该工具的公布费率：[1][6]

- $5 / 1000 个抓取帖子，即 $0.005 / 帖。
- $10 / 1000 个抓取用户资料，即 $0.01 / 用户。
- 包括返回的父帖、被引用帖、抓取线程的全部帖子；多次返回同一帖重复计数。
- 帖子抓取数不等于最终候选数、引用数或工具调用次数。

举例：100 次计费帖子抓取的帖子费为 $0.50，不论最终仅展示 5 个发现。另加模型 token、用户资料和可能的图像/视频 token 费用。这是费率示例，不是典型请求消费预测。

AA 4.7 发布评测中，4.7 xhigh 与 4.6 high 每任务输出 token 约为 81k / 36k；这说明相同单价不意味着相同任务总价，但不能直接把这组数字套到限预算 X 搜索上。[4]

## 在插件中的选择建议

- 初步找帖子：优先 `grok-4.7` + `research_mode: "quick"` + `reasoning_effort: "low"`，明确指定候选数和日期/账号范围。
- 冲突证据、复杂关系归纳：保留 4.7，考虑 balanced + medium；只有确有必要才增加预算或做 deep/high。
- 4.5/4.6：适合做已知工作流的对照或保留历史行为；4.5 缓存命中率极高时有缓存价格优势，不能据此保证端到端更便宜。
- 插件默认 `reasoning_effort: "model_default"` 会省略 API reasoning 字段。官方称三个模型未指定时均默认 high，并非 low；4.5 的 xhigh 按 high 处理。[11]
- 优先看供应商报告的 `usage.cost_usd`（插件由 `cost_in_usd_ticks` 转换）、`x_posts_fetched`、`x_users_fetched`，不要用引用数量估算消费。[8]
- API 标价不等于用户订阅的固定月费或剩余额度；账号可用模型与实际结算以当前权益、控制台及 API 报告为准。[1]

要获得本 tool 的可信对比，应固定同一组查询、时间窗口、模式、推理档位和预算，重复运行并独立核验帖子和引用支持度；分别记录召回、无依据陈述、回复混入、延迟、抓取计数和真实成本。仅比较不同模型单次回答不能估算可靠幻觉率。

## 来源

1. [xAI 官方 API Pricing](https://docs.x.ai/developers/pricing)。使用当前官方价格；AA 较早的 4.5 文章所列缓存价格与当前官方表不同。
2. [xAI: Introducing Grok 4.7](https://x.ai/news/grok-4-7)
3. [xAI: Introducing Grok 4.6](https://x.ai/news/grok-4-6)
4. [Artificial Analysis: Benchmarking Grok 4.7](https://artificialanalysis.ai/articles/benchmarking-grok-4-7)
5. [Artificial Analysis: Grok 4.5 brings SpaceXAI to the intelligence frontier](https://artificialanalysis.ai/articles/grok-4-5-brings-spacexai-to-the-the-intelligence-frontier)
6. [xAI: X Search](https://docs.x.ai/developers/tools/x-search)
7. [Artificial Analysis: AA-Omniscience methodology and metrics](https://artificialanalysis.ai/evaluations/omniscience)
8. [xAI: Cost Tracking](https://docs.x.ai/developers/cost-tracking)
9. [xAI: Introducing Grok 4.5](https://x.ai/news/grok-4-5)
10. [Artificial Analysis: Grok 4.5 (high) model page](https://artificialanalysis.ai/models/grok-4-5)
11. [xAI: Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)
