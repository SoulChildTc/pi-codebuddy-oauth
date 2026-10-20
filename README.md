# pi-codebuddy-oauth

[![npm version](https://img.shields.io/npm/v/pi-codebuddy-oauth.svg)](https://www.npmjs.com/package/pi-codebuddy-oauth)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

为 [CodeBuddy](https://www.codebuddy.cn)（腾讯 IOA 编程助手）提供 [Pi](https://github.com/earendil-works/pi) 扩展，把 CodeBuddy 作为 **OpenAI 兼容 HTTP provider** 接入 Pi。

与 [pi-codebuddy-sdk](https://github.com/RealAlexandreAI/pi-codebuddy-sdk)（spawn `codebuddy` CLI 子进程 + MCP bridge）不同，本扩展走**轻量 HTTP 直连**（`/v2/chat/completions`）：协议栈复用 pi-ai 内置 `openai-completions`，扩展只负责鉴权、模型发现、动态头注入与瞬时故障重试。无 CLI 依赖、无子进程、无会话文件管理。

## 特性

- **OAuth 登录** — Pi 原生 `/login` 流程接入 IOA：`/v2/plugin/auth/state` → 浏览器 → 轮询 token。token 刷新由 Pi 双检锁托管（5 分钟 skew 预刷新）。
- **API Key 登录** — 设置 `CODEBUDDY_API_KEY`（`ck_xxx`）即可，无需浏览器。
- **自动模型发现** — 调用 `GET /v3/config` 提取 craft agent 模型列表（5 分钟 TTL 缓存 + 单飞；登录后自动触发）。
- **401/403 中途刷新重试** — 流式请求中 token 失效时自动刷新并重试一次（15 秒冷却防抖）。
- **瞬时 400（code 11133）自动重试** — CodeBuddy 网关偶发把上游瞬时校验失败包装成 HTTP 400 `{"code":11133}` 返回；拦截器按 **1s → 4s → 10s → 25s** 退避幂等重发（最多 4 次，总等待 ≤40s），其他 400 原样透传。
- **429 限流归一化** — 网关限流时只回状态码、body 为空（上层只能看到 `429 status code (no body)`），而 Pi 的 agent 级重试只看错误文案、不读 `Retry-After`，于是盲打 4 次。拦截器现在会读 `Retry-After(-ms)` / `X-RateLimit-Reset*`：提示在预算内就地等待并重发；否则合成可读 JSON body。窗口很远（提示超过 `CODEBUDDY_429_MAX_WAIT_MS`）时文案带 `quota exceeded`，命中 Pi 的不可重试判定 → 立即失败而不是连打。
- **泄漏思考归一化**（`src/reasoning-leak.ts`）— 部分模型（实测 hy4-preview）会把思考草稿直接混进 SSE 的 `delta.content`，并留下 `</think:会话id>` 模板闭合标记。pi-ai 只从 `reasoning_content` 建 thinking 块，于是整段自我复读被打印到终端、又被写回 transcript 强化下一轮。本模块在 SSE 层把标记之前的文本改写到 `delta.reasoning_content`，标记本身从流中删除。
- **session 级 `X-Conversation-ID` 稳定化** — 同一 Pi session 复用同一 conversation id，提升上游 prompt cache 命中率（compaction 时淘汰）。
- **环境自动切换** — 默认国内端点（`copilot.tencent.com`），`CODEBUDDY_NETWORK=internet` 切国际（`www.codebuddy.ai`），`CODEBUDDY_ENDPOINT` 覆盖完整 URL。

## 安装

```bash
pi install npm:pi-codebuddy-oauth
```

或本地路径开发调试：

```bash
pi install /path/to/pi-codebuddy-oauth
```

重启 `pi`，然后 `/model` → 选 `codebuddy/...`。

## 登录

**方式 1 — OAuth（推荐）**：

```
/login codebuddy
```

按提示在浏览器完成 IOA 登录，token 自动持久化。

**方式 2 — API Key**：

```bash
export CODEBUDDY_API_KEY=ck_xxx
```

## 环境变量

| 变量 | 默认 | 作用 |
| ---- | ---- | ---- |
| `CODEBUDDY_ENDPOINT` | _(空)_ | 完整 base URL 覆盖，优先级最高 |
| `CODEBUDDY_NETWORK` | `internal` | `internal`/`ioa` → 国内端点；其他 → 国际端点 |
| `CODEBUDDY_AUTH` | `auto` | `auto` / `oauth` / `api` |
| `CODEBUDDY_API_KEY` | _(空)_ | API Key（`ck_xxx`），`auto` 模式下隐含启用 API Key 模式 |
| `CODEBUDDY_MODEL` | _(空)_ | 强制覆盖请求 model（写进 `X-Model-ID`） |
| `CODEBUDDY_STABLE_CONVERSATION` | `1` | `0` 关闭 session 级 conversation-id 稳定化 |
| `CODEBUDDY_CONVERSATION_MAP_MAX` | `1000` | session → conversationId LRU 容量 |
| `CODEBUDDY_TENANT_ID` / `CODEBUDDY_ENTERPRISE_ID` / `CODEBUDDY_USER_ID` | _(从 JWT 提)_ | 覆盖自动提取的身份头（仅 OAuth 模式） |
| `CODEBUDDY_LEAKED_REASONING` | `1` | `0` 关闭泄漏思考归一化（SSE 层 content → reasoning_content 改写） |
| `CODEBUDDY_429_MAX_WAIT_MS` | `20000` | 429 就地等待上限；`Retry-After` 超过它就视为配额窗口，直接终态失败 |
| `CODEBUDDY_429_RETRIES` | `1` | 429 就地重发次数（不含首次请求）；设 `0` 表示完全交给 Pi 的 `retry.*` 策略 |

## 架构

```
Pi agent
  │ modelRuntime.streamSimple（auth 解析 / 凭据刷新）
  ▼
streamSimple wrapper（src/stream.ts）
  │ 注入 22 头（X-Conversation-ID 稳定化 / B3 / X-Model-ID …）
  │ 注入自定义 fetch
  ▼
auth-fetch 拦截器（src/auth-fetch.ts）
  │ 认证头注入（oauth: Bearer + 租户身份头 / api: Bearer + X-API-Key）
  │ 401/403 → 刷新 token 重试一次
  │ 400+11133 → 1s/4s/10s/25s 幂等重发
  ▼
${server}/v2/chat/completions   （协议栈：pi-ai openai-completions）
```

token 的过期预检与刷新由 Pi 原生托管（`oauth.refreshToken`，5 分钟 skew + 双检锁，自动持久化到 Pi 凭据存储）；扩展维护一份独立快照（`~/.pi/agent/codebuddy-auth.json`）供请求期读取，流中途 401 时快照兜底刷新。

| 模块 | 来源 |
| ---- | ---- |
| `auth-flow.ts` / `auth-state.ts` / `jwt.ts` / `headers.ts` / `lru.ts` / `fetch-json.ts` | 平移自 [opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) |
| `models.ts` | 平移 + 转换为 Pi `ProviderModelConfig` |
| `auth-fetch.ts` | 平移改造：删 SSE 缓冲与预刷新（Pi 原生托管） |
| `index.ts` / `stream.ts` | 新写：Pi extension 接线 |
| `model-cache.ts` | 新写：持久化模型列表，消除启动期发现竞态（见下） |

### 模型列表缓存

模型发现（`GET /v3/config`）是异步的，而会话恢复走同步路径。若会话在发现返回前恢复，
`codebuddy/<具体模型>` 尚未注册，pi 会报
`Warning: Could not restore model codebuddy/xxx (model no longer exists)` 并回落到 `auto`。

为此，扩展把上次成功发现的模型落盘到 `~/.pi/agent/codebuddy-models-cache.json`，
启动时先同步以缓存为种子注册，再等网络发现刷新缓存。缓存只影响「首个可见模型集合」的时机，
不替代网络发现：发现失败时仍回落到已缓存列表或 `auto`。

刻意不写入 `models.json`：codebuddy 是扩展注册的 provider，鉴权由 `auth-fetch` 拦截器注入
（自定义 `streamSimple`）。在 `models.json` 声明同 id 的原生 provider 会产生 baseUrl/api
双重定义并绕过拦截器，也会与 pi-model-manager 的跨进程锁相互干扰。

## 开发

```bash
npm install
npm test        # vitest
npm run typecheck
```

## 许可证

[MIT](./LICENSE) — © 2026 SoulChildTc；部分代码源自 [opencode-codebuddy-oauth](https://github.com/minglo/opencode-codebuddy-oauth) © 2026 Ming Lo (MIT)
