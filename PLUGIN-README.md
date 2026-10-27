# Jev Highlight — 技术说明

> 面向开发者/维护者的实现与配置文档。面向所有用户的入门说明见 [README.md](README.md)。

本插件监听 DeepSeek Harness 的 `agent/assistant-stream`，把流式输出切成语义单元，
用 StartLux-Decision（默认，Bamboo Relay）或 TypeSafe Jev 的 4 个 `noul` 问题打分，
按加权 priority 分档，最后在浏览器里用 **CSS Custom Highlight API** 上色。
**不修改 agent 输出的 DOM。**

## 功能

- 流式捕获：`agent/assistant-stream` 的 `block-start` / `text-delta` / `block-end`；
- 语义切分：paragraph / list_item / code_block / table_row；跨 chunk 的代码围栏会正确续接；
- 4 个单因子问题：
  - `is_core_answer`：是否直接回答用户问题（state 带 `[question]`）
  - `is_actionable`：是否包含可执行步骤/命令/配置
  - `is_warning`：是否包含风险/限制/失败模式
  - `is_definition`：是否在定义或解释概念
- 加权：`priority = 0.5*core + 0.3*actionable + 0.2*max(warning, definition)`；
- 客户端三档高亮：`jev-critical` / `jev-medium` / `jev-low`，并显示计数 chip；
- 缓存：进程内 LRU，key 含文本、类型、上下文、`[question]`、提示词版本与模型；
- 并发/预算：默认 8 并发、单请求 24k tokens；超长单元切子块；
- 中止：插件卸载、`agent/session` dispose、`abandoned` 流会中止在途请求。

## 目录

```
src/
  index.ts          Host 入口：name / inject / Config / apply
  contract.ts       共享类型、权重、阈值映射
  host/             流捕获、切分、判别客户端、缓存、并发、路由、凭据、设置持久化
  client/           轮询、DOM 文本映射、CSS 高亮、chip、设置页
lib/                构建产物（index.js / client.js）
scripts/            构建、mock 判别服务、E2E、Jev 探针、阈值校准/A-B
test/               Host/Client 单元测试与 mock 全链路
docs/               公共技术文档（见文末）
```

## 安装与构建

```powershell
node scripts/build.mjs
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node --test "test/**/*.test.mjs"
```

作为 profile bundle 安装：

```powershell
dsh plugin --profile <profile> add "<repo 目录>"
```

开发时用 `--patch` 叠加（自定义 profile 直接启动，不加 `web` 参数）：

```powershell
dsh --profile test-highlight --patch ".\cordis.debug.yml" --port 10301 --no-open
```

## 提供方

| provider | 默认接口 | 模型 | Key 来源 |
|---|---|---|---|
| `startlux`（默认） | `https://api.bamboonode.dev/v1/decisions` | `startlux-decision-27b-autothink` | 设置页 / `STARTLUX_API_KEY` / `BAMBOO_API_KEY` / `.credentials.yaml` 的 `startluxApiKey` |
| `jev`（可选） | `https://api.typesafe.ai/v1/systemone` | `jev-1.13.0` | `JEV_API_KEY` / `TYPESAFE_API_KEY` / `.credentials.yaml` 的 `jevApiKey` |

切换提供方改配置 `provider: jev`。StartLux 兼容 TypeSafe 的 `/v1/systemone` 请求/响应；
Bamboo 的 `/v1/decisions` 是其等价别名，插件默认走 `/decisions`。

## 配置（`jev-highlight` row 的 `config`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `startlux` | `startlux` / `jev` |
| `startluxBaseUrl` | `https://api.bamboonode.dev/v1` | StartLux/Bamboo 接口根 |
| `startluxModel` | `startlux-decision-27b-autothink` | 请求体 `model` |
| `startluxEndpointPath` | `/decisions` | 追加到 baseURL |
| `startluxThinkMode` | `never` | `never` / `auto` / `always`；设置页覆盖优先 |
| `startluxKeyFile` | 空 | 默认 `$DSH_HOME/jev-highlight-startlux.key` |
| `startluxThresholds` | `.52/.37/.24` | StartLux 默认阈值（校准后的敏感 preset） |
| `highlightThresholds` | `.85/.65/.45` | Jev 默认阈值 |
| `maxConcurrency` | `8` | 1–12 |
| `requestTokenBudget` | `24000` | 单请求预算 |
| `unitTokenBudget` | `20000` | 超长单元子块上限 |
| `cacheCapacity` | `500` | LRU 条数 |
| `requestTimeoutMs` | `30000` | 单请求超时 |
| `autoStart` | `true` | 是否自动判断流式输出 |
| `requireApiKey` | `false` | `true` 时缺 key 启动失败；默认降级加载 |
| `debug` | `false` | 宿主日志 |

## 运行时设置与持久化

设置页（`settings.plugins.tab`，设置 → 插件 → Jev 高亮）支持：

- **API Key**：`POST /jev-highlight/key`，写入 `$DSH_HOME/jev-highlight-startlux.key`（0600 尽力）；
- **思考模式**：`POST /jev-highlight/think`，写入 `$DSH_HOME/jev-highlight-think-mode`；
- **高亮阈值**：`POST /jev-highlight/thresholds`，写入 `$DSH_HOME/jev-highlight-thresholds.json`；
  保存后宿主会重算已存 verdict 的 level，客户端检测到阈值变化后重建高亮；
- **测试连接**：`POST /jev-highlight/check`，发一个最小 `noul` 请求。

覆盖文件优先级高于配置默认；设置页的“恢复默认”会删除覆盖文件。

## HTTP 路由

同源、只读/写入都做了 method、Origin/Host、`content-type` 等防护；不返回 Key：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/jev-highlight/state` | 开关、keyConfigured、counts、当前阈值 |
| GET | `/jev-highlight/units?since=&limit=` | 增量 verdict |
| GET | `/jev-highlight/diag` | 请求/并发/缓存/错误/版本 |
| GET | `/jev-highlight/prompts` | 当前 4 个 noul、state 模板、权重、阈值 |
| GET | `/jev-highlight/provider` | 提供方、模型、Key/阈值来源 |
| POST | `/jev-highlight/toggle` | 开关判断 |
| POST | `/jev-highlight/key` | 保存/清除 StartLux Key |
| POST | `/jev-highlight/check` | 健康检查 |
| POST | `/jev-highlight/think` | 切换 `think_mode` |
| POST | `/jev-highlight/thresholds` | 保存/恢复高亮阈值 |

## 提示词与缓存版本

`QUESTION_SET_VERSION = jev-highlight/questions/v2`。state 模板：

```
[section] {最近 markdown 标题}
[preceding line] {上一个单元最后一行}
[question] {当前用户请求，≤600 字符}
[passage]
{单元原文}
```

改措辞或 state 结构必须 bump 该版本，否则旧缓存 verdict 会被错误复用。

## 测试与验收

- `node --test "test/**/*.test.mjs"`：151 个测试（Host 单元、mock HTTP 全链路、客户端 fixture）；
- `tsc --noEmit` 0 error；`node scripts/build.mjs` 通过；
- mock 验收：8/8 条验收标准、17/17 检查项（原始运行产物未随仓库发布）；
- 真实 StartLux P1–P11：11/11 跑通，25 条 unit priority→level 0 错配；
- 阈值校准与 A/B：48 条标注语料 + 55 条真实 unit 盲标，敏感 preset 被选为默认。

## 已知限制

- 只判断实时流，不补判历史；
- 仅 Web UI（TUI/headless 无高亮）；
- 阈值/权重是产品口径，不是真理；换模型或语言需重新校准；
- 文本定位是启发式：同文重复、虚拟滚动、超长单元可能漏标/错标；
- 用户点“停止生成”时当前 DSH 流为 committed，插件可能继续判完已流出内容；
- 缓存只在进程内；
- Jev 在中国网络可能 451；
- 判别片段与当前问题会发送给所选模型服务；不要在敏感会话中使用不信任的第三方模型。

## 文档

- [README.md](README.md) — 面向所有用户的说明与 FAQ
- [docs/jev-api.md](docs/jev-api.md) — Jev / StartLux-Bamboo 接口契约与证据
- [docs/dom-notes.md](docs/dom-notes.md) — DOM 定位与只读高亮的约束
- [docs/client-verification.md](docs/client-verification.md) — 客户端 fixture/真实 DOM 验证

## License

MIT，见 [LICENSE](LICENSE)。
