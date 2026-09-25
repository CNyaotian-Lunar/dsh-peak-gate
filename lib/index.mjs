/**
 * dsh-peak-gate · Node half（host 侧）
 *
 * 「峰谷守门」：按 DeepSeek 的峰谷分时计价，在**高峰时段**给用户的 token 花销踩刹车。
 *
 * 官方口径（核对于 2026-09-11，api-docs.deepseek.com/quick_start/pricing；
 * 2026-09-25 补充核对 https://www.ithome.com/0/100/4494.htm ）：
 *   高峰 = 工作日**北京时间** 09:00-12:00、14:00-18:00；
 *   其余为空闲，空闲价 = 高峰价的一半。
 *   🗓️ **调休上班的周末、中国法定节假日全天均按空闲时段计费** ——
 *   判定见 `lib/holidays.mjs`：放假日表来自联网缓存（holiday-cn，按国务院公告生成），
 *   离线兜底用内置表；调休上班的周末**仍按空闲**，所以没有"补班日"反向逻辑。
 *
 * v2 的目标（需求）：
 *   「峰时只能解一些数学题等短的东西，或者只是问一下天气，**写程序太伤了**」
 *   → 峰时按「任务重不重」决定拦不拦，而不是只看输入大小。
 *
 * 五个着力点：
 *
 * 1. `agent/pre-step`（用户输入进入模型之前）
 *    - **只在 `messages.length > 0` 时判定**。这一点是生死线：pre-step 在每个 step 都会跑，
 *      工具循环中间的 step 是 `messages.length === 0`，拦了就会把用户的任务拦腰砍断。
 *    - 空闲时段：直接 `next()`，零开销、零影响。
 *    - **第 1 层（零成本白名单）**：命中 `lightKeywords`（算/解方程/天气/翻译…）且输入不长 → 放行。
 *      不设关键词黑名单 —— 判定重活交给第 2 层模型，不靠词表猜。
 *    - **第 2 层（模型分类）**：白名单没命中、输入又够长够复杂 → 花一次**极短**的分类调用问
 *      「heavy 还是 light」；heavy 才拦。超时/出错/任何异常一律按 light 放行（宁可漏拦不可卡住）。
 *    - 已拦截的提示：默认 `onBlock: 'replace'` 用一条极短提示「顶替」这次大请求，用户看得见原因。
 *    - 消息里出现放行口令（默认 `!force`）：无条件放行。
 *
 * 2. `agent/pre-step` 的**工具预算**（v2 新增，真正掐住「写程序」）
 *    - 峰时单轮（一个 turn）里 `step` 超过 `peakMaxSteps` → 工具循环到此为止。
 *    - 不加任何模型请求（最省钱）：把一条提示**直接写进会话**（`session.append('user/message')`，
 *      与 agent loop 自己落消息的方式一致，界面看得见），再返回 `{ kind: 'reject' }` 真正结束本轮。
 *      ⚠️ 返回**空 messages 停不住** turn（工具循环里 `turnEnds` 恒为 null）⇒ 详见 `stepBudget` 的说明。
 *    - 阈值与开关都进 settings，热改即时生效；`0` = 关闭这条。
 *
 * 3. `agent/request`（每次模型请求前，可改 provider/model/maxTokens/reasoningEffort）
 *    - 高峰时把 `maxTokens` 压到上限，避免峰时一次跑飞。
 *
 * 4. `systemPrompt` 提示段（`peak:brevity`）
 *    - 峰时向模型注入「精简输出」要求 —— 拦任务是止损，让模型少说废话才是从源头省输出 token。
 *      思路借鉴市场插件 dsh-peak-cost-mode 的 caveman 模式。
 *
 * 5. `officialProviders` 白名单
 *    - 默认空 = 所有 provider 都管；只对这些 provider 生效可避免误伤不按官方峰谷计价的中转渠道。
 *
 * 配置命名空间 `peak-gate`，settings 里热改即时生效。
 */
import z from 'schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_HOLIDAYS,
  DEFAULT_HOLIDAY_URLS,
  DEFAULT_CACHE_MAX_AGE_DAYS,
  beijingDateKey,
  holidayCachePath,
  holidayCoverageWarning,
  invalidHolidaySpecs,
  isHolidayDate,
  resolveHolidayCalendar,
} from './holidays.mjs'

export const name = 'peak-gate'

/** settings 必装；tokenMeter / systemPrompt / llm 走 ctx.get 兜底，缺失也不影响插件加载。 */
export const inject = ['settings']

/**
 * 官方高峰窗口（**北京时间**小时，左闭右开）。
 * 官方口径：工作日 09:00-12:00、14:00-18:00；周末与法定节假日全天谷价。
 */
const DEFAULT_PEAK_WINDOWS = ['09:00-12:00', '14:00-18:00']

/** DeepSeek 计价按北京时间（UTC+8，无夏令时）。 */
const DEFAULT_OFFSET_MINUTES = 480

/**
 * 第 1 层默认白名单：命中即直接放行（**不开模型分类**，零延迟零成本）。
 *
 * 这些词只在**输入本身不长**（`lightKeywordMaxChars`）时才算数 —— 免得一段长任务描述里
 * 顺带出现「翻译」两个字就整条放行。**不要黑名单**：
 * 「这是不是重活」交给第 2 层的模型判断，不靠词表猜。
 */
const DEFAULT_LIGHT_KEYWORDS = [
  '算一下', '算算', '计算', '求解', '解方程', '数学', '证明', '推导',
  '天气', '气温', '下雨', '几点', '现在时间', '日期',
  '是什么', '什么是', '为什么', '解释一下', '翻译', '念一下', '读一下',
]

/** 第 1 层白名单判定时，输入最多这么长（字符）才算「短问句」。 */
const LIGHT_KEYWORD_MAX_CHARS = 120

/**
 * 会话压力**高**时，短到多少字符也值得走一次分类。
 * 一次分类调用（几十 token）远比重发一遍长上下文便宜，所以压力高时宁可多问一次。
 */
const MIN_CLASSIFY_CHARS_UNDER_PRESSURE = 6

/** 第 2 层分类调用的上限输出 token（只要一个字母或一个词就够）。 */
const CLASSIFIER_MAX_TOKENS = 6

/**
 * 第 2 层分类提示词。
 *
 * 要点：① 只有一次、极短；② 输入截断到 500 字；③ 只认 `a` / `b`，把 token 花在判断上；
 * ④ **明确「答不上来就选 b」** —— 宁可放行也不误拦（用户干活优先）。
 */
const CLASSIFIER_PROMPT = [
  '你在给一个 AI 编程助手做「峰时成本闸门」分类。现在是 DeepSeek 高峰计价时段（价格翻倍）。',
  '判断下面这条用户请求，会不会让助手进入多轮工具调用（反复读文件/写代码/跑命令/装依赖/调试）？',
  'a = 不会：单轮问答即可（闲聊、常识、数学、翻译、解释概念、问天气时间…）。',
  'b = 会：需要动手改东西（写/改代码、脚本、调试、部署、爬虫、装环境、批量处理文件…）。',
  '只输出一个小写字母：a 或 b。拿不准就输出 b。',
  '--- 请求 ---',
]

/**
 * 第 3 层：峰时工具预算耗尽时的会话提示。
 * `%s` 会被替换成 `peakMaxSteps`；`%s` 的口令由调用方拼。
 */
function budgetNoticeText(maxSteps, forceToken) {
  return [
    '【峰谷守门·工具预算已用完】',
    `现在是 DeepSeek 高峰时段（价格 = 空闲的 2 倍），这一轮已经跑了 ${maxSteps} 步工具调用，已按规则在此停下。`,
    '刚才的进度都在会话里，没有丢。',
    `要继续：带上 \`${forceToken}\` 重发，峰时也不拦。`,
  ].join('\n')
}

/**
 * 解析 `HH:MM-HH:MM` 形式的窗口；不合法则丢弃（宁可少拦，不可误拦）。
 * @param {string} spec - 形如 `09:00-12:00`。
 * @returns {{start: number, end: number} | undefined} 以小时为单位的浮点区间。
 */
function parseWindow(spec) {
  const matched = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(spec).trim())
  if (matched === null) return undefined
  const startHour = Number(matched[1])
  const startMinute = Number(matched[2])
  const endHour = Number(matched[3])
  const endMinute = Number(matched[4])
  // 分钟必须 < 60：否则 `'09:70-12:00'` 会被静默当成 10:10（对抗性测试发现）
  if (startMinute > 59 || endMinute > 59) return undefined
  const start = startHour + startMinute / 60
  const end = endHour + endMinute / 60
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return undefined
  return { start, end }
}

/**
 * 当前是否处于高峰时段。
 *
 * 口径与官方一致：把时刻按 `offsetMinutes` 位移后读 UTC 字段，得到的即是「北京时间」，
 * 因此**不依赖本机时区设置**（本机时区/夏令时不可信）。
 *
 * 🗓️ 节假日口径（官方 2026-09 补充）：**调休上班的周末、法定节假日全天均按空闲计费** ⇒
 * ① 命中 `calendar`（法定放假日）→ 全天不判峰；
 * ② 周六/周日 → 全天不判峰，**包括调休上班的周末**（所以这里只看星期几，
 *    绝不要加什么"补班日恢复高峰"的反向逻辑）。
 *
 * @param {number} timeMs - 判定时刻（毫秒时间戳）。
 * @param {string[]} windows - 北京时间窗口描述。
 * @param {boolean} weekendOffPeak - 周末是否全天算空闲。
 * @param {number} offsetMinutes - 北京时区偏移，默认 +480。
 * @param {unknown} calendar - 法定节假日日历（`YYYY-MM-DD` 或 `A~B` 闭区间串数组），
 *   默认内置表；插件的自动日历（联网/缓存）由调用方合并后传入。
 * @returns {boolean} true 表示高峰。
 */
export function isPeakNow(timeMs, windows, weekendOffPeak, offsetMinutes = DEFAULT_OFFSET_MINUTES, calendar = DEFAULT_HOLIDAYS) {
  const shifted = new Date(Number(timeMs) + offsetMinutes * 60000)
  const day = shifted.getUTCDay()
  // ① 法定节假日：全天谷价。
  if (isHolidayDate(beijingDateKey(timeMs, offsetMinutes), calendar)) return false
  // ② 周末（含调休上班的周末）：全天谷价。
  if (weekendOffPeak && (day === 0 || day === 6)) return false
  const hours = shifted.getUTCHours() + shifted.getUTCMinutes() / 60 + shifted.getUTCSeconds() / 3600
  for (const spec of windows) {
    const window = parseWindow(spec)
    if (window === undefined) continue
    if (window.start < window.end) {
      if (hours >= window.start && hours < window.end) return true
    } else if (hours >= window.start || hours < window.end) {
      // 跨零点窗口（例如 22:00-02:00）
      return true
    }
  }
  return false
}

/**
 * 当前北京时间（用于日志与提示展示）。
 * @param {number} timeMs - 毫秒时间戳。
 * @param {number} offsetMinutes - 时区偏移。
 * @returns {string} 形如 `09/11 15:04`。
 */
export function beijingLabel(timeMs, offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const shifted = new Date(Number(timeMs) + offsetMinutes * 60000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(shifted.getUTCMonth() + 1)}/${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

/** 真实用户消息的 `source.kind` 白名单（判据演进见下方 `hasUserInput` 的长注释）。 */
const USER_KINDS = new Set(['user'])

/**
 * 判断本步的 `messages` 里**有没有用户的新输入**。
 *
 * 🩸 判据演进（**两次真机教训**，别改回去）：
 *
 * ① 2026-09-11 对抗性测试：旧判据是 `messages.length === 0`，但**宿主会把非用户内容塞进
 *    `messages`** —— 例如 `dsh-repeat-tool-reminder` 经 `tools/post-execute` 的
 *    `additionalContexts` 注入一条 `source.kind === 'plugin'` 的提醒
 *    （`dsh-agent-loop` 的 `inbox.splice('next-step', …)`），于是工具循环中间的续跑步骤
 *    也非空 ⇒ 会被误当成用户输入去跑模型分类（多花钱）、并清掉 `!force` 的整轮豁免。
 *
 * ② 2026-09-12 对抗性审查修正（基于真实会话日志实测）：
 *    ① 留下的「非 plugin 即用户」是**黑名单**，而真实会话里 `source.kind` 有 **11 种**
 *    （`user` / `plugin` / `agent-instructions` / `agent-message` / `subagent-settled` /
 *    `goal` / `tool` …），只有 `plugin` 被排除 ⇒ 两类注入会被误判成「用户新输入」：
 *      - **goal 自动轮消息**（`kind:'goal'`，源码 `dsh-goal-round-driver/lib/index.js:136`）
 *      - **AGENTS.md 等规则重注入**（`kind:'agent-instructions'`，
 *        `dsh-agent-instructions/lib/index.js:1201`）
 *    峰时这两类会被判成「重活」并按 `onBlock:'replace'` **整个替换掉** ⇒
 *    goal 续跑被静默暂停、规则注入丢失，且界面上看不出原因。
 *
 * ⇒ 现在只认**白名单** `source.kind === 'user'`（真用户消息实测就是它，142 个会话里 401 条）。
 *   没有 `source` 的夹具/注入**不再**当用户输入 —— 宁可漏判，不可误判。
 *
 * @param {ReadonlyArray<{source?: {kind?: string}}> | undefined} messages - 本步待准入的消息。
 * @returns {boolean} true 表示这一步有用户的新输入。
 */
export function hasUserInput(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false
  return messages.some((message) => USER_KINDS.has(message?.source?.kind))
}

/**
 * 只取**来源是用户**的消息纯文本（用于 `!force` 这类口令识别）。
 *
 * 🩸 为什么不能扫全文（2026-09-11 对抗性审查发现）：`agent/pre-step` 的 `messages` 里
 * 除了用户输入，还有宿主注入的 runtime context（被读文件的内容、工具结果等）。
 * 用 `textOf(messages)` 扫口令，等于「随便哪个文件里出现 `!force` 就豁免整轮大任务+工具预算」。
 * 拿不到任何 `source.kind === 'user'` 时（例如测试夹具）退回全文，保持旧行为。
 *
 * @param {ReadonlyArray<{content?: ReadonlyArray<{type: string, text?: string}>, source?: {kind?: string}}>} messages
 * @returns {string} 仅用户来源的文本。
 */
export function userTextOf(messages) {
  const parts = []
  let sawUser = false
  for (const message of messages ?? []) {
    if (message?.source?.kind !== 'user') continue
    sawUser = true
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return sawUser ? parts.join('\n') : textOf(messages)
}

/**
 * 粗估一段文本的 token 数。
 * 只用于「这活儿大不大」的分级判断，不追求精算：ASCII 约 3.6 字符/token，非 ASCII 约 0.75 token/字符。
 * @param {string} text - 待估文本。
 * @returns {number} 估算 token 数。
 */
export function estimateTokens(text) {
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    if (ch.codePointAt(0) < 128) ascii += 1
    else wide += 1
  }
  return Math.ceil(ascii / 3.6) + Math.ceil(wide * 0.75)
}

/**
 * 拼接一条或多条 user message 里的纯文本。
 * @param {ReadonlyArray<{content?: ReadonlyArray<{type: string, text?: string}>}>} messages - 本步待准入的消息。
 * @returns {string} 合并后的文本。
 */
export function textOf(messages) {
  const parts = []
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 下一个「空闲时段」的北京时间可读提示，给用户一个明确的等待建议。
 * @param {number} timeMs - 当前毫秒时间戳。
 * @param {string[]} windows - 北京时间高峰窗口。
 * @param {boolean} weekendOffPeak - 周末是否全天算空闲。
 * @param {number} offsetMinutes - 时区偏移。
 * @param {boolean} isPeak - 当前是否真的处于高峰（调用方传 `isPeakNow` 的结果）。
 * @param {unknown} calendar - 法定节假日日历（见 `isPeakNow`）。
 * @returns {string} 例如「今天 18:00 之后」。
 */
export function nextOffPeakHint(timeMs, windows, weekendOffPeak, offsetMinutes = DEFAULT_OFFSET_MINUTES, isPeak = true, calendar = DEFAULT_HOLIDAYS) {
  const shifted = new Date(Number(timeMs) + offsetMinutes * 60000)
  const day = shifted.getUTCDay()
  const hours = shifted.getUTCHours() + shifted.getUTCMinutes() / 60
  const parsed = windows.map(parseWindow).filter((window) => window !== undefined)
  if (parsed.length === 0) return '空闲时段'
  const fmt = (value) => {
    const hh = String(Math.floor(value) % 24).padStart(2, '0')
    const mm = String(Math.round((value - Math.floor(value)) * 60)).padStart(2, '0')
    return `${hh}:${mm}`
  }
  const isWorkday = day >= 1 && day <= 5
  // 🗓️ 法定节假日：全天谷价，直接说「现在」。
  // （节假日可能落在周三 —— 不短路的话会走下面的 `isWorkday` 分支，劝用户"等到 09:00"，
  //   等于劝人关掉正在进行的免费工作。）
  if (isHolidayDate(beijingDateKey(timeMs, offsetMinutes), calendar)) {
    return '现在就是谷价时段（法定节假日全天半价）'
  }
  // 🩸 现实可能是「现在已经是谷价」：这时绝不能劝用户"再等等"。
  // （旧版只判 `hours < window.end`，于是周三 13:00、周六全天都会返回未来时刻，
  // 等于劝用户关掉正在进行的免费工作。）
  if (!isPeak) {
    const firstStart = parsed.length > 0 ? Math.min(...parsed.map((w) => w.start)) : Number.POSITIVE_INFINITY
    if (isWorkday && hours < firstStart) return `今天 ${fmt(firstStart)} 之前`
    return '现在就是谷价时段'
  }
  // 此刻还在某个高峰窗口内 → 给这个窗口结束的时刻（含跨零点窗口）。
  const endings = parsed
    .filter((window) => {
      if (window.start < window.end) return hours >= window.start && hours < window.end
      return hours >= window.start || hours < window.end
    })
    .map((window) => window.end)
    .sort((a, b) => a - b)
  if (endings.length > 0) return `北京时间今天 ${fmt(endings[0])}`
  if (day === 5) return '周末（周六 00:00 起全天都是谷价）'
  if (day === 6 || day === 0) return '周一 09:00 高峰来临之前'
  return '下一个高峰窗口结束之后'
}

/**
 * 取当前会话的上下文压力（tokenMeter 可用时）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} agent - 当前 agent。
 * @returns {number} 会话累计 token；拿不到返回 0。
 */
function sessionTokens(ctx, agent) {
  try {
    const meter = ctx.get('tokenMeter')
    if (meter === undefined || agent?.session === undefined) return 0
    const measured = meter.measure(agent.session)
    return typeof measured?.totalTokens === 'number' ? measured.totalTokens : 0
  } catch {
    // 计量失败绝不影响主流程：大不了这次按「只估输入」来判。
    return 0
  }
}

/**
 * 峰时注入模型的「精简输出」提示段。
 *
 * 思路借鉴市场插件 dsh-peak-cost-mode 的 caveman 模式：拦任务只是止损，
 * 让模型**少说废话**才是从源头省输出 token。措辞保持简洁克制，要点一致 ——
 * 省的是风格，技术内容一个字都不许删。
 */
const BREVITY_SECTION = [
  '## 峰谷守门 · 峰时精简模式（当前生效）',
  '',
  '现在是 DeepSeek 高峰计价时段（价格 = 空闲时段的 2 倍），dsh-peak-gate 已开启峰时精简输出：',
  '- 输出精简：去掉客套、铺垫、重复与填充词，能短则短；没被要求的总结和回顾不要写。',
  '- 语言不变：中文问就中文答，压缩的是篇幅，不是语言。',
  '- 技术内容一字不改：代码、命令、API 名、文件名、路径、精确报错、数字、版本号，原样保留。',
  '- 少用装饰：不主动加表情、分隔线、大段表格；除非用户明确要求文档类输出。',
  '- 安全例外：安全警告、不可逆操作确认、多步骤操作顺序必须说清楚，不得因精简产生歧义。',
].join('\n')

/**
 * 取当前会话已记录的请求路由（provider/model）。
 *
 * `agent/pre-step` 的 payload 里没有 provider，只能从会话已落盘的请求头里读上一次的 —— 用于
 * `officialProviders` 白名单判断，以及给第 2 层分类调用挑 provider/model。
 * 拿不到就返回 undefined（视为「不限制」，宁可多管不可漏管）。
 *
 * @param {object} agent - 当前 agent。
 * @returns {{provider?: string, model?: string} | undefined} 路由信息。
 */
function currentRoute(agent) {
  try {
    const header = agent?.session?.requestHeader?.()
    return header?.config ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 按 `officialProviders` 白名单判断该 provider 是否在管辖范围内。
 * @param {string[]} allowList - 白名单；空数组表示全管。
 * @param {string | undefined} provider - 当前 provider 名。
 * @returns {boolean} true 表示要管。
 */
export function providerManaged(allowList, provider) {
  if (!Array.isArray(allowList) || allowList.length === 0) return true
  if (typeof provider !== 'string' || provider === '') return true
  return allowList.includes(provider)
}

/**
 * 第 1 层：白名单直通判定。
 *
 * **只判「轻」不判「重」** —— 不设关键词黑名单。
 * 命中返回命中的那个词（便于日志与自测断言），没命中返回 undefined。
 * 只要输入超过 `maxChars`，一律不算命中（避免长任务描述里顺带出现「翻译」就整条放行）。
 *
 * @param {string} text - 本次新输入的纯文本。
 * @param {string[]} keywords - 白名单词表。
 * @param {number} maxChars - 白名单生效的最大输入长度。
 * @returns {string | undefined} 命中的关键词。
 */
export function lightKeywordHit(text, keywords, maxChars = LIGHT_KEYWORD_MAX_CHARS) {
  if (typeof text !== 'string' || text === '') return undefined
  if (!Array.isArray(keywords) || keywords.length === 0) return undefined
  if (text.length > maxChars) return undefined
  const lowered = text.toLowerCase()
  for (const keyword of keywords) {
    if (typeof keyword !== 'string' || keyword === '') continue
    if (lowered.includes(keyword.toLowerCase())) return keyword
  }
  return undefined
}

/**
 * 第 2 层：解析分类模型的回答。
 *
 * 约定模型只吐一个字母（a = light / b = heavy），但**不能信它听话**：
 * 这里同时接受 heavy/light 单词与「重/轻」字样。认不出来返回 undefined（调用方按 light 放行）。
 *
 * @param {string} raw - 模型输出原文。
 * @returns {'heavy' | 'light' | undefined} 判定结果。
 */
export function parseClassifierVerdict(raw) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().toLowerCase()
  if (text === '') return undefined
  if (/(^|[^a-z])b([^a-z]|$)/.test(text) || text.includes('heavy')) return 'heavy'
  if (/(^|[^a-z])a([^a-z]|$)/.test(text) || text.includes('light')) return 'light'
  if (text.includes('重')) return 'heavy'
  if (text.includes('轻')) return 'light'
  return undefined
}

/**
 * 第 3 层：峰时工具预算判定（纯函数，方便自测）。
 *
 * 只对**本轮内**的续跑步骤（`messages` 为空、`step > 0`）生效：
 * `step` 是 agent loop 里 turn 内的步序号，从 1 开始；因此 `step > maxSteps` 即「预算已用完」。
 * 用户输入那一步 `messages` 不为空，永远不会走到这里。
 *
 * @param {object} input - 判定输入。
 * @param {number} input.step - 本步序号（1 起）。
 * @param {number} input.messageCount - 本步待准入的消息数（0 = 续跑步骤）。
 * @param {number} input.maxSteps - 本轮工具步数预算（<=0 表示关闭）。
 * @param {boolean} [input.alreadyStopped] - 本会话本轮是否已经停过一次（避免重复提醒）。
 * @param {boolean} [input.forceExempt] - 本轮用户消息带过 `!force`（整轮豁免）。
 * @returns {boolean} true 表示该停。
 */
export function overStepBudget({ step, messageCount, maxSteps, alreadyStopped = false, forceExempt = false }) {
  if (forceExempt) return false
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) return false
  if (messageCount !== 0) return false
  if (!Number.isFinite(step) || step <= 0) return false
  // 小数预算按向下取整算：`peakMaxSteps: 0.5` 不该在第 1 步就停。
  const limit = Math.floor(maxSteps)
  if (limit <= 0) return false
  // 「超过预算」永远是唯一条件；`alreadyStopped` 只是**上限保护**：
  // 用户热改把 `peakMaxSteps` 调大后，本会话若还留着上一轮的标记，也不该被立刻判停。
  // （旧版 `if (alreadyStopped) return true` 优先级过高，会把新一轮的第一步直接停掉。）
  if (alreadyStopped && step <= limit) return false
  return step > limit
}

/**
 * 判断一个分类调用的失败是否属于「超时/被中止」 —— 这类失败重试等于白等一个超时。
 *
 * adapter 可能原样抛 `TimeoutError` / `AbortError`，也可能包成 `LlmError('ABORTED')`，
 * 所以名字、code、消息三种特征都认一遍。
 *
 * @param {unknown} error - 捕获到的异常。
 * @returns {boolean} true 表示是中止类失败。
 */
function looksAborted(error) {
  const name = error?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError') return true
  const code = error?.code ?? error?.cause?.code ?? ''
  if (code === 'ABORTED' || code === 'TIMEOUT') return true
  return /abort|timeout|timed out/i.test(String(error?.message ?? ''))
}

/**
 * 构造一条用户可见的 plugin notice。
 * @param {string} text - 通知正文。
 * @returns {object} user message。
 */
function notice(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:peak-gate', plugin: 'peak-gate', form: 'notice', summary: text },
  })
}

/** 新版（0.1.7+）配置面：profile 条目 config 的 schema（设置页表单与 profile 配置段迁移共用）。 */
export const Config = z.object({
      /** 总开关。 */
      enabled: z.boolean().default(true),
      /** `block` 真拦｜`notify` 只提醒不拦｜`off` 等同关闭。 */
      mode: z.union([z.const('block'), z.const('notify'), z.const('off')]).default('block'),
      /** 高峰窗口（**北京时间**），官方口径 09:00-12:00、14:00-18:00。 */
      peakWindows: z.array(z.string()).default(DEFAULT_PEAK_WINDOWS),
      /** 北京时区偏移（分钟）。官方计价按北京时间，默认 +480。 */
      beijingOffsetMinutes: z.number().default(DEFAULT_OFFSET_MINUTES),
      /**
       * 周末全天算空闲。🗓️ **含"调休上班的周末"** —— 官方 2026-09 明确
       * 「调休上班的周末、中国法定节假日全天均按空闲时段计费」，所以**别**在这里
       * 加"补班日恢复成高峰"的反向逻辑。
       */
      weekendOffPeak: z.boolean().default(true),
      /**
       * 法定节假日日历（**北京时间**日期，全天按空闲计费）。支持 `YYYY-MM-DD` 单日与
       * `YYYY-MM-DD~YYYY-MM-DD` 闭区间。
       *
       * ⚠️ 语义：这一项是**追加**进最终日历的，默认值就是内置兜底表。
       * 想「收窄到只认自己写的几天」要三件一起做：`holidays: []`（清掉默认）
       * ＋ `useBuiltinHolidays: false` ＋ `autoHolidayCalendar: false`。
       */
      holidays: z.array(z.string()).default(DEFAULT_HOLIDAYS),
      /**
       * 是否把**内置兜底日历**（`DEFAULT_HOLIDAYS`，2026 全年）并进最终日历。
       * 默认 `true`（最不容易漏）；只有"想收窄"时才关（配合上面两项，见 `holidays` 注释）。
       */
      useBuiltinHolidays: z.boolean().default(true),
      /**
       * 是否自动联网更新法定节假日日历（`NateScarlet/holiday-cn`，按国务院公告生成，含 `isOffDay`）。
       * 关掉也照样能用：走磁盘缓存 + `holidays` 兜底。
       */
      autoHolidayCalendar: z.boolean().default(true),
      /** 日历源模板（`{year}` 替换成 4 位年份）；按顺序尝试，全失败才降级。 */
      holidayCalendarUrls: z.array(z.string()).default(DEFAULT_HOLIDAY_URLS),
      /** 日历缓存最长可用天数：超过就先联网刷新；联网失败仍用旧缓存**并告警**。 */
      holidayCacheMaxAgeDays: z.number().default(DEFAULT_CACHE_MAX_AGE_DAYS),
      /** 单个日历源的超时（毫秒）。 */
      holidayFetchTimeoutMs: z.number().default(8000),
      /**
       * 日历缓存路径；留空 = `<DSH_HOME>/data/peak-gate/holidays-cn.json`。
       * 一般不用改（自测 / 影子环境用来隔离）。
       */
      holidayCachePath: z.string().default(''),
      /**
       * 只对这些 provider 生效（精确匹配）。默认空数组 = **所有 provider 都管**。
       * 若用户走的是第三方中转（不按官方峰谷计价），填上自己的官方路由名可避免误拦；
       * 官方路由名见日志里打印的 `provider=...`。
       */
      officialProviders: z.array(z.string()).default([]),
      /** 峰时给模型注入「精简输出」提示段，从源头省输出 token。 */
      brevitySection: z.boolean().default(true),
      /** 本次新输入的估算 token 超过它 = 大任务。只算「新输入」，不算会话历史。 */
      bigTaskTokens: z.number().default(6000),
      /** 本次新输入的字符数超过它 = 大任务（兜底，防止估算失真）。 */
      bigTaskChars: z.number().default(20000),
      /** 会话上下文压力超过它也算大任务；0 = 不启用这条。 */
      sessionPressureTokens: z.number().default(0),

      // —— v2 第 1 层：白名单直通（不含黑名单） ——
      /** 覆盖默认白名单词表（整段替换，不是追加）。命中且输入不长 → 直接放行。 */
      lightKeywords: z.array(z.string()).default(DEFAULT_LIGHT_KEYWORDS),
      /** 白名单生效的最大输入长度（字符）；超长的一律不走白名单。 */
      lightKeywordMaxChars: z.number().default(LIGHT_KEYWORD_MAX_CHARS),

      // —— v2 第 2 层：模型分类（重活判定） ——
      /** 开关：白名单没命中时，是否花一次极短模型调用来判 heavy/light。 */
      useModelClassifier: z.boolean().default(true),
      /** 分类用 provider；留空 = 用该会话上一次请求的路由 provider。 */
      classifierProvider: z.string().default(''),
      /** 分类用 model；留空 = 用该会话上一次请求的路由 model（最省事、一定可用）。 */
      classifierModel: z.string().default(''),
      /** 分类调用超时（毫秒）；超时按 light 放行（宁可漏拦，不可卡住用户）。 */
      classifierTimeoutMs: z.number().default(3000),
      /** 分类调用最多输出多少 token（只够吐一个字母）。 */
      classifierMaxTokens: z.number().default(CLASSIFIER_MAX_TOKENS),
      /**
       * 分类调用的推理档位。**默认 `off`** ——
       * 会话默认是 `high`，推理 token 会把 `classifierMaxTokens` 吃光，导致一个字母都拿不到
       * （2026-09-11 真机踩过）。填 `''` = 跟随会话默认档。
       */
      classifierReasoningEffort: z.string().default('off'),
      /** 输入短于这么多字符就不费一次分类调用，直接放行。 */
      classifierMinChars: z.number().default(20),
      /** 输入估算 token 低于它就跳过分类调用，直接放行。默认 15 ≈ 20 个中文字。 */
      classifierMinTokens: z.number().default(15),

      // —— v2 第 3 层：峰时工具预算 ——
      /**
       * 峰时单轮（turn）最多跑多少步工具调用；超了就地停下。**0 = 关闭这条**。
       * 停下时不发模型请求，只把一条提示写进会话，用户在界面上看得见。
       */
      peakMaxSteps: z.number().default(12),

      /** 一键放行口令，出现在消息里即无条件放行。 */
      forceToken: z.string().default('!force'),
      /** 峰时单次请求输出上限（主 agent）。0 = 不限制。 */
      peakMaxTokens: z.number().default(32768),
      /** 峰时单次请求输出上限（子代理）。 */
      subagentMaxTokens: z.number().default(16384),
      /** 是否连子代理 / workflow 一起管。 */
      manageSubagents: z.boolean().default(true),
      /**
       * 拦截方式：
       * - `replace`：用一条极短提示顶替掉这次大请求。仍要花一次小请求（约 200 token），
       *   但用户能立刻看见「被拦了 + 怎么放行」，体验最好 —— 默认值。
       * - `reject`：该轮直接 blocked，一个 token 都不发。极限省钱，但界面是静默的，
       *   原因只写进日志（`~/.dsh/logs/`）。
       */
      onBlock: z.union([z.const('replace'), z.const('reject')]).default('replace'),
      /**
       * 是否连子代理的大任务也一起拦。默认 **false**：峰时子代理只压输出上限、不拦 ——
       * 因为子代理常常是用户交代的任务自己派出去干活的，拦了会让主任务半路断掉。
       */
      blockSubagents: z.boolean().default(false),
      /** 每个会话只「告知」一次，之后静默拒绝（仅 `reject` 方式下有意义）。 */
      warnOncePerSession: z.boolean().default(true),
      /** 只记日志不真拦。 */
      dryRun: z.boolean().default(false),
    })

/**
 * 新版（0.1.7+）settings.register 被移除后的 scope 替身。
 * 旧代码只依赖 scope.get()（读当前配置），这里把 profile 条目 config 作为唯一来源；
 * 配置变更由 profile patch 触发热重载（重新 apply），因此 watch 是空实现。
 */
class ConfigFallbackScope {
  constructor(config) {
    this.raw = config !== null && typeof config === 'object' ? config : {}
  }
  get() {
    try {
      return Config(this.raw)
    } catch (_error) {
      return this.raw
    }
  }
  watch() {
    return () => {}
  }
}

export function apply(ctx, config) {
  const settingsService = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
  const canRegister = settingsService !== undefined && typeof settingsService.register === 'function'
  const scope = canRegister ? settingsService.register('peak-gate', Config) : new ConfigFallbackScope(config)

  /**
   * 🗓️ 自动节假日日历（联网 / 磁盘缓存拿到的放假日，已合并成区间串）。
   * `undefined` = 还没拿到 —— 此时只用 `config.holidays`（内置兜底表）判定。
   */
  let autoHolidays

  /** 最终生效的日历 = 手动配置项（兜底/覆盖）+ 自动日历。 */
  const effectiveHolidays = (config) => [
    ...(Array.isArray(config.holidays) ? config.holidays : []),
    ...(autoHolidays ?? []),
  ]

  /** 峰时判定统一出口 —— 所有调用点都走它，避免哪一处漏传日历（漏了就会把节假日当工作日判峰）。 */
  const peakNow = (config, timeMs = Date.now()) =>
    isPeakNow(timeMs, config.peakWindows, config.weekendOffPeak, config.beijingOffsetMinutes, effectiveHolidays(config))

  /**
   * 谷时建议文案：峰时给「窗口结束时刻」，谷时直接说「现在」。
   *
   * 不传这个标志时旧行为是恒返回未来时刻 —— 周三 13:00（谷价中）会劝用户"等到 18:00"，
   * 等于劝用户关掉正在进行的免费工作（2026-09-11 对抗性审查发现）。
   */
  const offPeakHint = (config, timeMs) =>
    nextOffPeakHint(
      timeMs,
      config.peakWindows,
      config.weekendOffPeak,
      config.beijingOffsetMinutes,
      peakNow(config, timeMs),
      effectiveHolidays(config),
    )

  // —— 🗓️ 节假日日历：自动更新 + 覆盖自检 ——
  /** 正在进行的刷新（防并发重复拉取）。 */
  let holidayRefreshing
  /** 已自检过的「日期键 + 日历指纹」，同一份日历只喊一次。 */
  let calendarChecked = ''
  /** 缓存路径：默认 `<DSH_HOME>/data/peak-gate/holidays-cn.json`；配置项可覆盖（自测隔离用）。 */
  const configuredCachePath = scope.get()?.holidayCachePath
  const holidayCache = typeof configuredCachePath === 'string' && configuredCachePath !== '' ? configuredCachePath : holidayCachePath()

  /**
   * 覆盖自检：① 有没有解析不了的日历项 ② 当前年是否被日历覆盖。
   *
   * 为什么必须有：节假日表逐年更新（国务院每年 11 月前后公布次年安排）。漏更新时若一声不吭，
   * 插件会**静默**把法定节假日当工作日判峰、白白多拦用户的活 —— 用户对"静默失效"零容忍。
   */
  const checkHolidayCalendar = (config) => {
    const calendar = effectiveHolidays(config)
    // 指纹用 JSON.stringify（**单射**）：旧版 `calendar.join(',')` 会让 `['a','b']` 与 `['a,b']`
    // 撞成同一个指纹，把「有 N 条解析不了」的告警静默压掉。
    const signature = `${beijingDateKey(Date.now(), config.beijingOffsetMinutes)}|${JSON.stringify(calendar)}`
    if (signature === calendarChecked) return
    calendarChecked = signature
    const bad = invalidHolidaySpecs(calendar)
    if (bad.length > 0) {
      ctx.logger.warn('peak-gate: holidays 有 %d 条解析不了（已忽略）：%s', bad.length, bad.join(' / '))
    }
    const warning = holidayCoverageWarning(Date.now(), calendar, config.beijingOffsetMinutes)
    if (warning !== undefined) ctx.logger.warn('%s', warning)
  }

  /**
   * 刷新日历：磁盘缓存 → 联网（可选）→ 内置兜底；结果写进 `autoHolidays`。
   * 同时只跑一次（并发调用复用同一个 promise），任何异常都不影响插件主流程。
   */
  const refreshHolidayCalendar = (config, reason) => {
    if (holidayRefreshing !== undefined) return holidayRefreshing
    holidayRefreshing = resolveHolidayCalendar({
      offsetMinutes: config.beijingOffsetMinutes,
      cachePath: holidayCache,
      autoRefresh: config.autoHolidayCalendar !== false,
      urls: config.holidayCalendarUrls,
      maxAgeDays: config.holidayCacheMaxAgeDays,
      timeoutMs: config.holidayFetchTimeoutMs,
      forceRefresh: reason === 'retry',
      includeBuiltin: config.useBuiltinHolidays !== false,
    }).then((result) => {
      autoHolidays = result.calendar
      calendarChecked = '' // 日历换了 ⇒ 让它重新自检一次
      for (const line of result.network) ctx.logger.info('peak-gate: 节假日日历已更新 %s', line)
      for (const line of result.warnings) ctx.logger.warn('%s', line)
      ctx.logger.info(
        'peak-gate: 节假日日历就绪（来源=%s，覆盖年份=%s，%d 条区间）',
        result.source,
        result.years.join('/') || '无',
        result.calendar.length,
      )
      return result
    }).catch((error) => {
      ctx.logger.warn('peak-gate: 节假日日历刷新异常（沿用已有日历）：%s', error?.message ?? String(error))
      return undefined
    }).finally(() => {
      holidayRefreshing = undefined
    })
    return holidayRefreshing
  }

  /** 已经告知过的会话（告知一次就够，别反复刷）。 */
  const warned = new WeakSet()
  /**
   * 第 3 层：已经因「工具预算用完」停下过的会话。
   * 用 WeakSet 而非 Map —— 一个会话只需要记「本轮停过」，新 turn 的第 1 步会清掉它，
   * 且不会因此泄漏内存（会话对象一被回收，标记自动消失）。
   */
  const budgetStopped = new WeakSet()
  /**
   * 本轮带过 `!force` 的会话 —— 整轮豁免工具预算。
   *
   * 为什么需要它：`!force` 原本只在**用户输入那一步**生效（拦不拦这次请求），
   * 而工具预算是在**续跑步骤**（`messages` 为空）里判的，那些 step 上没有口令可读。
   * 结果用户带了 `!force` 也只能跑 `peakMaxSteps` 步就被停下（2026-09-11 真机连踩两次）。
   * 现在：用户那一步看到 `!force` 就给本会话打上「本轮豁免」，续跑步骤一律放行。
   */
  const forcedTurnExempt = new WeakSet()
  /** 第 2 层：正在跑分类调用的会话（防止同一会话并发分类，白花钱）。 */
  const classifying = new WeakSet()
  /** 运行计数，给日志用。 */
  const stats = { blocked: 0, capped: 0, forced: 0, warned: 0, stopped: 0, classified: 0, heavy: 0 }

  /**
   * 第 2 层：花一次极短调用，问模型「这活儿重不重」。
   *
   * 三个关键设计：
   * ① **不走 `llm.stream`（waterfall）而走 `prepareCall`** —— 后者是官方公开路径且**完全绕过
   *    `llm/stream`**，所以不会把自己再拦一次、也不会污染主请求链路（硬要求）。
   *    `prepareCall` 不可用时退回 `llm.stream`（行为一样，只是会经过 waterfall）。
   * ② **超时兜底**：`AbortSignal.timeout` + 独立计时器，超时/报错一律返回 undefined → 放行。
   * ③ 只读**流里的 text-delta**拼答案；拿不到就放行。
   *
   * @returns {Promise<'heavy' | 'light' | undefined>} 判定结果；undefined = 放行。
   */
  async function classifyHeavy(text, config, route, session, hostSignal) {
    try {
      const llm = ctx.get('llm')
      // 两条路都算有本事：`prepareCall`（首选，绕开 llm/stream waterfall）或 `stream`（兜底）。
      const canPrepare = typeof llm?.prepareCall === 'function'
      const canStream = typeof llm?.stream === 'function'
      if (llm === undefined || (!canPrepare && !canStream)) return undefined
      const provider = config.classifierProvider !== '' ? config.classifierProvider : route?.provider
      if (typeof provider !== 'string' || provider === '') {
        ctx.logger.info('peak-gate: 分类调用跳过 —— 会话还没有已记录的 provider（首轮），按轻活放行')
        return undefined
      }
      const model = config.classifierModel !== '' ? config.classifierModel : route?.model
      const messages = [
        createUserMessage({
          content: [{ type: 'text', text: `${CLASSIFIER_PROMPT}\n${text.slice(0, 500)}` }],
          source: { kind: 'plugin:peak-gate', plugin: 'peak-gate', form: 'notice', summary: '峰谷守门·任务轻重分类' },
        }),
      ]
      const maxTokens = config.classifierMaxTokens
      const effort = config.classifierReasoningEffort
      // 🩸 真机教训（2026-09-11 18:3x）：会话默认 `reasoningEffort: high` 时，**思考 token 会吃光
      // maxTokens**（实测给 6 时一个字都吐不出来）→ 解析不到答案 → 永远「分类未定 → 放行」，
      // 看着像分类器根本没生效。所以默认改走 `reasoningEffort: 'off'`
      // （dsh-llm-deepseek 把它映射成 `thinking: disabled`，是合法值）。
      //
      // 注意：**每次尝试都要新建 AbortSignal**。共用同一个 `AbortSignal.timeout` 时，
      // 第一次超时后它已经 abort，第二次尝试会立刻被中止 —— 等于白重试（实测踩到过）。
      let lastSignal
      const runClassifierCall = async (reasoningEffort, limit) => {
        const timeoutSignal = AbortSignal.timeout(config.classifierTimeoutMs)
        // 用户的「停止」要能掐断分类请求：把宿主的 turn signal 一起接进来。
        // （宿主 agent/pre-step 的 payload 带 `signal`；不带的话分类会一直跑到超时，
        //  pre-step 这一步也就一直悬着。）
        let callSignal = timeoutSignal
        if (hostSignal !== undefined && typeof AbortSignal.any === 'function') {
          try {
            callSignal = AbortSignal.any([timeoutSignal, hostSignal])
          } catch {
            callSignal = timeoutSignal
          }
        }
        lastSignal = callSignal
        const base = {
          provider,
          model,
          maxTokens: limit,
          ...reasoningEffort === '' ? {} : { reasoningEffort },
        }
        let stream
        if (canPrepare) {
          const prepared = await llm.prepareCall(base)
          // 必须用 prepared.config 作为 options 的基础（agent loop 也是这么做的）：
          // prepareCall 会回填 adapter 默认值（如 reasoningEffort），少一个字段就会被
          // 「prepared LLM call config changed」的一致性校验拒掉。
          stream = prepared.stream({ ...prepared.config, messages, signal: callSignal })
        } else {
          stream = llm.stream({ ...base, messages, signal: callSignal })
        }
        let collected = ''
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') collected += chunk.text
        }
        return collected
      }
      let pieces
      try {
        pieces = await runClassifierCall(effort, maxTokens)
      } catch (error) {
        // 中止/超时类失败重试没有意义（会再白等一个超时），直接按「未定」放行。
        // 双保险：① 错误自己长得像 abort（adapter 可能包成 LlmError('ABORTED')）
        //        ② 本次尝试的超时信号已经中止（多半就是它触发的）
        const aborted = looksAborted(error) || (lastSignal !== undefined && lastSignal.aborted)
        if (effort === '' || aborted) throw error
        // 只有「这个路由不接受 off」才值得换个档位再来一次。
        // 其它失败（网络抖动/5xx/畸形响应）重试只会双倍花钱，直接交给外层兜底放行。
        // （对抗性测试发现：旧版对任何错误都重试，还在日志里谎称是 reasoningEffort 问题。）
        const reason = `${error?.name ?? ''} ${error?.code ?? ''} ${error?.message ?? ''}`
        if (!/reasoning|effort|thinking|unsupported/i.test(reason)) throw error
        ctx.logger.info(
          'peak-gate: 分类调用 reasoningEffort=%s 不被支持（%s），退回默认档重试',
          effort,
          error?.message ?? String(error),
        )
        pieces = await runClassifierCall('', Math.max(maxTokens, 32))
      }
      const verdict = parseClassifierVerdict(pieces)
      stats.classified += 1
      if (verdict === undefined) {
        ctx.logger.warn('peak-gate: 分类调用没拿到可识别的答案（收到 %d 字符），按轻活放行', pieces.length)
      }
      return verdict
    } catch (error) {
      ctx.logger.warn('peak-gate: 分类调用失败（按轻活放行）：%s', error?.message ?? String(error))
      return undefined
    } finally {
      if (session !== undefined) classifying.delete(session)
    }
  }

  ctx.on('agent/pre-step', async (payload, next) => {
    // 整个 handler 包一层兜底：宿主读 `messages` / `agent.session` 都可能抛
    // （例如 session 是抛错 getter）。README 承诺「任何异常一律放行」，
    // 所以这里绝不能让异常冒回 agent loop 去把用户这一轮打成 error。
    try {
      const { agent, messages, signal, step } = payload ?? {}
      const config = scope.get()
      if (!config.enabled || config.mode === 'off') return next()
      // 🗓️ 日历覆盖自检（节流：同一份日历只喊一次）—— 漏更新时必须吭声。
      checkHolidayCalendar(config)

      // 生死线：**没有用户新输入** = 工具循环中间的续跑步骤，绝不能当用户输入来拦。
      // 注意判据不是 `messages.length === 0` —— 宿主会把工具提醒等
      // `source.kind === 'plugin'` 的内容注入进 `messages`（见 hasUserInput 的说明）。
      if (!hasUserInput(messages)) {
        return stepBudget(agent, config, step, next)
      }

      // 新的一轮（用户输入那一步）开始了：清掉上一轮的预算标记与豁免。
      if (agent?.session !== undefined) {
        budgetStopped.delete(agent.session)
        forcedTurnExempt.delete(agent.session)
      }
      return await handleUserStep({ agent, messages, signal, config, next })
    } catch (error) {
      ctx.logger.warn('peak-gate: pre-step 异常（放行保平安）：%s', error?.message ?? String(error))
      try {
        return await next()
      } catch {
        return { kind: 'enter', messages: [] }
      }
    }
  })

  /** 用户输入那一步的完整判定（从第 1 层到拦截）。 */
  async function handleUserStep({ agent, messages, signal, config, next }) {
    if (!peakNow(config)) return next()

    const text = textOf(messages)

    // provider 白名单：用户若走了不按官方峰谷计价的中转渠道，可以把名单填上，避免误拦。
    const route = currentRoute(agent)
    if (!providerManaged(config.officialProviders, route?.provider)) {
      ctx.logger.info('peak-gate: provider=%s 不在 officialProviders 名单里，本步不管', route?.provider ?? '(未知)')
      return next()
    }

    // 一键放行：口令出现在**用户的消息**里才无条件通过（并让整轮豁免工具预算）。
    // 只扫用户来源文本 —— 免得被读进来的文件内容里出现 `!force` 就误放行（见 userTextOf）。
    if (config.forceToken !== '' && userTextOf(messages).includes(config.forceToken)) {
      stats.forced += 1
      if (agent?.session !== undefined) forcedTurnExempt.add(agent.session)
      ctx.logger.info('peak-gate: 命中放行口令，本步放行且本轮豁免工具预算（第 %d 次）', stats.forced)
      return next()
    }

    const isSubagent = agent?.parentAgent !== undefined
    if (isSubagent && !config.manageSubagents) return next()

    const estimated = estimateTokens(text)
    const pressure = config.sessionPressureTokens > 0 ? sessionTokens(ctx, agent) : 0
    // 用户可见的会话压力：只有启用了该判据才写进提示，否则 0 会误导。
    const pressureText = config.sessionPressureTokens > 0 ? `，当前会话压力约 ${pressure} token` : ''

    // —— 第 1 层：白名单直通（零成本，先判「轻」） ——
    const lightHit = lightKeywordHit(text, config.lightKeywords, config.lightKeywordMaxChars)
    if (lightHit !== undefined) {
      ctx.logger.info('peak-gate: 白名单命中「%s」，峰时放行（估算 %d token）', lightHit, estimated)
      return next()
    }

    // 原有的大任务判据（只看**本次输入**大小）。
    const pressureHigh = config.sessionPressureTokens > 0 && pressure >= config.sessionPressureTokens
    const isBigBySize = estimated >= config.bigTaskTokens || text.length >= config.bigTaskChars

    // —— 第 2 层：模型分类（白名单没命中时，判这是不是「重活」） ——
    // 命中白名单/口令的已经在上面放行了；这里只处理「够长、够可疑」的输入。
    //
    // 🩸 修复（2026-09-11，用户指出）：`sessionPressureTokens` 原本是**独立拦截判据**，
    // 会话一超阈值就无差别拦下一切 —— 峰时连「算一下 1+1」「在吗」都被拦，
    // 与 v2 的设计目标（峰时仍能干轻活）直接冲突，用户今天中午被连拦两次就是它。
    // 现在：压力**只提升分类敏感度**（把阈值放宽到 1/3、分类未定按重活处理），
    // 绝不单独触发拦截 ——「拦不拦」始终由「是不是重活」决定。
    let heavy = isBigBySize
    let verdictText = isBigBySize ? '输入本身超阈值' : ''
    if (!heavy && config.useModelClassifier && !isSubagent) {
      const longEnough =
        text.length >= config.classifierMinChars && estimated >= config.classifierMinTokens
      // 压力高 → 放宽门槛，让短输入也走一次分类（一次分类调用远比重发一遍长上下文便宜）
      const pressureWantsVerdict = pressureHigh && text.length >= MIN_CLASSIFY_CHARS_UNDER_PRESSURE
      const shouldClassify = longEnough || pressureWantsVerdict
      if (shouldClassify && agent?.session !== undefined && !classifying.has(agent.session)) {
        classifying.add(agent.session)
        const verdict = await classifyHeavy(text, config, route, agent.session, signal)
        if (verdict === 'heavy') {
          heavy = true
          verdictText = '模型判为重活'
          stats.heavy += 1
        } else if (verdict === 'light') {
          // 判为轻活就放行 —— 压力只影响「要不要问」，不影响「问出来的答案」。
          verdictText = '模型判为轻活'
        } else {
          if (pressureHigh) {
            // 压力高 + 认不出：保守拦（会话已经很重了，省下的钱最实在）。
            heavy = true
            verdictText = `会话压力约 ${pressure} token 且分类未定，按重活处理`
            stats.heavy += 1
          } else {
            verdictText = '分类未定（按轻活放行）'
          }
        }
      } else if (!shouldClassify) {
        verdictText = '输入较短，未分类'
      } else if (classifying.has(agent.session)) {
        verdictText = '并发分类中（本步未分类）'
      }
    }

    if (!heavy) {
      ctx.logger.info(
        'peak-gate: 峰时放行（%s，估算 %d token，长度 %d，provider=%s）',
        verdictText === '' ? '未触发任何判据' : verdictText,
        estimated,
        text.length,
        route?.provider ?? '(未知)',
      )
      return next()
    }

    // notify：只记日志，照常放行。
    if (config.dryRun || config.mode === 'notify') {
      ctx.logger.warn(
        'peak-gate: [%s] 峰时大任务（北京时间 %s，估算 %d token，会话压力 %d，子代理 %s，provider=%s，判据 %s）—— %s',
        config.dryRun ? 'dry-run' : 'notify',
        beijingLabel(Date.now(), config.beijingOffsetMinutes),
        estimated,
        pressure,
        isSubagent ? '是' : '否',
        route?.provider ?? '(未知)',
        verdictText,
        text.slice(0, 80).replace(/\s+/g, ' '),
      )
      if (config.dryRun) return next()
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      return {
        ...downstream,
        messages: [
          ...downstream.messages,
          notice(`【峰谷守门·提醒】现在是 DeepSeek 高峰时段（价格是空闲时段的 2 倍），这条任务被判定为**重活**（${verdictText}，预估约 ${estimated} token${pressureText}）。本次照办，但建议大活儿挪到${offPeakHint(config, Date.now())}再跑。`),
        ],
      }
    }

    // 子代理默认只压输出上限、不拦：拦住它 = 用户的主任务半路断掉，得不偿失。
    if (isSubagent && !config.blockSubagents) {
      ctx.logger.info('peak-gate: 峰时子代理大任务不拦（blockSubagents=false），仅压缩输出上限')
      return next()
    }

    stats.blocked += 1
    ctx.logger.warn(
      'peak-gate: 峰时拦下大任务（北京时间 %s，估算 %d token，会话压力 %d，子代理 %s，provider=%s，判据 %s，方式 %s，累计拦截 %d 次）：%s',
      beijingLabel(Date.now(), config.beijingOffsetMinutes),
      estimated,
      pressure,
      isSubagent ? '是' : '否',
      route?.provider ?? '(未知)',
      verdictText,
      config.onBlock,
      stats.blocked,
      text.slice(0, 120).replace(/\s+/g, ' '),
    )

    // 默认方式：用一条极短提示顶替掉这次大请求 —— 省掉大头，但用户看得见原因。
    if (config.onBlock === 'replace') {
      const hint = offPeakHint(config, Date.now())
      const hintTail = hint === '现在就是谷价时段' ? '（其实现在就是谷价时段，直接重发就行）' : `，${hint}再跑更划算`
      return {
        kind: 'enter',
        messages: [
          notice(`【峰谷守门·已拦截】你这条请求约 ${estimated} token${pressureText}，被判定为**重活**（${verdictText}）。现在是 DeepSeek 高峰时段（价格 = 空闲的 2 倍），已把它拦下，没有发出去。\n- 要现在就办：在消息里带上 \`${config.forceToken}\` 重发，峰时也不拦；\n- 想省钱${hintTail}；\n- 想调整判据：\`~/.dsh/profiles/web/cordis.patch.yml\` 的 \`peak-gate:\` 段（如 \`useModelClassifier\`、\`peakMaxSteps\`）。`),
        ],
      }
    }

    // reject 方式：每个会话首次先把话说明白，之后彻底静默拦截。
    if (config.warnOncePerSession && agent?.session !== undefined && !warned.has(agent.session)) {
      warned.add(agent.session)
      stats.warned += 1
      const downstream = await next()
      if (downstream.kind !== 'enter') return downstream
      return {
        ...downstream,
        messages: [
          ...downstream.messages,
          notice(`【峰谷守门·已上岗】现在是 DeepSeek 高峰时段（价格 = 空闲的 2 倍），这条任务被判定为**重活**（${verdictText}，预估约 ${estimated} token${pressureText}），按规矩放你过了。从下一条起，峰时的重活会被静默拦下（原因只进日志）—— 急事在消息里带上 \`${config.forceToken}\` 强制放行；想等便宜时段，${offPeakHint(config, Date.now())}。`),
        ],
      }
    }

    // reject：该轮以 blocked 结束，不产生任何模型请求。
    return { kind: 'reject' }
  }

  /**
   * 第 3 层：峰时工具预算。
   *
   * 只在**续跑步骤**（没有用户新输入、见 `hasUserInput`）里被调用。预算用完时：
   * ① 把一条提示**直接写进会话**（`session.append('user/message', …)`，与 agent loop 落消息同款，
   *    界面立刻看得见）；② 返回 `{kind:'reject'}` —— 这是宿主里**唯一**能真正结束本轮的 decision。
   *
   * 🩸 曾经以为返回空 messages 就能收尾（注释里也这么写着），真机实测是错的：
   * `dsh-agent-loop` 的闸门 `if (turnEnds && decision.messages.length === 0) break` 在工具循环里
   * 不成立（`turnEnds` 一直是 null）⇒ 照样发一次满历史请求、模型继续干活。会话记录里可见
   * 提示之后又跑了 22 次工具调用。所以改成 `reject`。
   *
   * 任何一步出错都必须降级为放行：这里是生死线附近，宁可不停也不能把用户的活儿弄坏。
   */
  async function stepBudget(agent, config, step, next) {
    try {
      if (!peakNow(config)) return next()
      if (agent?.parentAgent !== undefined && (!config.manageSubagents || !config.blockSubagents)) {
        // 子代理默认**完全不管第 3 层**：拦它 = 用户的主任务半路断掉（README 的承诺）。
        // （对抗性测试发现：旧版只看 manageSubagents，`blockSubagents: false` 时子代理照样被 reject。）
        return next()
      }
      const session = agent?.session
      const stop = overStepBudget({
        step,
        messageCount: 0,
        maxSteps: config.peakMaxSteps,
        alreadyStopped: session !== undefined && budgetStopped.has(session),
        forceExempt: session !== undefined && forcedTurnExempt.has(session),
      })
      if (!stop) return next()

      // 本轮第一次停下：计数、记日志、清并发分类标记。
      const first = session === undefined || !budgetStopped.has(session)
      if (session !== undefined) budgetStopped.add(session)
      if (first) {
        stats.stopped += 1
        classifying.delete(session)
        ctx.logger.warn(
          'peak-gate: 峰时工具预算用完（北京时间 %s，step=%s，预算 %s 步），本轮就地停下（不产生模型请求），累计 %d 次',
          beijingLabel(Date.now(), config.beijingOffsetMinutes),
          String(step),
          String(config.peakMaxSteps),
          stats.stopped,
        )
      }

      // dry-run / notify：只记日志，照常放行（不打断用户的活儿）。
      if (config.dryRun || config.mode === 'notify') return next()

      if (first) {
        const text = budgetNoticeText(config.peakMaxSteps, config.forceToken)
        let written = false
        try {
          // 侧信道：与 agent loop 自己落消息的方式保持一致（含 surfaceOp），界面可见。
          if (typeof session?.append === 'function') {
            session.append('user/message', notice(text), { surfaceOp: 'append' })
            written = true
          }
        } catch (error) {
          ctx.logger.warn('peak-gate: 预算提示写入会话失败（不影响停下）：%s', error?.message ?? String(error))
        }
        if (!written) {
          // 写不进会话的降级：让模型转述一次 —— 会多花一次小请求，但用户至少看得见。
          return { kind: 'enter', messages: [notice(text)] }
        }
      }
      // 🩸 真机教训（2026-09-11 深夜，对抗性审查 + 会话记录共同证实）：
      // **`{kind:'enter', messages: []}` 停不住 turn。** agent loop 的闸门是
      // `if (turnEnds && decision.messages.length === 0) break`，而工具循环里 `turnEnds`
      // 一直是 `null` ⇒ 照样 `step/start` + 发一次带完整历史的模型请求，模型继续干活。
      // 实测：提示之后又跑了 22 次工具调用。宿主里唯一能真正结束本轮的就是 `reject`
      // （`dsh-agent-loop` 941-943：`turnEnds = {kind:'blocked'}` + `return false`）。
      // 代价：本轮不会有 `turn/end`，界面上本轮也没模型收尾（提示已经把原因写在会话里）。
      return { kind: 'reject' }
    } catch (error) {
      ctx.logger.warn('peak-gate: 工具预算判定异常（放行保平安）：%s', error?.message ?? String(error))
      return next()
    }
  }

  ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next()
    const config = scope.get()
    if (!config.enabled || config.mode === 'off') return resolved
    // dry-run / notify 是「只观察不改行为」：连 maxTokens 都不该动，否则观察到的数据不可信。
    if (config.dryRun || config.mode === 'notify') return resolved
    if (!peakNow(config)) return resolved

    const isSubagent = agent?.parentAgent !== undefined
    if (isSubagent && !config.manageSubagents) return resolved

    // provider 白名单同样约束「压输出上限」这条。
    if (!providerManaged(config.officialProviders, resolved.provider)) return resolved

    const cap = isSubagent ? config.subagentMaxTokens : config.peakMaxTokens
    if (!Number.isFinite(cap) || cap <= 0) return resolved
    if (typeof resolved.maxTokens === 'number' && resolved.maxTokens <= cap) return resolved

    stats.capped += 1
    ctx.logger.info(
      'peak-gate: 峰时压缩输出上限 %s -> %d（第 %d 次）',
      resolved.maxTokens ?? '未设置',
      cap,
      stats.capped,
    )
    return { ...resolved, maxTokens: cap }
  })

  // —— 峰时精简输出提示段 ——
  // 借鉴市场插件 dsh-peak-cost-mode：`systemPrompt.section` 的 text 可以是函数，按每次组装
  // 实时求值。峰时返回提示段、谷时返回空串 —— 所以不需要定时器去挂/卸，也不会反复改前缀。
  // 注意：**必须无条件注册**，把开关判断放进 `text()` ——
  // 否则 `brevitySection` 从 false 热改成 true 不生效（对抗性测试发现，与「热改即时生效」矛盾）。
  {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
      const disposer = systemPrompt.section({
        name: 'peak:brevity',
        order: 60,
        text: () => {
          const config = scope.get()
          if (!config.enabled || !config.brevitySection || config.mode === 'off' || config.dryRun || config.mode === 'notify') {
            return ''
          }
          return peakNow(config)
            ? BREVITY_SECTION
            : ''
        },
      })
      ctx.effect(() => () => {
        if (typeof disposer === 'function') disposer()
      }, 'peak-gate: brevity section cleanup')
    } else {
      ctx.logger.warn('peak-gate: systemPrompt 服务不可用，峰时精简提示段未注册（其余功能不受影响）')
    }
  }

  ctx.logger.info(
    'peak-gate: 峰谷守门 v2 已加载（mode=%s，峰窗=%s，精简段=%s，白名单 %d 词，模型分类=%s，工具预算=%s 步，自动日历=%s）',
    scope.get().mode,
    scope.get().peakWindows.join(' / '),
    scope.get().brevitySection ? '开' : '关',
    (scope.get().lightKeywords ?? []).length,
    scope.get().useModelClassifier ? '开' : '关',
    String(scope.get().peakMaxSteps),
    scope.get().autoHolidayCalendar === false ? '关' : '开',
  )

  // —— 🗓️ 节假日日历的启动刷新与巡检 ——
  // 启动即刷一次（磁盘缓存 → 联网 holiday-cn → 内置兜底，后面两层都能单独用），
  // 之后每 12 小时核对一次：国务院公布次年安排后自动跟上，不需要谁记得来手改。
  // 用 `unref()`：这个定时器不该拖住进程退出；随插件销毁一起清掉。
  void refreshHolidayCalendar(scope.get(), 'boot')
  {
    const timer = setInterval(() => {
      const current = scope.get()
      if (current.autoHolidayCalendar === false) return
      void refreshHolidayCalendar(current, 'timer')
    }, 12 * 3600 * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    ctx.effect(() => () => clearInterval(timer), 'peak-gate: holiday calendar timer cleanup')
  }
}
