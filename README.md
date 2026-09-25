# dsh-peak-gate · 峰谷守门 / Peak-Gate

按 DeepSeek 的**峰谷分时计价**，在高峰时段给 token 花销踩刹车：大任务拦下、输出上限压缩、**并让模型少说废话**，还提供一键放行口令。

**English:** Based on DeepSeek's **peak / off-peak time-of-day pricing**, it puts the brakes on token spend during peak hours: big tasks get blocked, output limits get compressed, **and the model is told to stop waffling** — plus it ships a one-word force-pass token.

> ⚠️ **非官方插件**：与 DeepSeek / DeepSeek Harness 官方无关，是社区自研插件。
> 通过 web profile 的 `link:` 依赖挂载（见下方「安装」），**不是**从插件市场装的。
>
> ⚠️ **English:** **Unofficial plugin**: unaffiliated with DeepSeek / DeepSeek Harness; built by the community. It is mounted through a web-profile `link:` dependency (see "安装 / Installation" below) and is **not** installed from a plugin marketplace.

## 安装 / Installation

这是 **DSH（DeepSeek Harness）host 插件**（Node half，跑在宿主侧）—— 通过 web profile 的依赖 + bundle patch 挂载：
**English:** This is a **DSH (DeepSeek Harness) host plugin** (Node half, running on the host side) — mounted through a web-profile dependency + bundle patch:

1. 把源码放到 profile 的 vendor 目录：`<DSH_HOME>/profiles/web/vendor/dsh-peak-gate-src`
   **English:** Put the source into the profile's vendor directory: `<DSH_HOME>/profiles/web/vendor/dsh-peak-gate-src`
2. 在 `profiles/web/package.json` 里加两处：`dependencies` 填 `"dsh-peak-gate": "link:vendor/dsh-peak-gate-src"`；
   `dsh.profile.bundles` 列表里加上 `dsh-peak-gate`
   **English:** Add two things in `profiles/web/package.json`: set `dependencies` to `"dsh-peak-gate": "link:vendor/dsh-peak-gate-src"`; and add `dsh-peak-gate` to the `dsh.profile.bundles` list
3. `pnpm install`（或按你的 DSH 版本用等价的挂载方式），然后**重启 `dsh web`**
   **English:** `pnpm install` (or the equivalent mounting method for your DSH version), then **restart `dsh web`**
4. 配置命名空间 `peak-gate`；DSH 0.1.7+ 写在 `profiles/web/cordis.patch.yml` 的 `peak-gate:` 段，**热改即时生效，无需重启**
   **English:** The config namespace is `peak-gate`; on DSH 0.1.7+ write it under the `peak-gate:` section of `profiles/web/cordis.patch.yml` — **hot edits take effect immediately, no restart needed**

> 运行时依赖 DSH 自带的 `schemastery` 与 `@deepseek-ai/dsh-llm`，没有其它第三方包。
>
> **English:** At runtime it depends on DSH's own `schemastery` and `@deepseek-ai/dsh-llm`; there are no other third-party packages.

## 官方峰谷口径 / The Official Peak/Off-Peak Rules

来自 [DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing)（核对于 2026-09-11）
＋ [官方峰谷时间说明](https://www.ithome.com/0/100/4494.htm)（2026-09-19 补充）：
**English:** Taken from the [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing) (verified 2026-09-11) plus the [official peak/off-peak time note](https://www.ithome.com/0/100/4494.htm) (added 2026-09-19):

| 时段（**北京时间**） | 价格 |
|---|---|
| 周一至周五 **09:00–12:00**、**14:00–18:00** | 高峰 ×2 |
| 其余时间、**周末全天**、**中国法定节假日全天** | 空闲 ×1 |

**English:**

| Window (**Beijing time**) | Price |
|---|---|
| Mon–Fri **09:00–12:00**, **14:00–18:00** | peak ×2 |
| all other times, **the whole weekend**, **all Chinese statutory holidays** | off-peak ×1 |

- 空闲价 = 高峰价的一半（flash 输出：谷 `$0.6/M` vs 峰 `$1.2/M`）
  **English:** the off-peak price = half the peak price (flash output: off-peak `$0.6/M` vs peak `$1.2/M`)
- 判定走「UTC+8 位移后读 UTC 字段」，**不依赖本机时区**（本机时区/夏令时不可信）
  **English:** the decision works by "shifting by UTC+8, then reading the UTC fields" and **does not depend on the local machine's time zone** (the local time zone / DST are not trustworthy)
- 🗓️ **调休上班的周末也按空闲计费**（官方 2026-09-19 明确）⇒ 只看星期几，**没有"补班日恢复高峰"的反向逻辑**
  **English:** 🗓️ **A weekend worked as a make-up day is billed as off-peak too** (stated officially on 2026-09-19) ⇒ only the day of the week is inspected; there is **no reverse rule of "make-up workday ⇒ back to peak"**

### 🗓️ 法定节假日日历（2026-09-25 新增）/ 🗓️ Statutory Holiday Calendar (added 2026-09-25)

| 层 | 说明 |
|---|---|
| ① 联网 | `NateScarlet/holiday-cn`（按国务院公告生成，含 `isOffDay`），**三源按序**：jsDelivr → raw.githubusercontent → gh-proxy；只拉**当年**，超时 8s，单份响应上限 1 MB |
| ② 磁盘缓存 | `<DSH_HOME>/data/peak-gate/holidays-cn.json`，默认 30 天内不重复拉；**联网失败仍用旧缓存**（并告警） |
| ③ 内置兜底 | 代码里的 `DEFAULT_HOLIDAYS`（2026 全年），离线/首启可用 |
| ④ 自检 | **日级**：当年落在日历里的放假日 < 10 天（或日历项写错）⇒ **打日志告警**（绝不静默按工作日判峰）；每 12 小时自动核对一次 |

**English:**

| Layer | Description |
|---|---|
| ① Online | `NateScarlet/holiday-cn` (generated from State Council announcements, includes `isOffDay`), **three sources in order**: jsDelivr → raw.githubusercontent → gh-proxy; it only fetches the **current year**, with an 8 s timeout and a 1 MB cap per response |
| ② Disk cache | `<DSH_HOME>/data/peak-gate/holidays-cn.json`, not re-fetched within 30 days by default; **if networking fails the old cache is still used** (with a warning) |
| ③ Built-in fallback | `DEFAULT_HOLIDAYS` in the code (all of 2026), usable offline / on first start |
| ④ Self-check | **daily**: fewer than 10 holidays for that year present in the calendar (or a wrong calendar entry) ⇒ **log a warning** (never silently fall back to treating it as a workday when judging peak); re-verified automatically every 12 hours |

**数据质量校验**：单年放假日数必须在 **15 ~ 45 天**之间（防半截响应 / 防"全年都放假"把闸门 fail-open）；
文档里**不属于该年**的日期一律不算数；同年数据合并是**取并集**（只增不减，半截响应不会覆盖完整数据）；
缓存 `fetchedAt` 落在未来 ⇒ 判损坏并重新拉取（防"永久冻结"）。

**English:** **Data-quality validation**: the number of holidays in a single year must be between **15 and 45 days** (guards against truncated responses / against an "everything is a holiday" response flipping the gate to fail-open); dates in the document that **do not belong to that year** are never counted; merging data for the same year is a **union** (add-only, never shrink, so a truncated response cannot overwrite complete data); a cache whose `fetchedAt` lies in the future ⇒ treated as corrupt and re-fetched (guards against "permanent freeze").

🗓️ **调休上班日也算谷价日**：国家标定的补班日（如 `2026-10-10` 周六）**无条件**按空闲计费 ——
与 `weekendOffPeak` 开关**无关**。缓存里的 `workdays` 与内置 `DEFAULT_MAKEUP_DAYS` 都会并进日历。

**English:** 🗓️ **A make-up workday also counts as an off-peak day**: a nationally designated make-up workday (e.g. Saturday `2026-10-10`) is **unconditionally** billed as off-peak — **independent of** the `weekendOffPeak` switch. Both the `workdays` in the cache and the built-in `DEFAULT_MAKEUP_DAYS` are merged into the calendar.

配置项：`holidays`（**追加**的日历，默认即内置表）、`useBuiltinHolidays`（是否并入内置表，收窄时置 false）、
`autoHolidayCalendar`（关掉联网）、`holidayCalendarUrls`、`holidayCacheMaxAgeDays`、`holidayFetchTimeoutMs`、`holidayCachePath`。
**English:** Config options: `holidays` (a calendar to **append**, defaulting to the built-in table), `useBuiltinHolidays` (whether to merge the built-in table in; set it to false when narrowing), `autoHolidayCalendar` (turn networking off), `holidayCalendarUrls`, `holidayCacheMaxAgeDays`, `holidayFetchTimeoutMs`, `holidayCachePath`.

⚠️ 想「收窄到只认自己写的几天」：`holidays: []` ＋ `useBuiltinHolidays: false` ＋ `autoHolidayCalendar: false` 三件一起做。
**English:** ⚠️ To "narrow it down to only the few days you wrote yourself": do all three together — `holidays: []` + `useBuiltinHolidays: false` + `autoHolidayCalendar: false`.

⚠️ 该日历同时被**右下角的余额挂件**（`dsh-whale-widget`）读取，两边口径必须一致（挂件侧历史分桶有 2026-09-19 生效分界，插件侧没有 —— 这是有意为之）。
**English:** ⚠️ This calendar is also read by the **balance widget in the bottom-right corner** (`dsh-whale-widget`), and the two sides must agree on the rules (the widget's historical bucketing has a 2026-09-19 effective boundary, the plugin side does not — that is intentional).

## 五个着力点 / Five Levers

| # | 位置 | 干什么 |
|---|---|---|
| 1 | `agent/pre-step` | 峰时拦**重活**（默认用短提示顶替，见下）；判定分三层，见下节 |
| 2 | `agent/pre-step`（续跑步骤） | **峰时工具预算**：单轮工具步数超限就地停下，不加模型请求 |
| 3 | `agent/request` | 峰时把 `maxTokens` 压到上限 |
| 4 | `systemPrompt` 段 `peak:brevity` | **峰时要求模型精简输出** —— 拦任务是止损，让它少说废话才是从源头省输出 token |
| 5 | `officialProviders` 白名单 | 默认全管；填了名单就只对自家官方路由生效，不误伤中转渠道 |

**English:**

| # | Hook | What it does |
|---|---|---|
| 1 | `agent/pre-step` | blocks **heavy work** during peak (by default replacing it with a short notice, see below); the decision has three layers, see the next section |
| 2 | `agent/pre-step` (continuation steps) | **peak tool budget**: stops in place once a single turn exceeds its tool-step budget, without adding a model request |
| 3 | `agent/request` | compresses `maxTokens` down to the cap during peak |
| 4 | `systemPrompt` section `peak:brevity` | **asks the model to output concisely during peak** — blocking tasks limits the damage, but making it stop waffling is what saves output tokens at the source |
| 5 | `officialProviders` allow-list | manages everything by default; once the list is filled in it only applies to your own official routes, so relay channels are not hit by mistake |

⚠️ **生死线**：`pre-step` 在每个 step 都会跑，工具循环中间的 step 是 `messages.length === 0`。
判断「这是不是重活」时只在 `messages.length > 0`（真正有新输入）时进行，**绝不把工具循环当用户输入拦**；
续跑步骤只走第 2 条的工具预算，走的是一条独立的、可一键关掉（`peakMaxSteps: 0`）的规则。

**English:** ⚠️ **Hard line:** `pre-step` runs on every step, and a step in the middle of a tool loop has `messages.length === 0`. The "is this heavy work?" judgement is only made when `messages.length > 0` (there really is new input); **a tool loop is never mistaken for user input and blocked**. Continuation steps go only through lever 2's tool budget — an independent rule that can be switched off with a single setting (`peakMaxSteps: 0`).

## v2 的三层判定（2026-09-11 新增）/ v2's Three-Layer Decision (added 2026-09-11)

需求：「峰时只能解一些数学题等短的东西，或者只是问一下天气，**写程序太伤了**」
→ 所以峰时按「这活儿重不重」决定拦不拦，而不是只看输入大小。

**English:** The requirement: "at peak it can only handle short things like math problems, or just asking about the weather, **writing programs hurts too much**" → so at peak, whether to block is decided by "how heavy is this job", not merely by how big the input is.

| 层 | 做什么 | 成本 | 兜底 |
|---|---|---|---|
| 1. 白名单直通 | 命中 `lightKeywords` 且输入不长 → 直接放行 | 0 | —— |
| 2. 模型分类 | 白名单没命中、输入够长 → 花一次**极短**调用问「heavy 还是 light」 | ~几十 token | 超时/报错/认不出 → **按 light 放行** |
| 3. 工具预算 | 峰时单轮 `step > peakMaxSteps` → 就地停下 | 0（不发模型请求） | 任何异常 → 放行保平安 |

**English:**

| Layer | What it does | Cost | Fallback |
|---|---|---|---|
| 1. Allow-list pass-through | matches `lightKeywords` and the input is short → pass straight through | 0 | —— |
| 2. Model classification | allow-list missed and the input is long enough → spend one **extremely short** call asking "heavy or light" | ~a few dozen tokens | timeout / error / unrecognisable → **pass it through as light** |
| 3. Tool budget | at peak, a single turn where `step > peakMaxSteps` → stop in place | 0 (no model request sent) | any exception → pass through and stay safe |

**第 1 层刻意只判「轻」、不设黑名单**：不靠词表猜「这像不像写程序」，
「重不重」交给第 2 层的模型判断，词表只用来省掉那些明显不用分类的短问句。

**English:** **Layer 1 deliberately only recognises "light" and has no blacklist**: it does not use a word list to guess "does this look like programming"; "is it heavy" is left to layer 2's model judgement, and the word list only exists to skip short questions that obviously need no classification.

**第 2 层怎么调用的**：走 `ctx.get('llm').prepareCall()`（官方公开路径且**完全绕开
`llm/stream` 这个 waterfall**），所以既不会把自己再拦一次、也不污染主请求链路。
调用时只带 `provider` / `model` / 一条 user 消息 / `maxTokens: 6`，并用 `AbortSignal.timeout`
限时；识别 `a`（light）/ `b`（heavy）两个字母，认不出就放行。

**English:** **How layer 2 makes the call**: it goes through `ctx.get('llm').prepareCall()` (the official public path, and it **bypasses the `llm/stream` waterfall entirely**), so it neither blocks itself a second time nor pollutes the main request chain. The call carries only `provider` / `model` / one user message / `maxTokens: 6`, and is time-limited with `AbortSignal.timeout`; it recognises the two letters `a` (light) / `b` (heavy), and passes through if it cannot tell.

⚠️ **分类调用必须关掉推理**（`classifierReasoningEffort: 'off'`，默认值）：会话默认
`reasoningEffort: high` 会**开思考**，思考 token 会把 `maxTokens: 6` 吃光 —— 答案一个字母都
吐不出来，于是每次都走「分类未定 → 放行」，看起来像分类器根本没生效
（**2026-09-11 真机实测踩到**）。若某路由不支持 `off`，插件会自动退回默认档、并把上限放大到
32 token 重试一次。

**English:** ⚠️ **The classification call must have reasoning turned off** (`classifierReasoningEffort: 'off'`, the default): the session default `reasoningEffort: high` **enables thinking**, and thinking tokens eat up all of `maxTokens: 6` — not a single letter of the answer comes out, so every attempt lands on "classification undecided → pass through", which looks as though the classifier were not working at all (**hit in a real-machine test on 2026-09-11**). If some route does not support `off`, the plugin automatically falls back to the default level and retries once with the limit raised to 32 tokens.

**第 3 层停下时长什么样**：不发任何模型请求，直接把一条提示**写进会话**
（`session.append('user/message', …)`，与 agent loop 自己落消息同款），界面立刻可见；
然后返回 **`{kind:'reject'}`** 结束本轮。

**English:** **What layer 3 stopping looks like**: it sends no model request at all; it writes a notice **straight into the session** (`session.append('user/message', …)`, the same call the agent loop itself uses to record messages), so it is visible in the UI immediately; then it returns **`{kind:'reject'}`** to end the turn.

> 🩸 曾经以为「返回空 messages 就能让本轮自然收尾」—— **真机实测是错的**。
> `dsh-agent-loop` 的闸门是 `if (turnEnds && decision.messages.length === 0) break`，
> 而工具循环里 `turnEnds` 始终是 `null` ⇒ 空 messages 被忽略，照样发一次满历史请求、
> 模型继续干活（会话记录里可见：提示之后又跑了 22 次工具调用）。
> 宿主里唯一能真正结束本轮的就是 `reject`（`turnEnds = {kind:'blocked'}` + `return false`）。
> 代价：本轮不会有 `turn/end`，界面上本轮也没有模型收尾（提示已把原因写在会话里）。
>
> **English:** 🩸 It was once assumed "returning empty messages lets the turn wrap up naturally" — **a real-machine test proved that wrong**. `dsh-agent-loop`'s gate is `if (turnEnds && decision.messages.length === 0) break`, and inside a tool loop `turnEnds` is always `null` ⇒ the empty messages are ignored, a full-history request is still sent, and the model keeps working (visible in the session record: after the notice it ran 22 more tool calls). The only thing in the host that really ends the turn is `reject` (`turnEnds = {kind:'blocked'}` + `return false`). The cost: this turn produces no `turn/end`, and there is no model sign-off in the UI for that turn either (the notice has already written the reason into the session).

**生死线不是 `messages.length > 0`**：宿主会把 `source.kind === 'plugin'` 的内容注入进
`messages`（默认启用的 `dsh-repeat-tool-reminder` 就会这么干），所以判据是
`hasUserInput()`（只要有「非插件来源」的消息才算用户的新输入），否则工具提醒会被
误当成用户请求去分类、甚至被拦截提示顶替掉。

**English:** **The hard line is not `messages.length > 0`**: the host injects content with `source.kind === 'plugin'` into `messages` (the default-enabled `dsh-repeat-tool-reminder` does exactly this), so the real test is `hasUserInput()` (only messages from a "non-plugin source" count as new user input); otherwise a tool reminder would be mistaken for a user request, get sent to the classifier, and even be replaced by the block notice.

## 拦截方式（`onBlock`）/ How It Blocks (`onBlock`)

| 值 | 行为 | 成本 | 体验 |
|---|---|---|---|
| `replace`（默认） | 用一条短提示顶替掉这次大请求 | 省 95%+ | 用户能立刻看到「被拦了 + 怎么放行」 |
| `reject` | 该轮直接 `blocked`，一个 token 都不发 | 零 | 界面静默，原因只进日志 |

**English:**

| Value | Behaviour | Cost | Experience |
|---|---|---|---|
| `replace` (default) | replaces this big request with a short notice | saves 95%+ | the user immediately sees "it was blocked + how to force it through" |
| `reject` | blocks the turn outright, not one token is sent | zero | the UI stays silent, the reason only goes to the log |

## 一键放行 / One-Word Force Pass

消息里带 **`!force`**（可配 `forceToken`）即无条件放行 —— 急事不用改配置。
注意：`!force` **整轮生效** —— 既放行这次请求，也关掉本轮的工具预算（这样长任务才跑得完）。
`peakMaxSteps: 0` 是彻底关掉第 3 层的开关。

**English:** Putting **`!force`** in a message (configurable via `forceToken`) passes it through unconditionally — no need to edit the config for something urgent.
Note: `!force` **applies to the whole turn** — it passes this request and also switches off this turn's tool budget (that is what lets a long task finish).
`peakMaxSteps: 0` is the switch that turns layer 3 off entirely.

## 配置 / Configuration

命名空间 `peak-gate`，写在 `~/.dsh/profiles/web/cordis.patch.yml`，**热改即时生效，无需重启**：
**English:** The namespace is `peak-gate`, written in `~/.dsh/profiles/web/cordis.patch.yml`; **hot edits take effect immediately, no restart needed**:

```yaml
peak-gate:
  enabled: true
  mode: block                       # block 真拦 | notify 只提醒 | off 关闭
  peakWindows: ['09:00-12:00', '14:00-18:00']   # 北京时间
  beijingOffsetMinutes: 480         # UTC+8
  weekendOffPeak: true
  officialProviders: []             # 空 = 所有 provider 都管；填 ['deepseek-official'] 则只管网关外的官方路由
  brevitySection: true              # 峰时注入「精简输出」提示段
  bigTaskTokens: 6000               # 本次新输入估算超过它 = 大任务（只算新输入，不算会话历史）
  bigTaskChars: 20000               # 字符数兜底
  sessionPressureTokens: 0          # >0 时：会话上下文压力超它也算大任务（默认关）

  # —— 第 1 层：白名单直通（只判轻，没有黑名单） ——
  lightKeywords: [算一下, 计算, 求解, 解方程, 数学, 证明, 天气, 几点, 是什么, 为什么, 解释一下, 翻译, …]
  lightKeywordMaxChars: 120         # 输入超过这么多字符就不认白名单

  # —— 第 2 层：模型分类 ——
  useModelClassifier: true          # 关掉就退回「只看输入大小」
  classifierProvider: ''            # 留空 = 用本会话上一次请求的 provider
  classifierModel: ''               # 留空 = 用本会话上一次请求的 model
  classifierTimeoutMs: 3000         # 超时按轻活放行
  classifierMaxTokens: 6            # 只够吐一个字母
  classifierReasoningEffort: off    # 必须关推理：否则思考会吃光上面那 6 个 token，答案吐不出来
  classifierMinChars: 20            # 短于它就不花这次调用
  classifierMinTokens: 15

  # —— 第 3 层：工具预算 ——
  peakMaxSteps: 12                  # 峰时单轮工具步数预算；0 = 关掉这条

  forceToken: '!force'
  peakMaxTokens: 32768              # 峰时主 agent 输出上限，0 = 不限
  subagentMaxTokens: 16384
  manageSubagents: true             # 是否管子代理（输出上限 + 是否拦）
  blockSubagents: false             # 是否真拦子代理的大任务（默认不拦，免得主任务断掉）
  onBlock: replace                  # replace | reject
  warnOncePerSession: true          # 仅 reject 方式有意义
  dryRun: false                     # 只记日志不真拦
```

想调「多严」就动这三处：`useModelClassifier`（要不要模型判）、`peakMaxSteps`（工具预算）、
`classifierMinChars`（多长的输入才值得花一次分类）。

**English:** To tune "how strict" it is, touch these three: `useModelClassifier` (whether the model judges at all), `peakMaxSteps` (the tool budget), and `classifierMinChars` (how long an input must be to be worth one classification).

想看自己的 provider 叫什么？日志里每次拦截都会打印 `provider=...`，照着填白名单即可。

**English:** Want to know what your provider is called? Every block prints `provider=...` in the log; just copy that into the allow-list.

## 验证 / Verification

先跑离线自测（155 项）：/ Run the offline self-test first (155 cases):

```powershell
# 离线自测（155 项）：依赖 DSH 提供的 schemastery / @deepseek-ai/dsh-llm，
# 所以要在 <DSH_HOME>/profiles/web/node_modules 的解析链内运行
cd <DSH_HOME>/profiles/web/vendor/dsh-peak-gate-src
node test/selftest.mjs
```

真机侧怎么确认插件生效（实测结论）：**`ctx.logger` 的输出不落盘**（`<DSH_HOME>/logs/` 里没有 `peak-gate` 目录），
所以别去翻插件日志，看这两处即可：

**English:** How to confirm on a real machine that the plugin is live (a measured conclusion): **`ctx.logger` output is not written to disk** (there is no `peak-gate` directory under `<DSH_HOME>/logs/`), so do not go digging through plugin logs — just look at these two places:

| 看哪里 | 期望 |
|---|---|
| GUI「插件」页里 `dsh-peak-gate` 的开关 | **已启用** |
| 宿主启动日志 `<DSH_HOME>/dsh-web-launcher.err.log` | **0 字节**（无加载报错） |

**English:**

| Where to look | What to expect |
|---|---|
| the `dsh-peak-gate` switch on the GUI "Plugins" page | **enabled** |
| the host startup log `<DSH_HOME>/dsh-web-launcher.err.log` | **0 bytes** (no load errors) |

加载成功时宿主控制台会打印
`peak-gate: 峰谷守门 v2 已加载（mode=…，峰窗=…，精简段=…，白名单 N 词，模型分类=…，工具预算=… 步，自动日历=…）`。

**English:** On a successful load the host console prints
`peak-gate: 峰谷守门 v2 已加载（mode=…，峰窗=…，精简段=…，白名单 N 词，模型分类=…，工具预算=… 步，自动日历=…）`.

## 卸载 / 回滚 / Uninstall / Rollback

```powershell
cd ~/.dsh/profiles/web
Copy-Item package.json.bak-peakgate-<timestamp> package.json -Force   # 恢复改动前的 package.json / restore the previous package.json
pnpm install      # 重新解析依赖 / re-resolve dependencies
# 然后重启 dsh web / then restart dsh web
```

## 设计参考 / Design References

写这个插件时参考了市场里几个同类插件的做法（[awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)）：
**English:** This plugin's design references how a few similar plugins in the marketplace do it ([awesome-dsh-plugin.com](https://awesome-dsh-plugin.com)):

| 插件 | 借鉴了什么 |
|---|---|
| `dsh-peak-cost-mode` | 峰时注入「精简输出」提示段（caveman 模式）；`systemPrompt.section` 的 text 用函数动态求值 |
| `dsh-peak-block` | 只精确匹配 `deepseek-official` 判定官方、避免误伤中转；时区走 UTC+8 数学换算 |
| `dsh-peak-indicator` | 按事件时间戳分时段计价的口径意识 |

**English:**

| Plugin | What was borrowed |
|---|---|
| `dsh-peak-cost-mode` | injecting a "be concise" prompt section during peak (caveman mode); evaluating `systemPrompt.section`'s text dynamically with a function |
| `dsh-peak-block` | matching only `deepseek-official` exactly to identify the official route, avoiding false hits on relays; doing the time zone with UTC+8 arithmetic |
| `dsh-peak-indicator` | awareness of pricing windows based on event timestamps |

## 已知限制 / Known Limitations

- **任务量是估算**：按字符类型粗估（ASCII ÷ 3.6，非 ASCII × 0.75）。够分级，不适合对账。
  **English:** **Task size is an estimate**: a rough estimate by character class (ASCII ÷ 3.6, non-ASCII × 0.75). Good enough for classifying, not for accounting.
- **模型分类要多花一次调用**：每次判定 heavy/light 约几十 token（`maxTokens: 6`）。相比拦下一次
  写程序的工具循环（动辄上万 token）可以忽略，但它确实是「每条够长的输入都问一次」的成本模型；
  想省就调高 `classifierMinChars` / 调低 `useModelClassifier`。
  **English:** **Model classification costs one extra call**: each heavy/light decision is about a few dozen tokens (`maxTokens: 6`). Next to blocking one program-writing tool loop (easily tens of thousands of tokens) that is negligible, but it really is a cost model of "ask once for every input that is long enough"; to save, raise `classifierMinChars` / turn down `useModelClassifier`.
- **停下的那一轮没有模型收尾**：第 3 层是「不发请求、直接落提示」，所以用户看到的是进度停住 +
  一条说明，而不是模型自己写的总结。要继续就带 `!force` 重发，或把 `peakMaxSteps` 调大。
  **English:** **The turn that gets stopped has no model sign-off**: layer 3 is "send no request, drop a notice instead", so what the user sees is progress halting plus an explanation, not a summary written by the model. To carry on, resend with `!force`, or raise `peakMaxSteps`.
- **`reject` 方式界面静默**：被拦的消息不进会话记录，会看到"发出去没反应"。默认的 `replace` 没这问题。
  **English:** **The `reject` mode is silent in the UI**: the blocked message does not enter the session record, so it looks like "sent but nothing happened". The default `replace` does not have this problem.
- **不做记账**：目前只在日志里记拦截次数，没有「今天省了多少钱」的面板。要做需要订阅 `llm/stream`
  采真实 usage + 落盘 + client 半边（市场里 `dsh-peak-cost-mode` 是完整形态，可参考）。
  **English:** **No accounting**: for now it only records the number of blocks in the log; there is no "how much did I save today" panel. Building one would mean subscribing to `llm/stream` to sample real usage + persisting it + a client half (marketplace plugin `dsh-peak-cost-mode` is a complete form of this, worth referencing).
- **精简段会让 KV cache 失效一次**：峰谷切换时 system prompt 变化，会丢一次前缀缓存。一天只切 4 次，可接受。
  **English:** **The brevity section invalidates the KV cache once**: switching between peak and off-peak changes the system prompt, so one prefix cache is lost. It only switches 4 times a day, which is acceptable.
- 只认 **DeepSeek 官方 API 的计价口径**；走第三方网关时用 `officialProviders` 排除，或自己改 `peakWindows`。
  **English:** It only recognises the **pricing rules of the official DeepSeek API**; when going through a third-party gateway, exclude it with `officialProviders`, or change `peakWindows` yourself.

## 运行环境 / Requirements

- **DSH（DeepSeek Harness）≥ `0.1.7-rc.2`** —— `package.json` 里 `dsh.compatibility.dshReleases` 声明为 `compatible`；本仓在该版本上实测通过。
- **Node.js ≥ 20** —— `package.json` 的 `engines.node`；本机在 **Node 24** 上实测通过。
- **运行依赖：无**。代码用到 `schemastery` 与 `@deepseek-ai/dsh-llm`，两者**均由 DSH 宿主提供**（见 `peerDependencies`），本仓不随包安装任何第三方运行依赖。
- **可选联网**：默认会去取法定节假日日历（可关，见「配置」里的 `autoHolidayCalendar`）；关掉后走内置兜底表。

**English:**
- **DSH (DeepSeek Harness) ≥ `0.1.7-rc.2`** — declared `compatible` in `package.json`'s `dsh.compatibility.dshReleases`; verified on that release.
- **Node.js ≥ 20** — see `engines.node` in `package.json`; verified on **Node 24** here.
- **Runtime dependencies: none**. The code uses `schemastery` and `@deepseek-ai/dsh-llm`; both are **provided by the DSH host** (see `peerDependencies`).
- **Optional networking**: by default it fetches the statutory-holiday calendar (can be turned off via `autoHolidayCalendar` under "Configuration"); with networking off it falls back to the built-in table.

## 权限与依赖 / Permissions & Dependencies

> 本节如实描述本插件对系统的接触面，按「保守」口径写：**没查到的地方不写成"不访问"**。
> **English:** This section describes, in a deliberately conservative way, what this plugin touches on the system. Where something could not be verified, it is **not** claimed to be "not accessed".

**这是 DSH（DeepSeek Harness）宿主插件**：它是 Node half，**跑在 `dsh web` 宿主进程内**，通过 profile 的 bundle patch 挂进来，**不单独起进程、不开端口、不注册系统服务**。因此它与宿主同权限 —— 宿主能读写的，它理论上也能；下面列的是它**代码里实际会碰**的部分（代码可逐行审计）。

**English:** **This is a DSH (DeepSeek Harness) host plugin**: it is a Node half that **runs inside the `dsh web` host process**, mounted through a profile bundle patch. It **starts no separate process, opens no port and installs no system service**. It therefore shares the host's privileges — anything the host can read or write, it could in principle too; listed below is what its **code actually touches** (the code is short enough to audit line by line).

| 接触面 | 实际情况 |
|---|---|
| **文件（读）** | 读 DSH 的插件配置（由宿主 settings 服务提供，命名空间 `peak-gate`）与节假日缓存；**不主动扫描/读取你的工作文件**。 |
| **文件（写）** | 只写节假日缓存一个文件：默认 `<DSH_HOME>/data/peak-gate/holidays-cn.json`（可用 `holidayCachePath` 改到别处）。 |
| **网络** | **默认开启**节假日日历更新：只按顺序请求三个源（jsDelivr → raw.githubusercontent → gh-proxy），只拉**当年**的日历 JSON，单源超时 8 s、响应上限 1 MB。可用 `autoHolidayCalendar: false` 或 `holidayCalendarUrls: []` **完全关掉联网**。除此之外不发起任何网络请求。 |
| **外部命令** | **不调用**任何外部命令 / shell / 子进程；**不需要** root / 管理员权限。 |
| **凭据** | **不读取、不存储**任何凭据（不读环境变量里的 API key、不读凭据文件）。第 2 层的分类调用复用**宿主已经配置好的** LLM 路由，鉴权由 DSH 负责；日志里可能打印 provider / model 名，不含密钥。 |
| **生命周期脚本** | **无**：`package.json` 没有 `scripts`，没有 `postinstall` 之类的安装期脚本。 |
| **已知风险** | ① 峰时它会**主动改变你的请求**（默认用一条短提示顶替大请求）⇒ 先用 `dryRun: true` 或 `mode: notify` 观察；② 节假日日历来自第三方镜像源，插件已做质量校验（15~45 天、年份归属、并集合并、1 MB 上限、时间戳未来判损坏），但**不能保证第三方源不被篡改**；③ 分类与"重活"判定是启发式的，**可能误判**（设计上宁可放行）；④ 它跑在宿主进程内，与宿主同权限。 |

**English:**

| Surface | What actually happens |
|---|---|
| **Files (read)** | Reads the DSH plugin config (supplied by the host `settings` service, namespace `peak-gate`) and the holiday cache; it does **not** scan or read your project files. |
| **Files (write)** | Writes exactly one file: the holiday cache, by default `<DSH_HOME>/data/peak-gate/holidays-cn.json` (relocatable via `holidayCachePath`). |
| **Network** | Holiday-calendar updates are **on by default**: it requests three sources in order (jsDelivr → raw.githubusercontent → gh-proxy), fetching only the **current year's** calendar JSON, with an 8 s per-source timeout and a 1 MB response cap. Networking can be **turned off entirely** with `autoHolidayCalendar: false` or `holidayCalendarUrls: []`. It makes no other network requests. |
| **External commands** | Calls **no** external command, shell or subprocess; **requires no** root / administrator privileges. |
| **Credentials** | Reads and stores **no** credentials (no API keys from environment variables, no credential files). Layer 2's classification call reuses the LLM route the **host is already configured with**; authentication is DSH's business. Logs may print provider / model names, never secrets. |
| **Lifecycle scripts** | **None**: `package.json` has no `scripts` field and no `postinstall`-style install hooks. |
| **Known risks** | ① During peak it **actively alters your requests** (by default replacing a big request with a short notice) ⇒ observe it first with `dryRun: true` or `mode: notify`. ② The holiday calendar comes from third-party mirrors; the plugin validates it (15–45 days, year ownership, union merge, 1 MB cap, future timestamps treated as corrupt) but **cannot guarantee a third-party source is untampered**. ③ The classifier / "heavy work" decision is heuristic and **can misjudge** (by design it prefers to let things through). ④ It runs inside the host process and therefore shares the host's privileges. |
