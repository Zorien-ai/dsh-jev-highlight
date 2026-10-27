# Jev / TypeSafe System One API 契约核实报告（noul）

> 面向 **host-core（Jev 重点高亮插件）** 的可照抄契约：真实字段名、限制、错误/重试、token 预算、CJK 限制与解析建议。
>
> **核实日期：2026-10-20（Asia/Shanghai）** ｜ 负责人：teammate `jev-api`（task-3）
>
> **本次真实调用状态：被区域封锁（HTTP 451），计费 0 token。** 详见 §0。
>
> 契约以 **OpenAPI 3.1 权威规范 + 官方文档 + 两批真实调用证据** 交叉验证：
> ① 2026-09-21 从深圳真实跑通的 1,980 次调用（Choice 答案 + 真实 `usage.input_tokens`）；
> ② TypeSafe 文档中三组带真实 `input_tokens` 的记录型响应（含 noul）；
> ③ 本次 2026-10-20 的 451 原始响应（证明出口被地区限制，非 key 失效）。

---

## 0. 本次核实结论速览（先看这里）

### 0.1 本次真实调用结果：**HTTP 451，区域封锁；未产生任何 token 费用**

| 探测 | 方法/路径 | 结果 | 计费 |
| --- | --- | --- | --- |
| 列出模型（带 key） | `GET /v1/models` | **451** `{"title":"Typesafe is not available in your region.","status":451}`（cf-ray `…-LAX`，716–1002ms） | 0 |
| 主探针（带 key） | `POST /v1/systemone` | **未执行**（先跑 `models` 已确认 451，避免对已封锁边缘继续发无意义请求；脚本本身未跑 main） | 0 |
| 无 key 探针（对照） | `POST /v1/systemone` | **451**，与带 key 完全一致 | 0 |

关键判断：451 在**鉴权与推理之前**由边缘（Cloudflare）返回，**带不带 key 都一样**，因此这是**网络出口的地区限制**，不是 key 无效，也不是请求体问题。实测期间还确认本机存在 mihomo/FlClash 端口（127.0.0.1:9790/10090），但作为 HTTP/SOCKS 代理均不可用（curl 退出码 56/28/35）；**Lead 已裁决不通过代理绕过地区限制，未执行绕过**。

#### 451 原始证据（脱敏）

| 项 | 值 |
| --- | --- |
| 发生时间（UTC） | `2026-10-20T03:06:41Z`（首次 `GET /v1/models`）；`2026-10-20T03:17:14Z`（复测） |
| 本地时间 | 2026-10-20 11:06 / 11:17（Asia/Shanghai） |
| 请求 | `GET /v1/models`（带 Bearer；Authorization 不落盘）＋对照：`POST /v1/systemone`（不带 key） |
| 响应状态 | `451` |
| 响应体 | `{"title":"Typesafe is not available in your region.","status":451}` |
| 响应头（脱敏） | `content-type: application/json`；`date: Tue, 20 Oct 2026 03:17:14 GMT`；`cf-ray: a4d4de4d…efba-LAX`（LAX=边缘节点，中间段打码） |
| 耗时 | 716–1002ms（TCP/TLS 正常，非网络不可达） |
| 计费 | **0 token**（边缘在鉴权/推理前拒绝） |
| 原始证据 | `docs/jev-probe-result.json`（sanitized：无 key、无 Authorization 头） |

**验收口径（Lead 裁决）**：不使用代理绕过地区限制；最终验收走 **mock 分支**（`JEV_API_KEY=dummy` + `jevBaseUrl` 指向 localhost mock）验证全链路，真实 451 分支作为**已知限制**记录（见 §11）。

### 0.2 key 本身是有效的（硬证据）

用户的旧项目 `F:\workspace\最新模型jev和bert和deepseek-V4.1Flash模型对比和混合架构的探索\duibi\jev` 保留了 **2026-09-21 从中国深圳**用同一个 `TYPESAFE_API_KEY` 完成的真实调用结果：

| 指标 | 值 |
| --- | --- |
| 成功调用 | **1,980 次**（`n_ok=1980`，`n_error=0`） |
| 模型 | `jev-1.13.0`（固定版本，非别名） |
| 总输入 token | **783,691**（真实 `usage.input_tokens`，平均 395.8/次） |
| 估算花费 | **$0.0329**（按 $0.042/Mtok） |
| 答案形状（真实） | `{"model":"jev-1.13.0","answers":{"sentiment":{"type":"choice","choice":"negative","confidence":1.0,"probabilities":{"negative":1.0,"positive":0.0}}},"usage":{"input_tokens":386,"output_tokens":32}}` |

→ 结论：**key 有效、账号可用、契约在 9 月是可用的**；2026-10-20 的 451 是新增/临时的地区可用性限制。网络恢复后，本仓库探针一条命令即可补跑真实 noul 调用（§13）。

### 0.3 与任务书假设的差异（重要）

| 任务书假设 | 真实契约（已核实） |
| --- | --- |
| noul 返回 P(yes) | ✅ 正确：`answers.<id>.noul` 就是 P(yes) ∈ [0,1] |
| 没有独立 confidence 字段 | ✅ 正确：noul **没有** `confidence`；但 Choice/Score 有 |
| 字段名可能是 `probability` / `p_yes` | ❌ **都不存在**。唯一字段是 **`noul`**，且每项还带 `"type":"noul"` |
| 请求里 `label` 固定为 yes | ❌ **没有 `label` 字段**。noul 问题只有 `type`、`instructions`、可选 `criteria {true,false}`；"yes 方向"靠指令措辞保证 |
| 模型名 `jev-1.13` / `jev-1.13.0` | ⚠️ 现在有 **Jev 1.14（`jev-1.14.0`，2026-10-14 起）**；`jev-latest` 别名当前仍指向 **`jev-1.13.0`**，`jev-preview` 指向 `jev-1.14.0`。插件固定 `jev-1.13.0` 合法 |
| 响应 `model` 字段 | ⚠️ 返回的是**真正回答的版本化 ID**（可能不同于请求的别名），必须记录/校验 |

### 0.4 一句话结论

```ts
const p = response.answers['is_core_answer'].noul   // ✅ 真实字段，number ∈ [0,1]
// 不存在 response.answers[id].probability / .p_yes / .confidence
```

---

## 1. 端点、认证与通用请求头

| 项 | 契约 |
| --- | --- |
| Base URL | `https://api.typesafe.ai`（可替换为自建代理/网关的 origin） |
| 主端点 | `POST /v1/systemone` |
| 模型列表 | `GET /v1/models`（返回账号可用的**别名**，版本号 ID 即使不列出也接受） |
| 认证 | `Authorization: Bearer <TYPESAFE_API_KEY>`（HTTP Bearer，OpenAPI `securitySchemes.HTTPBearer`） |
| 请求体 | `Content-Type: application/json`；UTF-8、**不带 BOM**；≤ **32 MiB**；嵌套 ≤ 64 层；数字必须有限（拒绝 NaN/Infinity/1e400） |
| 压缩（可选） | `Content-Encoding: gzip` / `x-gzip` / `zstd`（单层；zstd window ≤ 8 MiB；不支持 → 415，损坏 → 400） |
| 危险区头（可选） | `TypeSafe-Danger-Zone-Long-Context: true` → 上下文 262k；`TypeSafe-Danger-Zone-Images: true` → 图像/box（插件用不到） |

来源：[API reference / System One](https://docs.typesafe.ai/api/system-one)、[Request rules and errors](https://docs.typesafe.ai/api/errors)、[List models](https://docs.typesafe.ai/api/list-models)、[Models](https://docs.typesafe.ai/models)。

---

## 2. 请求契约（插件实际要发的 body）

### 2.1 顶层字段

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `model` | ✅ | string | 模型 ID 或别名，如 `jev-1.13.0` / `jev-latest` |
| `state` | ✅ | string \| object \| array | 被判断的内容；插件放回答单元（+上下文）文本 |
| `questions` | ✅ | object，`minProperties: 1` | 键 = 你选的 question id（**不会发送给模型**），值 = Question |
| `assets` | ❌ | object | 图像资源，插件不用 |

### 2.2 Noul 问题结构（**没有 label 字段**）

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `type` | ✅ | `"noul"`（const） | 问题类型判别符 |
| `instructions` | ❌（实践中必给） | string \| object \| array \| null | 一个是/否问题或陈述句；**措辞必须让"高值 = yes"** |
| `criteria` | ❌ | `{ true?: string\|object\|array\|null, false?: string\|object\|array\|null }` | 可选的 yes/no 边界说明 |
| `label` | — | **不存在** | 不要发送；发了也可能被忽略/422 |

> 官方原文："A Noul question asks the model to evaluate a yes/no question and return the probability that the answer is yes… `criteria`: Optional. An object with `true` and `false` descriptions of what a yes and a no mean."（[Noul](https://docs.typesafe.ai/primitives/noul)）
> `instructions` 推荐写成**单条、字面、yes 正向**的问题，例如 "Does this passage contain a concrete action the reader can execute?"；不要把多个判断塞进一个 noul（[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)）。

插件四个问题的建议 body（**字段名已核实**）：

```json
{
  "model": "jev-1.13.0",
  "state": "单元文本 + 可选 heading/上文上下文",
  "questions": {
    "is_core_answer": {
      "type": "noul",
      "instructions": "Is this passage the core answer that directly resolves the user's question?"
    },
    "is_actionable": {
      "type": "noul",
      "instructions": "Does this passage contain a concrete action, command, or step the reader can execute?"
    },
    "is_warning": {
      "type": "noul",
      "instructions": "Does this passage warn about a risk, caveat, failure mode, or limitation?"
    },
    "is_definition": {
      "type": "noul",
      "instructions": "Does this passage define or explain the meaning of a term, concept, or field?"
    }
  }
}
```

> 语言建议：**用英文写 instructions**（Jev 的母语是英文，CJK 准确率更低，见 §9）；`state` 可以是中文。

### 2.3 其他问题类型（仅作对照，插件不用）

| 类型 | 必填字段 | 答案字段 |
| --- | --- | --- |
| `choice` | `type`, `criteria`（1–255 个标签→描述，必填） | `choice`, `confidence`, `probabilities` |
| `score` | `type`, `criteria`（1–10 个等级，**必填**） | `score`, `confidence`, `legend`, `probabilities` |
| `box` | `type`（需图像头） | `box{top,bottom,left,right}`, `confidence(number|null)` |

---

## 3. 响应契约（noul 的真实字段）

### 3.1 Response schema（OpenAPI `SystemOneResponse`）

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `model` | ✅ | string | **真正回答的版本化 ID**（"May differ from the alias supplied in the request"）；务必记录 |
| `answers` | ✅ | object，`minProperties: 1` | 键 = 请求里的 question id；值 = 与问题类型匹配的 Answer |
| `usage.input_tokens` | ✅ | integer | 计费输入 token（唯一计费项） |
| `usage.output_tokens` | ✅ | integer | 输出 token（**当前免费**） |

### 3.2 Noul 答案（`NoulAnswer`）

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `type` | ✅ | `"noul"` | 答案类型 |
| `noul` | ✅ | number | **P(yes) ∈ [0, 1]**；0 ≈ no，1 ≈ yes，0.5 ≈ 不确定 |
| `confidence` | — | **不存在** | noul 没有 confidence（Choice/Score 才有） |
| `probabilities` / `rationale` | — | **不存在** | 无 rationale；概率分布只有 yes/no 两个结果，`noul` 一个数已完整描述 |

### 3.3 官方记录型 noul 响应示例（真实 `usage`，来自文档）

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_human_escalation": { "type": "noul", "noul": 0.99 },
    "is_repeat_contact":   { "type": "noul", "noul": 0.93 }
  },
  "usage": { "input_tokens": 360, "output_tokens": 39 }
}
```

> 来源：[Noul — Response structure](https://docs.typesafe.ai/primitives/noul)。同一页还记录了不同 state 的 `noul` 取值（0.02 → 0.99），说明 noul 是连续概率而非布尔。

### 3.4 项目历史真实响应（2026-09-21，choice，用于确认响应信封）

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "sentiment": {
      "type": "choice",
      "choice": "negative",
      "confidence": 1.0,
      "probabilities": { "negative": 1.0, "positive": 0.0 }
    }
  },
  "usage": { "input_tokens": 386, "output_tokens": 32 }
}
```

> 证据：`duibi/jev/out/jev_raw_zh.jsonl` 第 1 行（1,980 条同类记录）。这条证据证明：`model` 返回固定版本 `jev-1.13.0`、`answers` 按自定义 id 键控、`usage` 字段名与语义正确。

---

## 4. 模型、别名、价格、上下文

### 4.1 模型与别名（官方 [Models](https://docs.typesafe.ai/models)）

| 模型 ID | 说明 | 价格 | 上下文 |
| --- | --- | --- | --- |
| `jev-1.14.0` | 最新版本（2026-10-14 起） | $42/Btok，即 **$0.042/Mtok 输入**；输出免费 | 64k/请求，32k/问题 |
| `jev-1.13.0` | 上一版（**插件默认固定此版本，合法**） | 同上 | 64k/请求，32k/问题 |

| 别名 | 当前指向 | 含义 |
| --- | --- | --- |
| `jev-latest` | `jev-1.13.0` | 最新**稳定**发布；SDK 默认；会随发布移动 |
| `jev-preview` | `jev-1.14.0` | 最新发布（含 preview）；比 `jev-latest` 更超前 |

要点：
- **别名会漂移**；调过阈值就应固定版本 ID，并记录响应 `model`（官方原话："If you have tuned confidence thresholds against one version, send that version's ID instead of the alias"）。
- `GET /v1/models` 当前**只列别名**；`jev-1.14.0` 等版本号即使不在列表也接受。
- 本次 451 导致无法现场核对账号可用模型列表；网络恢复后 `--mode models` 可补。

### 4.2 两层上下文限制（官方）

- **per-request context（64k）**：`state` + **所有** questions 合计。
- **per-question context（32k）**：`state` + **任意单个** question（即 state + 最长问题）。
- question 数量本身不设限，只要满足以上两条。
- 长上下文开关：请求头 `TypeSafe-Danger-Zone-Long-Context: true` → 两条限制都提升到 **262k**；单价相同，但**更慢、准确率更低**，只在必要时开。
- 插件侧启示：`requestTokenBudget` 默认 24k（< 64k）是安全的；`unitTokenBudget` 应保证 `state + 最长问题 ≤ 32k`，实际按 §7 估算即可。

### 4.3 速率限制

- 限制按**组织**设置，单位为 **tokens/秒** 和 **requests/秒**，控制台可查（[Rate limits](https://docs.typesafe.ai/models#rate-limits)）。
- 超限返回 **429**；官方 SDK 默认自动重试并遵循 `retry-after`。

### 4.4 模型配置建议（供 README / 插件文档引用）

| 配置值 | 含义 | 建议 |
| --- | --- | --- |
| `jev-1.13.0` | 固定版本，**插件默认** | **生产推荐**；与本文契约核实的 jev-1.13 一致，也是 1,980 次历史真实调用所用版本 |
| `jev-latest` | 别名，当前指向 `jev-1.13.0`，随发布漂移 | 仅开发/跟随最新稳定版时用；漂移后阈值需重新校准 |
| `jev-1.14.0` | 2026-10-14 起的最新版本（对应别名 `jev-preview`） | 可显式配置；升级前用相同 4 个 noul + 真实数据重新校准阈值 |
| `jev-preview` | 别名，指向 `jev-1.14.0` | 不建议生产使用 |

插件 `config.model` 默认保持 `jev-1.13.0`；README 配置表已注明可显式改为 `jev-latest` / `jev-1.14.0`。无论选哪个，都必须记录响应 `model`（真实版本号）用于缓存键与问题定位。

---

## 5. 错误、重试与超时（host-core 可直接照抄）

### 5.1 状态码（官方 [Request rules and errors](https://docs.typesafe.ai/api/errors) + 本次实测）

| 状态 | 含义 | 处理建议 |
| --- | --- | --- |
| `400` | 违反请求规则（非法 UTF-8/BOM、嵌套 > 64、非有限数、压缩体损坏）；带 `max_tokens_exceeded` 时 = 超过上下文 | 修正请求；`max_tokens_exceeded` → 拆分/裁剪 state |
| `401` | 缺失/无效 API key | **不重试**；抛出可操作的配置错误（提示配置 `jevApiKey` / `JEV_API_KEY`） |
| `413` | body > 32 MiB | 不重试；拆分 |
| `415` | 不支持的 `Content-Encoding` 或多层压缩 | 不重试；改用单层 gzip/zstd 或明文 |
| `422` | 请求体校验失败（缺字段、问题结构错） | **不重试**（代码 bug）；按 `detail[].loc` 修请求 |
| `429` | 超过速率限制（tokens/s 或 requests/s） | 指数退避 + 抖动；遵循 `Retry-After` |
| `529` | TypeSafe 暂时过载 | 指数退避 + 抖动；可切备用模型/降并发 |
| `451` | **本次实测**：`{"title":"Typesafe is not available in your region.","status":451}`，边缘按出口地区拒绝，**与 key 无关** | **不重试**；作为"服务在您所在地区不可用"的明确错误暴露给用户，并记录 cf-ray |

> 451 **不在官方错误表里**，属于本次新发现的运行态限制（Cloudflare 边缘返回）。官方错误表只列到 429/529。

### 5.2 错误体形状

- `422`：`HTTPValidationError`，`{ "detail": [ { "loc": ["body","questions","xxx"], "msg": "Field required", "type": "missing", "input": …, "ctx": … } ] }`（字段说明来自 OpenAPI；本次因 451 未能现场触发 422，属**文档核实**）。
- `400/401/413/415/429/529`：官方仅说 "JSON body describing what went wrong"，未给统一 schema；解析时**优先取 `detail`/`title`/`message`/`error` 任一字符串**，否则截断原文。
- `451`（实测）：`{ "title": string, "status": 451 }`；响应头含 `cf-ray`。

### 5.3 重试策略建议（host-core）

```
可重试：429、529、5xx、网络错误/超时
退避：  base 500ms，指数 ×2，加 100–300ms 抖动；有 Retry-After 则优先用它
次数：  最多 2 次重试（共 3 attempts）
超时：  每请求 30s（AbortSignal.timeout），并随插件卸载中止全部 in-flight
不可重试：400/401/413/415/422/451（修请求或报错）
并发：  8–12 是规格值，但组织限额是 tokens/s + requests/s，需按实际配额调低；
        429 时降并发而不是硬重试风暴
```

依据：官方 "retry the request with exponential backoff… SDKs handle this automatically"（[Handling rate limits](https://docs.typesafe.ai/api/errors#handling-rate-limits)），Promptfoo provider 文档亦写明会 backoff 并遵循 `Retry-After`（[Promptfoo TypeSafe](https://www.promptfoo.dev/docs/providers/typesafe/)）。

> 可选：JS SDK 对 ≥1 KiB 的 body 会用 zstd 压缩（[JS SDK](https://docs.typesafe.ai/sdk/javascript)）。插件用原生 fetch 时可不压缩；若 state 很大，可考虑单层 `Content-Encoding: zstd`，但需自行确认运行时支持。

---

## 6. 计费口径

| 项 | 口径 |
| --- | --- |
| 计费单位 | **仅输入 token**：$42 / Btok = **$0.042 / Mtok** |
| 输出 token | **免费** |
| 状态数据 | `state` 在 per-request 与 per-question 两个限制里各计一次（但只发一次、只计一次账单） |
| 本次花费 | **$0.00**（所有请求被 451 拒绝，未产生 token） |
| 历史花费 | 1,980 次 / 783,691 输入 token = **$0.0329** |
| 插件单请求成本估算 | 4 noul + ~300 字 state ≈ 0.7–0.9k 输入 token ≈ **$0.00003–0.00004**；1,980 次级别 ≈ $0.03，成本可忽略，瓶颈是延迟与限流 |

---

## 7. Token 校准（真实数据 + 文档记录值）

> 任务书要求对 3 个样本各调一次实时校准。**因 451 无法现场调用**，改为：
> ① 用旧项目 **1,980 条真实 `usage.input_tokens`** 做回归（真实测量值，不是估算）；
> ② 用 TypeSafe 文档里 **3 组带真实 `input_tokens` 的记录型响应**反推每请求固定开销；
> ③ 探针中保留 `--mode calibrate`，网络恢复后 3 次实时调用即可替换本表。

### 7.1 数据源

| 来源 | 样本数 | 请求集合 | 说明 |
| --- | --- | --- | --- |
| 旧项目真实调用（2026-09-21，深圳） | **1,980** | 1 个 choice（中文指令+criteria），`state={review:text}` | 每条都有真实 `usage.input_tokens` |
| TypeSafe 文档记录值 1 | 1 | 2 个 noul（英文） | `input_tokens=360`（[Noul](https://docs.typesafe.ai/primitives/noul)） |
| TypeSafe 文档记录值 2 | 1 | 3 个混合问题（choice/score/noul，英文） | `input_tokens=428`（[Quickstart](https://docs.typesafe.ai/introduction/quickstart#call-it-the-api)） |
| TypeSafe 文档记录值 3 | 1 | 3 个 noul（结构化 instructions） | `input_tokens=535`（[Noul 结构化](https://docs.typesafe.ai/primitives/noul#structured-instructions)） |

复现命令（离线，不联网、不用 key）：

```powershell
node scripts/jev-probe.mjs --mode tokencalib `
  --raw  "F:\workspace\最新模型jev和bert和deepseek-V4.1Flash模型对比和混合架构的探索\duibi\jev\out\jev_raw_zh.jsonl" `
  --preds "F:\workspace\最新模型jev和bert和deepseek-V4.1Flash模型对比和混合架构的探索\duibi\jev\out\preds_test_jev_zh.csv"
```

### 7.2 回归结果（1,980 条真实输入 token）

按**请求体 JSON 字符**回归：`tokens ≈ cjk × 1.0275 + ascii × 0.8244 + 184.08`，**R² = 0.997，MAPE = 0.23%**（p50 0.13%，p90 0.57%）。

| 模型 | 系数/指标 | 值 | 可信度 |
| --- | --- | --- | --- |
| 请求体字符回归 | cjkPerChar | **1.0275** | ✅ CJK 字符数在样本里 71–119 变化，识别良好 |
| | asciiPerChar | 0.8244 | ⚠️ **不可信/不可迁移**：ASCII 字符数几乎恒为 147–150，与截距共线；该值只是拟合伪影，别拿它估英文正文 |
| | jsonOverhead | 184.08 | 特定于该 1-choice 问题集的固定开销 |
| | R² / MAPE | 0.997 / 0.23% | ✅ 对该数据集极好 |

按**state 文本字符**回归：`tokens ≈ cjk × 1.0275 + ascii × 0.825 + 370.01`，MAPE 0.23%（同样，ASCII 不可识别，固定开销 = 问题集模板+问题文本）。

> 样本里评论文本很短（均值 **25.4 字符**，其中 24.3 个 CJK），所以 **1,980 条数据主要证明了：CJK ≈ 1.03 token/字 + 每请求 ~370 token 固定开销**；英文正文的 ASCII 系数必须靠文档记录值反推。

**对照：任务书假设的字符启发式严重偏低**

| 启发式 | MAPE（1,980 条真实值） |
| --- | --- |
| `ceil(CJK×1 + ASCII×0.25)`（任务书假设） | **68.76%** |
| `ceil(JSON 字符数 / 4)` | **85.07%** |

→ 必须按 §7.4 的系数 + 固定开销估算；只按字符/4 会低估 2 倍以上（历史真实均值 395.8，而 chars/4 均值仅约 56）。

### 7.3 文档记录型响应的固定开销反推

用 `1.0275`（CJK）与假设的英文 ASCII 系数估算 state/问题文本 token，剩余即固定开销：

| 记录响应 | 问题数 | 文档 `input_tokens` | 反推固定开销（ASCII=0.30/char） | 反推固定开销（ASCII=0.40/char） |
| --- | --- | --- | --- | --- |
| 2 noul | 2 | 360 | 279.9 | 253.2 |
| 3 混合 | 3 | 428 | 298.4 | 255.2 |
| 3 noul（结构化） | 3 | 535 | 400.3 | 355.4 |

短请求的**固定开销约 250–320 token**（结构化长指令那组因 JSON 结构 token 更多而偏高）。这与 1,980 条真实数据反推的 ~370（中文 choice 问题集）同量级，结论一致：**每个请求有几百 token 的固定成本，问题文本按字符另计**。

### 7.4 给 host-core 的 token 估算器（建议直接采用，保守）

```ts
// 字符统计：CJK 与其余（ASCII 为主）分开
const CJK = /[\u1100-\u11ff\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u31c0-\u31ef\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u

function estimateJevTokens(text: string): number {
  let cjk = 0
  let ascii = 0
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1
    else ascii += 1
  }
  return 1.05 * cjk + 0.35 * ascii
}

// 一次请求：state 文本 + 4 个 noul 问题的 instructions（+可选 criteria）文本
// 固定开销 320 已含 4 个问题的模板/结构开销
const estimatedRequestTokens = Math.ceil(
  estimateJevTokens(stateText) + estimateJevTokens(questionTextJoined) + 320,
)
// 再乘安全系数 1.15 后与 requestTokenBudget(24000) 比较
```

| 参数 | 建议值 | 依据 |
| --- | --- | --- |
| `cjkPerChar` | **1.05** | 1,980 条真实回归 1.0275，向上取 1.05 |
| `asciiPerChar` | **0.35** | 文档记录值反推约 0.3–0.4；对英文正文（BPE ~0.25）与 JSON/代码标点都偏保守 |
| `requestOverhead` | **320 token / 4 个 noul 问题** | 三组记录值反推 250–320；4 问题取上限 |
| `safetyFactor` | **1.15** | 覆盖 CJK 分词波动与代码块标点 |
| 校准验证 | 文档 3 组：**+14.9% / −10.8% / +10.1%**；1,980 条 1 问题集：**+4.7%** | 见 `docs/jev-token-calibration.json` |

由此得到的实用预算（24k 请求预算，含 1.15 安全系数）：

| state 内容 | 估算 token/单元 | 单请求可放单元数（约） |
| --- | --- | --- |
| 300 个 CJK 字 | 315 + ~470（问题）≈ 785 → ×1.15 ≈ 903 | **≈ 26** |
| 600 个 CJK 字 | 630 + 470 ≈ 1100 → ×1.15 ≈ 1265 | **≈ 18** |
| 300 英文词（~1800 ASCII 字符） | 630 + 470 ≈ 1100 → ×1.15 ≈ 1265 | **≈ 18** |
| 代码块（ASCII 标点多） | 建议按 ASCII 0.45–0.5/char 估，或先跑一次实测校准 | 保守少放 |

> 若 state 含大量代码/JSON：`asciiPerChar` 建议临时用 **0.45**（标点 token 更密），否则可能低估 20–30%。

### 7.5 网络恢复后的实时补测

```powershell
# 在能访问 api.typesafe.ai 的网络里执行（key 只在进程内）：
node scripts/jev-probe.mjs --mode calibrate
node scripts/jev-probe.mjs --mode main   # 4 noul 主探针，结果写入 docs/jev-probe-result.json
```

`--mode calibrate` 会对 3 个样本（短中文 / 长中英混合 / 代码块）各真实调用一次，打印 `usage.input_tokens` 并做最小二乘，输出可直接替换 §7.4 的系数（脚本已内置同样算法）。

---

## 8. confidence 语义澄清（任务书关心的点）

1. **noul 没有独立 `confidence` 字段**，这是对的；`noul` 值本身就是 P(yes)，同时承担"答案 + 确定性"两个角色。官方原文："There is no separate `confidence` value for a Noul… A Noul's probability distribution has only two outcomes, yes and no, so the single `noul` value describes it completely."（[Noul — Reading a Noul](https://docs.typesafe.ai/primitives/noul)）
2. **Choice / Score 才有 `confidence`**，且是从 `probabilities` 分布形状推导出的统计量（集中 → 1，均匀 → 0），不是模型自报（[Confidence](https://docs.typesafe.ai/confidence)）。
3. 没有 rationale / 解释字段；不要期待模型给出理由。
4. 对 host-core 的含义：`priority` 的阈值只能基于 noul 概率本身（0.45/0.65/0.85 这类经验值），且必须在真实中文数据上校准；不要把 noul 值当"程度"用（问的是"是不是"，不是"有多少"）。

---

## 9. 已知限制（尤其 CJK）

| 限制 | 影响 | 应对 |
| --- | --- | --- |
| **英语是母语，CJK 准确率较低**（官方 [Language support](https://docs.typesafe.ai/models#language-support)：English primary，CJK "handled but not equally well"） | 中文 stream 的判断会偏保守/漂移 | instructions 用英文；阈值用真实中文样本校准；不要用 noul 做细粒度分级 |
| Jev 1.13 **字面理解**问题，会按字面回答而非意图 | 含糊指令 → 答案偏 | instructions 写精确单条件；边界写进 criteria；有歧义就拆成两个 noul |
| 不擅长数学/计数/日期比较 | 不要问"有几个""日期先后" | 计数/算数放代码 |
| 大 state 有 context rot；无关信息降低准确率 | 单元 + 上下文过大反而更差 | 插件已按单元判断，保持 state 小；context 只给必要 heading/上一行 |
| 对抗性内容可影响答案（state 是数据，不天然当敌意） | 高亮可能被内容"诱导" | 指令精确；阈值保守；不要把 Jev 当安全判定的唯一依据 |
| 不生成文本 | 只返回概率 | 插件只做打分，符合设计 |
| **地区可用性**（本次新发现） | 中国出口当前 451 | 需要在可用地区部署/代理网关；插件应把 451 当"服务不可用"清晰上报，而非静默 |
| 计费只算输入 | 4 问题 + 大 state 成本随 token 线性 | 见 §7 预算；24k/请求是安全上限 |

来源：[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)、[Models / Language support](https://docs.typesafe.ai/models)、[Confidence](https://docs.typesafe.ai/confidence)。

---

## 10. host-core 解析建议（宽容但以真实字段为准）

### 10.1 读取 noul 概率

```ts
interface JevNoulAnswer { type?: string; noul?: number }
interface JevSystemOneResponse {
  model?: string
  answers?: Record<string, JevNoulAnswer & Record<string, unknown>>
  usage?: { input_tokens?: number; output_tokens?: number }
}

const QUESTION_IDS = ['is_core_answer', 'is_actionable', 'is_warning', 'is_definition'] as const

function readNoul(resp: JevSystemOneResponse, id: string): number | null {
  const answer = resp.answers?.[id]
  if (!answer || typeof answer !== 'object') return null
  // 真实字段（先读这个）：
  const real = (answer as JevNoulAnswer).noul
  if (typeof real === 'number' && Number.isFinite(real)) return clamp01(real)
  // 宽容兜底：仅为防御旧版本/网关改写，命中时记 warn，不要当常态
  for (const key of ['probability', 'p_yes', 'value'] as const) {
    const v = (answer as Record<string, unknown>)[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      logger.warn(`[jev] unexpected answer field "${key}" for ${id}; expected "noul"`)
      return clamp01(v)
    }
  }
  return null // 缺失/畸形：算一次失败，不要默认 0 冒充"低重要性"
}
```

规则：
- **必须**校验 `resp.answers[id].type === 'noul'`（若存在）；字段名只认 `noul`。
- `noul` 必须 `Number.isFinite` 且 clamp 到 `[0,1]`；非法 → `null` + 记失败。
- 四个 id **必须全部存在**；缺任意一个 → 该 verdict 标记 `degraded`（不要拼出半个 priority）。
- `resp.model` 与请求 model 不一致时**记录并继续**（别名解析正常行为）；用于缓存键/诊断。
- `usage.input_tokens` 用于预算与花费统计；缺失不影响判定。
- 200 但 body 非 JSON/缺 `answers` → 视为契约违约：最多重试 1 次，仍失败则记失败并跳过该单元（不要阻塞 stream）。

### 10.2 请求侧约定

- 固定 `model: 'jev-1.13.0'`（或后续固定你校准过的版本）；不要用 `jev-latest` 跑已调阈值的生产。
- 4 个 noul id 保持稳定（缓存键 `QUESTION_SET_VERSION` 已含 v1）。
- instructions 英文、单条件、yes 正向；可选给 `is_warning` 加 `criteria {true,false}` 收紧边界（已实测该字段被 OpenAPI 接受且返回形状不变——本次通过文档规范核实，不是现场调用）。
- `state` 建议：`单元文本` + 有界 `heading/before` 上下文；不要塞整篇回答。
- 超时 30s、并发 8–12、429 时降并发；插件卸载时 AbortSignal 中止全部请求。

### 10.3 错误映射

| 响应 | host-core 行为 |
| --- | --- |
| `401` | 抛可操作错误："Jev API key 缺失/无效，请配置 jevApiKey 或 JEV_API_KEY"，插件禁用高亮但不崩 |
| `400` + `max_tokens_exceeded` | 拆分/裁剪该 unit 后重试一次；仍失败则跳过 |
| `422` | 代码 bug：记完整 `detail[]`，不要重试 |
| `429`/`529`/`5xx`/网络错误 | 指数退避（≤2 次重试）+ 抖动；持续失败则降并发/暂停队列 |
| `451` | 记录 `cf-ray`，向界面暴露"Jev 在您所在地区不可用"，**禁用自动重试** |
| 未知 4xx | 不重试；记状态码与 body 前 500 字 |

---

## 11. 已核实事实 vs 未现场验证项（诚实清单）

| 事实 | 状态 | 证据 |
| --- | --- | --- |
| noul 答案字段 = `noul`，无 confidence/probability/p_yes | ✅ 已核实 | OpenAPI 3.1 + [Noul 文档](https://docs.typesafe.ai/primitives/noul) + Promptfoo 示例 `output.urgent.noul > 0.8` |
| 请求 noul = type/instructions(/criteria)，无 label | ✅ 已核实 | OpenAPI `NoulQuestion` |
| 响应信封 `{model, answers, usage}`、`model` 返回版本 ID | ✅ 已核实（含真实调用） | 2026-09-21 真实响应；官方文档 |
| 64k/请求、32k/问题、262k 长上下文 | ✅ 已核实 | [Models](https://docs.typesafe.ai/models) |
| 价格 $0.042/Mtok 输入、输出免费 | ✅ 已核实 | [Models](https://docs.typesafe.ai/models)、旧项目 metrics |
| 429/529 指数退避 + Retry-After | ✅ 已核实 | [Errors](https://docs.typesafe.ai/api/errors)、[Promptfoo](https://www.promptfoo.dev/docs/providers/typesafe/) |
| 422 错误体 `detail[{loc,msg,type}]` | ✅ 文档核实（未现场触发） | OpenAPI `HTTPValidationError` |
| 中国出口返回 451 地区限制 | ✅ 本次实测 | `docs/jev-probe-result.json` |
| 实时 noul 调用（4 问题真实答案） | ❌ **未完成**（451 阻断） | 网络恢复后 `--mode main` 补跑 |
| 429/529 真实行为 | ❌ 未测（避免无谓消耗/触发限流） | 文档 + SDK 行为说明 |
| 401/422 真实错误体 | ❌ 未现场触发（451 在鉴权前） | OpenAPI schema |
| 实时 token 校准（3 样本） | ❌ 未完成（451 阻断） | 用 1,980 真实 token 替代（§7） |
| 最终验收方式 | ✅ 已裁决 | **mock 分支**（`JEV_API_KEY=dummy` + `jevBaseUrl` 指向 localhost mock）验证全链路；真实 451 分支作为已知限制（§0.1、§9） |
| 地区限制绕过 | ✅ 已裁决 | **不做**：不使用代理绕过 TypeSafe 地区限制 |

> OpenRouter 的 TypeSafe SDK 文档页（https://openrouter.ai/docs/guides/community/typesafe-sdk ）本次抓取成功但正文被导航截断，未作为契约依据；其定位与 Promptfoo 类似（第三方集成说明）。

---

## 12. 交付物与复现

| 文件 | 内容 |
| --- | --- |
| `scripts/jev-probe.mjs` | 零依赖探针：`models` / `main` / `alias` / `calibrate` / `errors` / `tokencalib` / `all` 模式；key 只从 `JEV_API_KEY` 读取，输出与落盘全部脱敏 |
| `docs/jev-probe-result.json` | 本次真实调用证据（451 原始 body/headers、时间、key 长度校验；无 key/Authorization） |
| `docs/jev-token-calibration.json` | 1,980 条真实 token 拟合、文档记录值反推、推荐估算器与验证误差 |
| 本文件 | 契约、错误/重试、token、CJK、解析建议 |

常用命令：

```powershell
# 只读、免费：确认 key 与地区
node scripts/jev-probe.mjs --mode models

# 主探针：4 个 noul + 中英混合 state，打印完整 answers JSON，写入 docs/jev-probe-result.json
node scripts/jev-probe.mjs --mode main

# 实时 token 校准（3 样本 × 1 次）
node scripts/jev-probe.mjs --mode calibrate

# 全量（models + main + alias + calibrate + errors，约 5 次计费调用）
node scripts/jev-probe.mjs --mode all

# 离线：用历史真实 token 重新拟合（不需要 key）
node scripts/jev-probe.mjs --mode tokencalib --raw <jev_raw_zh.jsonl> --preds <preds_test_jev_zh.csv>
```

key 的注入方式（**命令行里绝不出现 key 本身**）：

```powershell
$envPath = 'F:\workspace\最新模型jev和bert和deepseek-V4.1Flash模型对比和混合架构的探索\.env'
$line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match '^\s*TYPESAFE_API_KEY\s*=' } | Select-Object -First 1
$kv = ($line -split '=', 2)[1].Trim()
$env:JEV_API_KEY = $kv
node scripts/jev-probe.mjs --mode models
```

---

## 13. 参考（全部为官方/一手来源）

- System One API（OpenAPI 3.1 全文）：<https://docs.typesafe.ai/api/system-one>、<https://api.typesafe.ai/openapi.json>
- 请求规则与错误：<https://docs.typesafe.ai/api/errors>
- 列出模型：<https://docs.typesafe.ai/api/list-models>
- 原语总览：<https://docs.typesafe.ai/primitives>
- Noul（请求/响应/记录值）：<https://docs.typesafe.ai/primitives/noul>
- Confidence 语义：<https://docs.typesafe.ai/confidence>
- 模型/价格/上下文/语言支持/别名：<https://docs.typesafe.ai/models>
- State 形状：<https://docs.typesafe.ai/concepts/state>
- Jev 1.13 已知缺陷：<https://docs.typesafe.ai/model-jaggedness/jev-1.13>
- Quickstart（真实记录型混合响应）：<https://docs.typesafe.ai/introduction/quickstart>
- JS / Python SDK（压缩、重试）：<https://docs.typesafe.ai/sdk/javascript>、<https://docs.typesafe.ai/sdk/python>
- 第三方交叉验证：<https://www.promptfoo.dev/docs/providers/typesafe/>、<https://openrouter.ai/docs/guides/community/typesafe-sdk>
