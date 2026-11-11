/**
 * dsh-peak-gate 离线自测：不启动 DSH，直接用假 ctx 驱动插件逻辑。
 *
 * 覆盖：
 *  1. 峰谷判定（北京时间口径 + 周末 + 跨零点 + 非法窗口 + 自定义时区偏移）
 *  2. token 粗估、文本拼接、北京时间文案、下一个谷时提示
 *  3. provider 白名单
 *  4. pre-step：空 messages 的**工具循环**放行、谷时放行、峰时大任务 replace/reject、
 *     口令放行、子代理开关、dry-run / notify
 *  5. agent/request：峰时压缩 maxTokens
 *  6. systemPrompt 峰时精简段：峰时给文案、谷时给空串
 *  7. v2 第 1 层：白名单直通（命中放行、超长不认、不设黑名单）
 *  8. v2 第 2 层：模型分类（heavy 拦 / light 放 / 超时与异常放行 / 输入太短不调用 / 防并发）
 *  9. v2 第 3 层：峰时工具预算（超预算停下且**不发模型请求**、提示写进会话、谷时不生效）
 *
 * 跑法：node test/selftest.mjs
 */
import assert from 'node:assert/strict'
import {
  apply,
  isPeakNow,
  estimateTokens,
  textOf,
  nextOffPeakHint,
  beijingLabel,
  providerManaged,
  lightKeywordHit,
  parseClassifierVerdict,
  overStepBudget,
  userTextOf,
  hasUserInput,
} from '../lib/index.mjs'
import {
  DEFAULT_HOLIDAYS,
  DEFAULT_MAKEUP_DAYS,
  beijingDateKey,
  fetchHolidayYear,
  holidayCoverageWarning,
  invalidHolidaySpecs,
  isDateKey,
  isHolidayDate,
  mergeDateKeysToRanges,
  parseHolidayDoc,
  parseHolidaySpec,
  resolveHolidayCalendar,
} from '../lib/holidays.mjs'

const results = []
const check = (label, fn) => {
  try {
    fn()
    results.push(`  ok   ${label}`)
  } catch (error) {
    results.push(`  FAIL ${label}\n       ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
const checkAsync = async (label, fn) => {
  // 用 stderr 实时报进度：万一某条用例挂住，stdout 会被 Node 的异常路径吞掉，
  // 只有 stderr 能告诉我们「最后跑到哪一条」。设 NO_PROGRESS=1 可关掉。
  if (process.env.NO_PROGRESS !== '1') process.stderr.write(`[case] ${label}\n`)
  try {
    await fn()
    results.push(`  ok   ${label}`)
  } catch (error) {
    results.push(`  FAIL ${label}\n       ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

// ── 测试用时间：窗口是**北京时间** ──────────────────────────────
// 注意：`Date.UTC` 的月份是 **0 起**（9 = 十月），别把「9 月」写成 9。
const WINDOWS = ['09:00-12:00', '14:00-18:00']
const utc = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min)
const PEAK = utc(2026, 9, 11, 2) // 2026-09-11（周五）UTC 02:00 = 北京 10:00 → 高峰
const PEAK2 = utc(2026, 9, 11, 7) // 2026-09-11（周五）UTC 07:00 = 北京 15:00 → 高峰
const OFFPEAK = utc(2026, 9, 11, 5) // 2026-09-11（周五）UTC 05:00 = 北京 13:00 → 空闲
const WEEKEND = utc(2026, 9, 12, 2) // 2026-09-12（周六）UTC 02:00 = 北京 10:00 → 周末谷价
const realNow = Date.now
const at = (ms) => {
  Date.now = () => ms
}

// ── 1. 峰谷判定 ────────────────────────────────────────────────
check('北京时间 10:00（周五）= 高峰', () => assert.equal(isPeakNow(PEAK, WINDOWS, true), true))
check('北京时间 15:00（周五）= 高峰', () => assert.equal(isPeakNow(PEAK2, WINDOWS, true), true))
check('北京时间 13:00（周五，午休空档）= 空闲', () => assert.equal(isPeakNow(OFFPEAK, WINDOWS, true), false))
check('北京时间 08:30（周五，开盘前）= 空闲', () => {
  assert.equal(isPeakNow(utc(2026, 9, 11, 0, 30), WINDOWS, true), false)
})
check('北京时间 12:00 整 = 空闲（左闭右开）', () => {
  assert.equal(isPeakNow(utc(2026, 9, 11, 4), WINDOWS, true), false)
})
check('北京时间 14:00 整 = 高峰（左闭）', () => {
  assert.equal(isPeakNow(utc(2026, 9, 11, 6), WINDOWS, true), true)
})
check('周六 10:00 = 空闲（周末全天谷价）', () => assert.equal(isPeakNow(WEEKEND, WINDOWS, true), false))
check('周末开关生效：weekendOffPeak=false 时周六算峰', () => {
  assert.equal(isPeakNow(WEEKEND, WINDOWS, false), true)
})
check('跨零点窗口 22:00-02:00 命中北京 23:00', () => {
  assert.equal(isPeakNow(utc(2026, 9, 11, 15), ['22:00-02:00'], false), true)
})
check('跨零点窗口 22:00-02:00 不命中北京 12:00', () => {
  assert.equal(isPeakNow(utc(2026, 9, 11, 4), ['22:00-02:00'], false), false)
})
check('非法窗口被忽略而非误判', () => {
  assert.equal(isPeakNow(PEAK, ['乱写的', ''], true), false)
})
check('时区偏移可覆盖：offset=0 时同一时刻不再是峰', () => {
  assert.equal(isPeakNow(PEAK, WINDOWS, true, 0), false)
})

// ── 2. 估算 / 文本 / 文案 ──────────────────────────────────────
check('纯 ASCII 估算量级合理', () => {
  const n = estimateTokens('a'.repeat(3600))
  assert.ok(n >= 900 && n <= 1100, `实际 ${n}`)
})
check('中文估算约 0.75 token/字', () => assert.equal(estimateTokens('中'.repeat(1000)), 750))
check('textOf 只取 text 块并跳过非文本块', () => {
  const text = textOf([
    { content: [{ type: 'text', text: '甲' }, { type: 'image' }] },
    { content: [{ type: 'text', text: '乙' }] },
  ])
  assert.equal(text, '甲\n乙')
})
check('userTextOf 只取用户来源（注入的 context 不算）', () => {
  const text = userTextOf([
    { content: [{ type: 'text', text: '用户的话' }], source: { kind: 'user' } },
    { content: [{ type: 'text', text: '里注入了 !force' }], source: { kind: 'plugin', plugin: 'x' } },
  ])
  assert.equal(text, '用户的话')
})
check('userTextOf 拿不到用户来源时退回全文（兼容旧夹具）', () => {
  assert.equal(userTextOf([{ content: [{ type: 'text', text: '!force 干活' }] }]), '!force 干活')
})
check('beijingLabel 输出北京时间', () => {
  assert.equal(beijingLabel(PEAK), '09/11 10:00')
})
check('nextOffPeakHint 在峰时给窗口结束时刻', () => {
  assert.match(nextOffPeakHint(PEAK, WINDOWS, true), /12:00/)
})
check('nextOffPeakHint 在非峰时（13:00 午休谷价）= 说"现在"，不劝人等', () => {
  // 旧版会返回「北京时间今天 18:00」—— 等于劝用户关掉正在进行的免费工作
  assert.match(nextOffPeakHint(OFFPEAK, WINDOWS, true, 480, false), /现在/)
})
check('nextOffPeakHint 在开盘前（08:30）= 给今天的开盘时刻', () => {
  assert.match(nextOffPeakHint(utc(2026, 9, 11, 0, 30), WINDOWS, true, 480, false), /09:00/)
})
check('nextOffPeakHint 周末（谷价）= 说"现在"而不是"等周一"', () => {
  assert.match(nextOffPeakHint(WEEKEND, WINDOWS, true, 480, false), /现在/)
})
check('nextOffPeakHint 在周五盘后提示周末', () => {
  assert.match(nextOffPeakHint(utc(2026, 9, 11, 11), WINDOWS, true), /周末/)
})

// ── 3. provider 白名单 ────────────────────────────────────────
check('白名单为空 = 全管', () => {
  assert.equal(providerManaged([], 'anything'), true)
  assert.equal(providerManaged(undefined, undefined), true)
})
check('白名单命中 = 管', () => assert.equal(providerManaged(['deepseek-official'], 'deepseek-official'), true))
check('白名单不命中 = 不管', () => assert.equal(providerManaged(['deepseek-official'], 'my-relay'), false))
check('白名单非空但 provider 未知 = 仍然管（宁可多管）', () => {
  assert.equal(providerManaged(['deepseek-official'], undefined), true)
})

// ── 7. v2 第 1 层：白名单直通 ─────────────────────────────────
check('白名单命中（短输入）= 直通', () => {
  assert.equal(lightKeywordHit('帮我算一下 12*37 等于多少', ['算一下', '天气']), '算一下')
})
check('白名单不区分大小写', () => {
  assert.equal(lightKeywordHit('Translate this please', ['translate']), 'translate')
})
check('白名单对超长输入不生效（避免长任务里顺带命中）', () => {
  assert.equal(lightKeywordHit(`翻译${'中'.repeat(200)}`, ['翻译'], 120), undefined)
})
check('白名单没命中 = undefined（交给第 2 层）', () => {
  assert.equal(lightKeywordHit('帮我写个爬虫抓某某网站', ['算一下', '天气']), undefined)
})
check('没有黑名单：写代码类输入不会被词表直接拦', () => {
  // 需求：不需要关键词黑名单 —— 只判轻，不判重。
  assert.equal(lightKeywordHit('帮我重构这个模块并修掉报错', ['算一下']), undefined)
})
check('空词表 / 空文本不炸', () => {
  assert.equal(lightKeywordHit('随便', [], 120), undefined)
  assert.equal(lightKeywordHit('', ['算'], 120), undefined)
})

// ── 8. v2 第 2 层：分类结果解析 ───────────────────────────────
check('分类解析：单个字母 b = heavy', () => assert.equal(parseClassifierVerdict('b'), 'heavy'))
check('分类解析：单个字母 a = light', () => assert.equal(parseClassifierVerdict('a'), 'light'))
check('分类解析：大写 B = heavy', () => assert.equal(parseClassifierVerdict('B'), 'heavy'))
check('分类解析：heavy / light 单词', () => {
  assert.equal(parseClassifierVerdict('heavy'), 'heavy')
  assert.equal(parseClassifierVerdict('light'), 'light')
})
check('分类解析：中文重/轻也能认', () => {
  assert.equal(parseClassifierVerdict('重'), 'heavy')
  assert.equal(parseClassifierVerdict('轻'), 'light')
})
check('分类解析：废话里带字母也能认', () => {
  assert.equal(parseClassifierVerdict('Answer: b'), 'heavy')
})
check('分类解析：认不出来 = undefined（调用方按轻活放行）', () => {
  assert.equal(parseClassifierVerdict(''), undefined)
  assert.equal(parseClassifierVerdict('???'), undefined)
  assert.equal(parseClassifierVerdict(undefined), undefined)
})

// ── 9. v2 第 3 层：预算判定纯函数 ─────────────────────────────
check('预算：续跑步骤超过预算 = 停', () => {
  assert.equal(overStepBudget({ step: 13, messageCount: 0, maxSteps: 12 }), true)
})
check('预算：正好第 12 步还放行（step 用的是「下一步」序号）', () => {
  assert.equal(overStepBudget({ step: 12, messageCount: 0, maxSteps: 12 }), false)
})
check('预算：用户输入那一步永远不受预算管', () => {
  assert.equal(overStepBudget({ step: 99, messageCount: 1, maxSteps: 12 }), false)
})
check('预算：maxSteps=0 = 关闭这条', () => {
  assert.equal(overStepBudget({ step: 999, messageCount: 0, maxSteps: 0 }), false)
})
check('预算：已停过 + 仍超预算 = 继续停', () => {
  assert.equal(overStepBudget({ step: 13, messageCount: 0, maxSteps: 12, alreadyStopped: true }), true)
})
check('预算：热改调大 peakMaxSteps 后，旧标记不该把新一轮立刻停掉', () => {
  // 旧版 `if (alreadyStopped) return true` 优先级过高：用户把 12 改成 50 后，
  // 新一轮的第一步续跑会被立刻判停（提示还写着"已经跑了 50 步"）。
  assert.equal(overStepBudget({ step: 3, messageCount: 0, maxSteps: 50, alreadyStopped: true }), false)
})

// ── 峰谷日历：法定节假日 + 调休周末（官方 2026-09-19 补充口径）────
const HOL = ['2026-10-01~2026-10-07', '2026-02-15~2026-02-23']
check('日历：区间内的日期算放假、区间外不算', () => {
  assert.equal(isHolidayDate('2026-10-03', HOL), true)
  assert.equal(isHolidayDate('2026-10-08', HOL), false)
})
check('日历：区间两端都是闭区间（起、止都算）', () => {
  assert.equal(isHolidayDate('2026-10-01', HOL), true)
  assert.equal(isHolidayDate('2026-10-07', HOL), true)
})
check('日历：支持单日写法', () => {
  assert.equal(isHolidayDate('2026-01-01', ['2026-01-01']), true)
  assert.equal(isHolidayDate('2026-01-02', ['2026-01-01']), false)
})
check('日历：非法项被忽略（乱写 / 倒序区间 / 月日越界）', () => {
  assert.deepEqual(
    invalidHolidaySpecs(['乱写的', '2026-10-09~2026-10-01', '2026-10-01']),
    ['乱写的', '2026-10-09~2026-10-01'],
  )
  assert.equal(parseHolidaySpec('2026-13-01'), undefined)
  assert.equal(parseHolidaySpec('2026-10-01~2026-10-07~x'), undefined)
})
check('峰谷：法定节假日（周四 10:00）不判峰', () => {
  assert.equal(isPeakNow(utc(2026, 10, 1, 2), WINDOWS, true, 480, HOL), false)
})
check('峰谷：节前同一时刻仍判峰（正反对照）', () => {
  assert.equal(isPeakNow(utc(2026, 9, 30, 2), WINDOWS, true, 480, HOL), true)
})
check('峰谷：调休上班的周六仍按空闲（官方口径，别改成高峰）', () => {
  assert.equal(isPeakNow(utc(2026, 10, 10, 2), WINDOWS, true, 480, HOL), false)
})
check('峰谷：不传日历也用内置兜底表（国庆当天不判峰）', () => {
  assert.equal(isHolidayDate('2026-10-01', DEFAULT_HOLIDAYS), true)
  assert.equal(isPeakNow(utc(2026, 10, 1, 2), WINDOWS, true), false)
})
check('谷时提示：节假日说「现在」，绝不劝人等到 09:00', () => {
  const hint = nextOffPeakHint(utc(2026, 10, 1, 2), WINDOWS, true, 480, false, HOL)
  assert.match(hint, /现在/)
  assert.doesNotMatch(hint, /09:00/)
})
check('覆盖自检：当年没数据要告警；有数据静默；空表也告警', () => {
  // 文案从「未覆盖」升级为**日级**的「覆盖不足」。
  assert.match(String(holidayCoverageWarning(utc(2028, 10, 1, 2), HOL, 480)), /覆盖不足/)
  assert.equal(holidayCoverageWarning(utc(2026, 10, 1, 2), HOL, 480), undefined)
  assert.match(String(holidayCoverageWarning(utc(2026, 10, 1, 2), [], 480)), /为空/)
})
check('日期键：北京时间口径（跨零点不串日）', () => {
  // 北京 2026-10-01 00:30 = UTC 2026-09-30 16:30
  assert.equal(beijingDateKey(utc(2026, 9, 30, 16, 30), 480), '2026-10-01')
})
check('合并区间：连续日期合并、跳日断开', () => {
  assert.deepEqual(
    mergeDateKeysToRanges(['2026-01-01', '2026-01-02', '2026-01-04']),
    ['2026-01-01~2026-01-02', '2026-01-04'],
  )
})
check('解析 holiday-cn：取 isOffDay=true；补班日只记录、不参与判定', () => {
  // 放假日数必须 ≥ `MIN_OFF_DAYS_PER_YEAR`（15），否则会被判成半截数据（后加的下界）。
  const off = Array.from({ length: 15 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`)
  const doc = parseHolidayDoc(JSON.stringify({
    year: 2026,
    days: [
      ...off.map((date) => ({ date, isOffDay: true })),
      { date: '2026-01-16', isOffDay: false },
      { date: '垃圾数据', isOffDay: true },
    ],
  }))
  assert.deepEqual(doc.offDays, off)
  assert.deepEqual(doc.workdays, ['2026-01-16'])
})
check('解析 holiday-cn：可疑数据直接抛（绝不当成空日历）', () => {
  assert.throws(() => parseHolidayDoc('{"year":2026}'))
  assert.throws(() => parseHolidayDoc(JSON.stringify({ year: 2026, days: [] })))
  assert.throws(() => parseHolidayDoc(JSON.stringify({ year: 2026, days: [{ date: '2026-01-01', isOffDay: true }] })))
  assert.throws(() => parseHolidayDoc('不是 JSON'))
})

// ── 对抗性审查后的回填用例 ─────────────
check('日期键：严格校验月日与闰年', () => {
  assert.equal(isDateKey('2026-02-30'), false)
  assert.equal(isDateKey('2026-02-31'), false)
  assert.equal(isDateKey('2026-02-29'), false, '2026 不是闰年')
  assert.equal(isDateKey('2028-02-29'), true, '2028 是闰年')
  assert.equal(isDateKey('2026-04-31'), false)
  assert.equal(isDateKey('2026-12-31'), true)
})
check('合并区间：非法日期被过滤，连续段仍合得上', () => {
  assert.deepEqual(
    mergeDateKeysToRanges(['2026-02-27', '2026-02-28', '2026-03-01']),
    ['2026-02-27~2026-03-01'],
  )
  assert.deepEqual(mergeDateKeysToRanges(['2026-02-29']), [])
})
check('覆盖自检：**日级**（只回几天 / 跨年区间都不能算"已覆盖"）', () => {
  assert.match(String(holidayCoverageWarning(utc(2027, 10, 1, 2), ['2027-03-01~2027-03-05'], 480)), /覆盖不足/)
  assert.match(String(holidayCoverageWarning(utc(2027, 10, 1, 2), ['2026-12-28~2027-01-03'], 480)), /覆盖不足/)
  assert.equal(holidayCoverageWarning(utc(2026, 10, 1, 2), DEFAULT_HOLIDAYS, 480), undefined)
})
check('解析文档：日期不属于该年 ⇒ 可疑', () => {
  const days = Array.from({ length: 20 }, (_, index) => ({ date: `2027-01-${String(index + 1).padStart(2, '0')}`, isOffDay: true }))
  assert.throws(() => parseHolidayDoc(JSON.stringify({ year: 2026, days })), /可疑/)
})
check('解析文档：全年都放假 ⇒ 可疑（fail-open 投毒）', () => {
  const days = []
  for (let month = 1; month <= 12; month += 1) {
    for (let day = 1; day <= 28; day += 1) {
      days.push({ date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, isOffDay: true })
    }
  }
  assert.throws(() => parseHolidayDoc(JSON.stringify({ year: 2026, days })), /多于/)
})
check('解析文档：下界提到 15 天（半截响应不再算"有效"）', () => {
  const five = Array.from({ length: 5 }, (_, index) => ({ date: `2026-01-0${index + 1}`, isOffDay: true }))
  assert.throws(() => parseHolidayDoc(JSON.stringify({ year: 2026, days: five })), /少于 15/)
})
check('调休上班日也按谷价 —— 连 `weekendOffPeak=false` 时也算', () => {
  const cal = [...DEFAULT_HOLIDAYS, ...DEFAULT_MAKEUP_DAYS]
  // 2026-10-10 是周六（国家标定的调休上班日）；北京 10:00 = UTC 02:00
  assert.equal(isHolidayDate('2026-10-10', cal), true)
  assert.equal(isPeakNow(utc(2026, 10, 10, 2), WINDOWS, true, 480, cal), false, '默认周末豁免下自然不判峰')
  assert.equal(isPeakNow(utc(2026, 10, 10, 2), WINDOWS, false, 480, cal), false, '★ 关键：关掉周末豁免后，补班日仍按谷价')
  // 正对照：同一配置下**普通**周六仍按窗口判峰（证明只有补班日被豁免）
  assert.equal(isPeakNow(utc(2026, 10, 17, 2), WINDOWS, false, 480, cal), true)
})

// ── 4/5/6/8/9. 钩子行为 ───────────────────────────────────────
const CONFIG = {
  enabled: true,
  mode: 'block',
  peakWindows: WINDOWS,
  beijingOffsetMinutes: 480,
  weekendOffPeak: true,
  // 自测一律**不联网、不碰真实缓存**：`holidayCalendarUrls: []` = 没有源，缓存路径指向不存在的位置。
  autoHolidayCalendar: false,
  holidayCalendarUrls: [],
  holidayCachePath: `${process.env.TEMP ?? '/tmp'}/peak-gate-selftest-no-such-cache.json`,
  officialProviders: [],
  brevitySection: true,
  bigTaskTokens: 1000,
  bigTaskChars: 5000,
  sessionPressureTokens: 0,
  lightKeywords: ['算一下', '天气', '翻译'],
  lightKeywordMaxChars: 120,
  useModelClassifier: true,
  classifierProvider: '',
  classifierModel: '',
  classifierTimeoutMs: 3000,
  classifierMaxTokens: 6,
  classifierReasoningEffort: 'off',
  classifierMinChars: 20,
  classifierMinTokens: 20,
  peakMaxSteps: 12,
  forceToken: '!force',
  peakMaxTokens: 32768,
  subagentMaxTokens: 16384,
  manageSubagents: true,
  onBlock: 'replace',
  blockSubagents: false,
  warnOncePerSession: true,
  dryRun: false,
}

/** 装一个假 ctx，返回钩子表、日志、section 注册记录。 */
function harness(overrides = {}, env = {}) {
  let config = { ...CONFIG, ...overrides }
  const handlers = {}
  const logs = []
  const sections = []
  const systemPrompt = env.systemPrompt ?? { section: (opts) => { sections.push(opts); return () => {} } }
  const ctx = {
    settings: { register: () => ({ get: () => config }) },
    logger: { info: (...a) => logs.push(['info', a]), warn: (...a) => logs.push(['warn', a]) },
    on: (event, handler) => {
      handlers[event] = handler
    },
    get: (key) => {
      // 🩸 这里必须能拿到 settings 服务：插件用 `ctx.get('settings')` 判断能不能
      // `register()`；漏了这一条，插件会悄悄回落成「配置全默认」，
      // 于是所有 override（dryRun / notify / onBlock / brevitySection…）都不生效，
      // 一批用例会以「看起来像插件的 bug」的形式变红（2026-09-25 发现并修）。
      if (key === 'settings') return ctx.settings
      if (key === 'systemPrompt') return systemPrompt
      if (key === 'llm') return env.llm
      if (key === 'tokenMeter') return env.tokenMeter
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') env.disposers?.push(disposer)
    },
  }
  apply(ctx)
  return { handlers, logs, sections, set: (patch) => { config = { ...config, ...patch } } }
}

const enterNext = async () => ({ kind: 'enter', messages: [{ role: 'user' }] })
const bigText = '中'.repeat(5000) // 3750 token > 1000 阈值
const smallText = '你好'
/** 足够长、够触发分类、又**不含任何白名单词**的输入。 */
const classifyText = '帮我把这个项目里的前端页面改一改，顺便把能优化的地方都优化一遍'

/** 造 agent；provider 给定时模拟会话已记录的请求头。 */
const agentOf = (isChild = false, provider, extra = {}) => ({
  session: {
    id: 's1',
    requestHeader: () => (provider === undefined ? undefined : { config: { provider, model: 'deepseek-flash' } }),
    appended: [],
    append(type, data, opts) {
      this.appended.push({ type, data, opts })
    },
  },
  ...(isChild ? { parentAgent: { id: 'p' } } : {}),
  ...extra,
})
const stepPayload = (agent, text) => ({
  agent,
  messages: [{ content: [{ type: 'text', text }], source: { kind: 'user' } }],
  signal: {},
})
const resumePayload = (agent, step) => ({
  agent,
  messages: [],
  step,
  signal: {},
})
/**
 * 工具循环里**被注入上下文**的一步（真机可达的场景）：
 * `dsh-repeat-tool-reminder` 经 `tools/post-execute` 的 `additionalContexts` 注入一条
 * `source.kind === 'plugin'` 的提醒 ⇒ preStep 的 `messages` 非空，但**不是用户的输入**。
 * 插件必须把它当续跑步骤，否则会去分类、甚至把工具提醒顶替成拦截提示。
 */
const injectedPayload = (agent, step, text = '你已经重复调用同一个工具 3 次了，别再重复。', plugin = 'repeat-tool-reminder') => ({
  agent,
  messages: [{ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin, form: 'notice' } }],
  step,
  signal: {},
})
/** 造一个假 llm：prepareCall 返回固定分类答案，记录调用次数。 */
function fakeLlm(verdict = 'a', options = {}) {
  const calls = []
  return {
    calls,
    prepareCall: async (config) => {
      calls.push(config)
      if (options.throwOnPrepare) throw new Error('prepare boom')
      return {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            if (options.throwOnStream) throw new Error('stream boom')
            if (options.hang) await new Promise((_, reject) => {
              options.signal?.addEventListener?.('abort', () => reject(new Error('aborted')), { once: true })
            })
            yield { type: 'text-delta', text: verdict }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
      }
    },
  }
}
const neverNext = async () => {
  throw new Error('这个分支不该调用 next()')
}

async function run() {
  // ── 4. pre-step：基础行为 ──────────────────────────────────
  await checkAsync('工具循环（messages 为空、未超预算）不被拦', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    const result = await handlers['agent/pre-step'](resumePayload(agentOf(), 3), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
    assert.equal(result.kind, 'enter')
  })

  await checkAsync('谷时大任务放行', async () => {
    at(OFFPEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](stepPayload(agentOf(), bigText), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('峰时小任务放行', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](stepPayload(agentOf(), smallText), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('峰时大任务（replace）被短提示顶替', async () => {
    at(PEAK)
    const { handlers } = harness()
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(), bigText), neverNext)
    assert.equal(result.kind, 'enter')
    assert.equal(result.messages.length, 1, '只剩那条提示，原大请求被丢掉')
    assert.equal(result.messages[0].source?.plugin, 'peak-gate')
    assert.match(result.messages[0].content[0].text, /已拦截/)
    assert.match(result.messages[0].content[0].text, /!force/)
    assert.match(result.messages[0].content[0].text, /输入本身超阈值/)
  })

  await checkAsync('reject 方式首次 = 放行 + 附通知', async () => {
    at(PEAK)
    const { handlers } = harness({ onBlock: 'reject' })
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(), bigText), enterNext)
    assert.equal(result.kind, 'enter')
    assert.equal(result.messages.length, 2, '应额外附一条 notice')
    assert.match(result.messages[1].content[0].text, /峰谷守门/)
  })

  await checkAsync('reject 方式第二次 = reject 且不调 next', async () => {
    at(PEAK)
    const { handlers } = harness({ onBlock: 'reject' })
    const agent = agentOf()
    await handlers['agent/pre-step'](stepPayload(agent, bigText), enterNext)
    const result = await handlers['agent/pre-step'](stepPayload(agent, bigText), neverNext)
    assert.deepEqual(result, { kind: 'reject' })
  })

  await checkAsync('放行口令无条件通过', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(), `!force ${bigText}`), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
    assert.equal(result.kind, 'enter')
  })

  await checkAsync('provider 白名单外 = 不拦', async () => {
    at(PEAK)
    const { handlers } = harness({ officialProviders: ['deepseek-official'] })
    let nextCalls = 0
    await handlers['agent/pre-step'](stepPayload(agentOf(false, 'my-relay'), bigText), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1, '中转渠道不该被拦')
  })

  await checkAsync('provider 白名单内 = 拦（replace）', async () => {
    at(PEAK)
    const { handlers } = harness({ officialProviders: ['deepseek-official'] })
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), bigText),
      neverNext,
    )
    assert.match(result.messages[0].content[0].text, /已拦截/)
  })

  await checkAsync('manageSubagents=false 时子代理不受管', async () => {
    at(PEAK)
    const { handlers } = harness({ manageSubagents: false })
    let nextCalls = 0
    await handlers['agent/pre-step'](stepPayload(agentOf(true), bigText), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('默认不拦子代理大任务（只压上限）', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(true), bigText), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
    assert.equal(result.messages.length, 1)
  })

  await checkAsync('blockSubagents=true 时子代理也被拦', async () => {
    at(PEAK)
    const { handlers } = harness({ blockSubagents: true })
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(true), bigText), neverNext)
    assert.match(result.messages[0].content[0].text, /已拦截/)
  })

  await checkAsync('dry-run 只记日志不改行为', async () => {
    at(PEAK)
    const { handlers, logs } = harness({ dryRun: true })
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(), bigText), enterNext)
    assert.equal(result.messages.length, 1)
    assert.ok(logs.some(([level]) => level === 'warn'))
  })

  await checkAsync('notify 模式不拦但提醒', async () => {
    at(PEAK)
    const { handlers } = harness({ mode: 'notify' })
    const result = await handlers['agent/pre-step'](stepPayload(agentOf(), bigText), enterNext)
    assert.equal(result.messages.length, 2)
  })

  await checkAsync('enabled=false 时完全不介入', async () => {
    at(PEAK)
    const { handlers } = harness({ enabled: false })
    let nextCalls = 0
    await handlers['agent/pre-step'](stepPayload(agentOf(), bigText), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  // ── 8. v2 第 2 层：模型分类 ────────────────────────────────
  await checkAsync('白名单命中 = 不调用分类模型，直接放行', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), '帮我算一下 23*47 是多少'),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
    assert.equal(llm.calls.length, 0, '白名单命中不该花分类调用')
  })

  await checkAsync('分类判 heavy = 拦下（replace）', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    const agent = agentOf(false, 'deepseek-official')
    const result = await handlers['agent/pre-step'](stepPayload(agent, classifyText), neverNext)
    assert.equal(llm.calls.length, 1, '应恰好花一次分类调用')
    assert.equal(llm.calls[0].provider, 'deepseek-official')
    assert.equal(llm.calls[0].model, 'deepseek-flash')
    assert.match(result.messages[0].content[0].text, /已拦截/)
    assert.match(result.messages[0].content[0].text, /模型判为重活/)
  })

  await checkAsync('分类判 light = 放行', async () => {
    at(PEAK)
    const llm = fakeLlm('a')
    const { handlers } = harness({}, { llm })
    let nextCalls = 0
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
    assert.equal(result.messages.length, 1)
    assert.equal(llm.calls.length, 1)
  })

  await checkAsync('分类调用报错 = 按轻活放行（不拦）', async () => {
    at(PEAK)
    const llm = fakeLlm('b', { throwOnPrepare: true })
    const { handlers, logs } = harness({}, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1, '分类失败不能拦人')
    assert.ok(logs.some(([level, a]) => level === 'warn' && String(a[0]).includes('分类调用失败')))
  })

  await checkAsync('分类拿不到答案（空输出）= 按轻活放行', async () => {
    at(PEAK)
    const llm = fakeLlm('')
    const { handlers } = harness({}, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
  })

  await checkAsync('输入太短 = 不花分类调用，直接放行', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), '帮我写个脚本'),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
    assert.equal(llm.calls.length, 0, '短输入不调分类，避免天天烧钱')
  })

  await checkAsync('会话还没有 provider（首轮）时分类跳过 = 放行', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, undefined), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
    assert.equal(llm.calls.length, 0)
  })

  await checkAsync('useModelClassifier=false = 不调用分类（只按大小判）', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({ useModelClassifier: false }, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
    assert.equal(llm.calls.length, 0)
  })

  await checkAsync('分类调用异常时有超时兜底信号（AbortSignal）', async () => {
    at(PEAK)
    // 直接验证 classifyHeavy 传给 prepareCall 的对象带 signal：这里用 stream 抛错模拟超时。
    const llm = fakeLlm('b', { throwOnStream: true })
    const { handlers, logs } = harness({}, { llm })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
    assert.ok(logs.some(([level, a]) => level === 'warn' && String(a[0]).includes('分类调用失败')))
  })

  await checkAsync('只有 llm.stream（没有 prepareCall）= 走兜底路径也能分类', async () => {
    at(PEAK)
    // 这条是 2026-09-11 真踩过的坑：分类器一开始写死要求 llm.stream 存在，
    // 结果 prepareCall 路径明明可用却被这道检查挡掉，分类永远返回 undefined（静默不拦）。
    const calls = []
    const llm = {
      stream: (options) => {
        calls.push(options)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'text-delta', text: 'b' }
          },
        }
      },
    }
    const { handlers } = harness({}, { llm })
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'deepseek-official')
    assert.equal(calls[0].maxTokens, 6)
    assert.match(result.messages[0].content[0].text, /已拦截/)
  })

  await checkAsync('llm 服务整个不可用 = 分类跳过、放行', async () => {
    at(PEAK)
    const { handlers } = harness({}, {})
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
  })

  await checkAsync('准备调用时用 prepared.config 作为基础（防一致性校验拒绝）', async () => {
    at(PEAK)
    // prepareCall 会回填默认值（如 reasoningEffort）；stream 收到时必须带上它们。
    let streamOptions
    const llm = {
      prepareCall: async (base) => ({
        config: { ...base, reasoningEffort: 'none' },
        stream: (options) => {
          streamOptions = options
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta', text: 'b' }
            },
          }
        },
      }),
    }
    const { handlers } = harness({}, { llm })
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.equal(streamOptions.reasoningEffort, 'none', '必须带上 prepareCall 回填的默认值')
    assert.ok(streamOptions.signal !== undefined, '必须带超时信号')
  })

  await checkAsync('分类调用默认关掉推理（reasoningEffort=off）', async () => {
    at(PEAK)
    // 真机教训：会话默认 reasoningEffort=high 时，思考 token 会吃光 maxTokens:6，
    // 一个字母都吐不出来 ⇒ 永远「分类未定 → 放行」。所以分类必须显式关推理。
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].reasoningEffort, 'off', '默认必须关推理，否则答案被思考挤掉')
    assert.equal(llm.calls[0].maxTokens, 6)
  })

  await checkAsync('分类超时（被中止）= 不重试，直接放行', async () => {
    at(PEAK)
    let calls = 0
    const llm = {
      prepareCall: async (base) => {
        calls += 1
        // 🩸 进假流之前把时钟还原成真实时间：`Date.now` 被 mock 成固定值后，
        // 同进程里 `AbortSignal.timeout()` 不再触发 ⇒ 假流永远等不到 abort、
        // 整份自测挂住（`unsettled top-level await`）。峰时判定已经做完了，还原它不影响本用例。
        Date.now = realNow
        return {
          config: { ...base },
          stream: (options) => ({
            async *[Symbol.asyncIterator]() {
              await new Promise((resolve) => {
                if (options.signal?.aborted) return resolve(undefined)
                options.signal?.addEventListener('abort', () => resolve(undefined), { once: true })
                // 保险丝：即使信号没触发，也不让整份自测挂死
                setTimeout(() => resolve(undefined), 500)
              })
              throw Object.assign(new Error('DeepSeek request aborted by caller'), { name: 'TimeoutError' })
            },
          }),
        }
      },
    }
    const { handlers } = harness({ classifierTimeoutMs: 5 }, { llm })
    let nextCalls = 0
    try {
      await handlers['agent/pre-step'](
        stepPayload(agentOf(false, 'deepseek-official'), classifyText),
        async () => { nextCalls += 1; return enterNext() },
      )
    } finally {
      at(PEAK)
    }
    assert.equal(calls, 1, '中止类失败不该重试')
    assert.equal(nextCalls, 1, '最终按轻活放行')
  })

  await checkAsync('降级重试用的是新的超时信号（不是已中止的那个）', async () => {
    at(PEAK)
    // 共用同一个 AbortSignal.timeout 时，第一次超时后第二次会立刻被中止 = 白重试。
    const signals = []
    const llm = {
      prepareCall: async (base) => {
        if (base.reasoningEffort === 'off') {
          throw Object.assign(new Error('does not support reasoning effort "off"'), {
            code: 'UNSUPPORTED_REASONING_EFFORT',
          })
        }
        return {
          config: { ...base },
          // signal 在 stream 的 options 里，借它抓出来
          stream: (options) => {
            signals.push(options.signal)
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'text-delta', text: 'b' }
              },
            }
          },
        }
      },
    }
    const { handlers } = harness({}, { llm })
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.equal(signals.length, 1)
    assert.ok(signals[0] instanceof AbortSignal, '必须带超时信号')
    assert.equal(signals[0].aborted, false, '重试用的信号必须是新的、还没中止的')
    assert.match(result.messages[0].content[0].text, /已拦截/)
  })

  await checkAsync('reasoningEffort=off 不被支持时 = 降级重试（默认档 + 放大 token）', async () => {
    at(PEAK)
    const calls = []
    const llm = {
      prepareCall: async (base) => {
        calls.push(base)
        if (base.reasoningEffort === 'off') throw new Error('does not support reasoning effort "off"')
        return {
          config: { ...base },
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'text-delta', text: 'b' }
            },
          }),
        }
      },
    }
    const { handlers, logs } = harness({}, { llm })
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.equal(calls.length, 2, '第一次失败后应重试一次')
    assert.equal(calls[0].reasoningEffort, 'off')
    assert.equal(calls[1].reasoningEffort, undefined, '降级调用应跟随默认档')
    assert.ok(calls[1].maxTokens >= 32, `降级时要放大 token，实际 ${calls[1].maxTokens}`)
    assert.match(result.messages[0].content[0].text, /已拦截/)
    assert.ok(logs.some(([level, a]) => level === 'info' && String(a[0]).includes('退回默认档重试')))
  })

  await checkAsync('classifierReasoningEffort 可配空 = 不传该字段', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({ classifierReasoningEffort: '' }, { llm })
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.equal(llm.calls[0].reasoningEffort, undefined)
  })

  // ── 会话压力判据（需求：别把轻活也拦了） ──────
  // 旧行为：`pressure >= sessionPressureTokens` 是**独立拦截判据**，
  // 会话一超阈值，峰时连「算一下 1+1」「在吗」都被无差别拦下。
  await checkAsync('压力大 + 白名单轻活 = 照样放行', async () => {
    at(PEAK)
    const { handlers } = harness({ sessionPressureTokens: 100000 }, { tokenMeter: { measure: () => ({ totalTokens: 500000 }) } })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(), '算一下 12*37 等于多少'),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1, '压力判据绝不该独立拦下白名单轻活')
  })

  await checkAsync('压力大 + 很短的普通问句（没命中白名单）= 仍放行', async () => {
    at(PEAK)
    const { handlers } = harness({ sessionPressureTokens: 100000 }, { tokenMeter: { measure: () => ({ totalTokens: 500000 }) } })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(), '在吗'),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1, '压力不是"拦不拦"的判据')
  })

  await checkAsync('压力大 + 分类判轻 = 放行（压力只提升敏感度，不单独拦）', async () => {
    at(PEAK)
    const llm = fakeLlm('a')
    const { handlers } = harness({ sessionPressureTokens: 100000 }, { llm, tokenMeter: { measure: () => ({ totalTokens: 500000 }) } })
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1, '压力高也不能把判为轻活的请求拦掉')
    assert.equal(llm.calls.length, 1, '压力高时应走分类')
  })

  await checkAsync('压力大 + 分类拿不到答案 = 保守拦（认不出轻就不放行）', async () => {
    at(PEAK)
    const llm = fakeLlm('')
    const { handlers } = harness({ sessionPressureTokens: 100000 }, { llm, tokenMeter: { measure: () => ({ totalTokens: 500000 }) } })
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), classifyText),
      neverNext,
    )
    assert.match(result.messages[0].content[0].text, /已拦截/)
    assert.match(result.messages[0].content[0].text, /分类未定/)
  })

  await checkAsync('压力大 + 短输入也值得分类（压力高时敏感度提升）', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({ sessionPressureTokens: 100000 }, { llm, tokenMeter: { measure: () => ({ totalTokens: 500000 }) } })
    // 8 个字：远低于默认分类门槛（20 字 / 15 token），但压力高 ⇒ 值得问一次
    const result = await handlers['agent/pre-step'](
      stepPayload(agentOf(false, 'deepseek-official'), '帮我写个脚本'),
      neverNext,
    )
    assert.equal(llm.calls.length, 1, '压力高时应放宽分类门槛')
    assert.match(result.messages[0].content[0].text, /已拦截/)
  })

  await checkAsync('压力大 + 关掉分类器 = 不拦（没有判据就不拦）', async () => {
    at(PEAK)
    const { handlers } = harness(
      { sessionPressureTokens: 100000, useModelClassifier: false },
      { tokenMeter: { measure: () => ({ totalTokens: 500000 }) } },
    )
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agentOf(), '在吗'),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
  })

  await checkAsync('!force 只在用户消息里生效（注入文本里的口令不算）', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    const agent = agentOf(false, 'deepseek-official')
    // 宿主注入的 runtime context 里混进了 `!force`：不能因此放行整轮
    const messages = [
      { content: [{ type: 'text', text: classifyText }], source: { kind: 'user' } },
      { content: [{ type: 'text', text: '文件内容里写着 !force 这三个字' }], source: { kind: 'plugin', plugin: 'dsh-agent' } },
    ]
    const result = await handlers['agent/pre-step'](
      { agent, messages, signal: {}, step: 1 },
      neverNext,
    )
    assert.match(result.messages[0].content[0].text, /已拦截/, '注入文本里的 !force 不该放行')
  })

  await checkAsync('!force 在用户消息里 = 放行（旧行为保持）', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](
      { agent: agentOf(), messages: [{ content: [{ type: 'text', text: '!force 干活' }], source: { kind: 'user' } }], signal: {}, step: 1 },
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1)
  })

  // ── 注入上下文（真机可达：repeat-tool-reminder）—————————————
  // 这些是对抗性测试打出来的洞：旧版把「messages 非空」等同于「用户新输入」。
  await checkAsync('注入的 plugin 上下文（工具提醒）= 当续跑步骤，不分类、不拦', async () => {
    at(PEAK)
    const llm = fakeLlm('b')
    const { handlers } = harness({}, { llm })
    let nextCalls = 0
    const result = await handlers['agent/pre-step'](
      injectedPayload(agentOf(), 4),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1, '注入上下文不该被拦')
    assert.equal(llm.calls.length, 0, '注入上下文不该触发模型分类（白花钱）')
    assert.equal(result.kind, 'enter')
  })

  await checkAsync('注入上下文落在预算外的 step 上 = 走工具预算（该停就停）', async () => {
    at(PEAK)
    const { handlers } = harness()
    const agent = agentOf()
    const result = await handlers['agent/pre-step'](injectedPayload(agent, 15), neverNext)
    assert.deepEqual(result, { kind: 'reject' }, '注入步骤也要受工具预算管')
    assert.equal(agent.session.appended.length, 1)
  })

  await checkAsync('注入上下文不会清掉 !force 的整轮豁免', async () => {
    at(PEAK)
    const { handlers } = harness()
    const agent = agentOf()
    await handlers['agent/pre-step'](stepPayload(agent, '!force 干活'), async () => enterNext())
    // 工具循环中途被注入一条提醒（step 不是用户输入）
    await handlers['agent/pre-step'](injectedPayload(agent, 6), async () => enterNext())
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agent, 20), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1, '口令的整轮豁免不该被注入步骤清掉')
    assert.equal(agent.session.appended.length, 0)
  })

  await checkAsync('用户消息 + 注入上下文混在一起 = 仍算用户输入', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    const payload = {
      agent: agentOf(),
      messages: [
        { content: [{ type: 'text', text: '算一下 1+1' }], source: { kind: 'user' } },
        { content: [{ type: 'text', text: '注入的上下文' }], source: { kind: 'plugin', plugin: 'x' } },
      ],
      signal: {},
      step: 1,
    }
    await handlers['agent/pre-step'](payload, async () => { nextCalls += 1; return enterNext() })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('hasUserInput：白名单判据（2026-09-12 从黑名单改过来）', () => {
    assert.equal(hasUserInput([]), false)
    assert.equal(hasUserInput(undefined), false)
    assert.equal(hasUserInput([{ source: { kind: 'plugin' } }]), false)
    assert.equal(hasUserInput([{ source: { kind: 'user' } }]), true)
    assert.equal(hasUserInput([{ content: [] }]), false, '没有 source 的不再当用户输入（宁可漏判不可误判）')
    // 🩸 这次改判据要防的两类真实注入（真机日志实测存在，源码行号见 hasUserInput 注释）
    assert.equal(hasUserInput([{ source: { kind: 'goal' } }]), false, 'goal 自动轮不是用户输入')
    assert.equal(hasUserInput([{ source: { kind: 'agent-instructions' } }]), false, 'AGENTS.md 重注入不是用户输入')
    assert.equal(hasUserInput([{ source: { kind: 'subagent-settled' } }]), false, '子代理交回成果不是用户输入')
    assert.equal(hasUserInput([{ source: { kind: 'agent-message' } }]), false)
    assert.equal(hasUserInput([{ source: { kind: 'tool' } }]), false)
  })

  // ── 子代理与工具预算（对抗性测试发现）────────────────────────
  await checkAsync('默认 blockSubagents=false：子代理的续跑步骤不被预算拦', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agentOf(true), 99), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1, 'README 承诺：默认不拦子代理（拦了主任务半路断掉）')
  })

  await checkAsync('blockSubagents=true：子代理的续跑步骤才被预算拦', async () => {
    at(PEAK)
    const { handlers } = harness({ blockSubagents: true })
    const agent = agentOf(true)
    const result = await handlers['agent/pre-step'](resumePayload(agent, 99), neverNext)
    assert.deepEqual(result, { kind: 'reject' })
  })

  // ── 解析与边界的零散加固（对抗性测试发现）──────────────
  await checkAsync('预算：小数 peakMaxSteps 不提前停', () => {
    assert.equal(overStepBudget({ step: 1, messageCount: 0, maxSteps: 0.5 }), false)
    assert.equal(overStepBudget({ step: 2, messageCount: 0, maxSteps: 1.5 }), true)
  })

  // ── 9. v2 第 3 层：工具预算 ────────────────────────────────
  await checkAsync('峰时第 12 步还在跑（不拦）', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agentOf(), 12), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('峰时第 13 步 = 停下（reject）、不发模型请求、提示写进会话', async () => {
    at(PEAK)
    const { handlers, logs } = harness()
    const agent = agentOf()
    // 🩸 必须是 `reject`：宿主 agent loop 里只有它能让本轮真正结束
    // （`{kind:'enter', messages:[]}` 在 turnEnds 为 null 时会被忽略，照样发请求 —— 实测踩过）
    const result = await handlers['agent/pre-step'](resumePayload(agent, 13), neverNext)
    assert.deepEqual(result, { kind: 'reject' }, '只有 reject 能真正结束本 turn')
    assert.equal(agent.session.appended.length, 1, '应把提示写进会话')
    const [event] = agent.session.appended
    assert.equal(event.type, 'user/message')
    assert.deepEqual(event.opts, { surfaceOp: 'append' })
    assert.match(event.data.content[0].text, /工具预算已用完/)
    assert.match(event.data.content[0].text, /!force/)
    assert.equal(event.data.source?.plugin, 'peak-gate')
    assert.ok(logs.some(([level]) => level === 'warn'))
  })

  await checkAsync('同一会话同一轮再进来 = 继续停下（不重复写提示）', async () => {
    at(PEAK)
    const { handlers } = harness()
    const agent = agentOf()
    await handlers['agent/pre-step'](resumePayload(agent, 13), neverNext)
    const result = await handlers['agent/pre-step'](resumePayload(agent, 14), neverNext)
    assert.deepEqual(result, { kind: 'reject' })
    assert.equal(agent.session.appended.length, 1, '不重复刷提示')
  })

  await checkAsync('用户下一条消息 = 清掉预算标记，重新开一轮', async () => {
    at(PEAK)
    const llm = fakeLlm('a')
    const { handlers } = harness({ bigTaskTokens: 100000, bigTaskChars: 100000 }, { llm })
    const agent = agentOf(false, 'deepseek-official')
    await handlers['agent/pre-step'](resumePayload(agent, 13), neverNext)
    assert.equal(agent.session.appended.length, 1)
    // 新的一轮（用户输入那一步）：清标记
    await handlers['agent/pre-step'](stepPayload(agent, '继续'), async () => enterNext())
    // 新一轮的第 3 步应当放行
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agent, 3), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1, '新一轮不该继承上一轮的「已停」状态')
  })

  await checkAsync('谷时续跑步骤不受预算限制', async () => {
    at(OFFPEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agentOf(), 99), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('peakMaxSteps=0 = 关闭工具预算', async () => {
    at(PEAK)
    const { handlers } = harness({ peakMaxSteps: 0 })
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agentOf(), 500), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('manageSubagents=false 时子代理续跑不受预算管', async () => {
    at(PEAK)
    const { handlers } = harness({ manageSubagents: false })
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agentOf(true), 99), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  await checkAsync('会话写不进提示时 = 退回让模型转述（用户仍看得见）', async () => {
    at(PEAK)
    const { handlers, logs } = harness()
    const agent = agentOf()
    agent.session.append = () => {
      throw new Error('append boom')
    }
    const result = await handlers['agent/pre-step'](resumePayload(agent, 13), neverNext)
    assert.equal(result.kind, 'enter')
    assert.equal(result.messages.length, 1, '写不进会话就用一条 notice 顶替')
    assert.match(result.messages[0].content[0].text, /工具预算已用完/)
    assert.ok(logs.some(([level, a]) => level === 'warn' && String(a[0]).includes('写入会话失败')))
  })

  await checkAsync('预算：带 !force 的整轮豁免（纯函数）', () => {
    assert.equal(overStepBudget({ step: 99, messageCount: 0, maxSteps: 12, forceExempt: true }), false)
  })

  await checkAsync('带 !force 的用户消息 = 本轮后续续跑步骤也不再被预算拦', async () => {
    at(PEAK)
    // 真机教训（2026-09-11 18:4x 连踩两次）：`!force` 原本只管「拦不拦这次请求」，
    // 管不了续跑步骤的工具预算 ⇒ 用户带了口令也跑 12 步就被停下，长任务根本干不完。
    const { handlers } = harness()
    const agent = agentOf()
    let nextCalls = 0
    await handlers['agent/pre-step'](
      stepPayload(agent, '!force 继续干活'),
      async () => { nextCalls += 1; return enterNext() },
    )
    assert.equal(nextCalls, 1, '口令那一步当然放行')
    const result = await handlers['agent/pre-step'](resumePayload(agent, 99), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 2, '同一轮的续跑步骤也该放行')
    assert.equal(result.kind, 'enter')
    assert.equal(agent.session.appended.length, 0, '不该写预算提示')
  })

  await checkAsync('没带 !force 的下一轮 = 豁免失效（预算重新生效）', async () => {
    at(PEAK)
    const { handlers } = harness()
    const agent = agentOf()
    await handlers['agent/pre-step'](stepPayload(agent, '!force 先干一轮'), async () => enterNext())
    await handlers['agent/pre-step'](stepPayload(agent, '这一轮不带口令'), async () => enterNext())
    const result = await handlers['agent/pre-step'](resumePayload(agent, 13), neverNext)
    assert.deepEqual(result, { kind: 'reject' })
    assert.equal(agent.session.appended.length, 1, '新一轮应恢复预算拦截')
  })

  await checkAsync('dryRun 时工具预算不真停（只记日志）', async () => {
    at(PEAK)
    const { handlers, logs } = harness({ dryRun: true })
    const agent = agentOf()
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agent, 13), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1, 'dry-run 不打断用户的活儿')
    assert.equal(agent.session.appended.length, 0)
    assert.ok(logs.some(([level]) => level === 'warn'))
  })

  await checkAsync('agent/pre-step 传入坏的 step 也不炸（放行保平安）', async () => {
    at(PEAK)
    const { handlers } = harness()
    let nextCalls = 0
    await handlers['agent/pre-step'](resumePayload(agentOf(), undefined), async () => {
      nextCalls += 1
      return enterNext()
    })
    assert.equal(nextCalls, 1)
  })

  // ── 5. agent/request ───────────────────────────────────────
  await checkAsync('峰时补上 maxTokens 上限', async () => {
    at(PEAK)
    const { handlers } = harness()
    const result = await handlers['agent/request']({ agent: agentOf() }, async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
    }))
    assert.equal(result.maxTokens, 32768)
  })

  await checkAsync('峰时压低已有的 maxTokens', async () => {
    at(PEAK)
    const { handlers } = harness()
    const result = await handlers['agent/request']({ agent: agentOf() }, async () => ({
      provider: 'p',
      model: 'm',
      maxTokens: 200000,
    }))
    assert.equal(result.maxTokens, 32768)
  })

  await checkAsync('已低于上限时不动 maxTokens', async () => {
    at(PEAK)
    const { handlers } = harness()
    const result = await handlers['agent/request']({ agent: agentOf() }, async () => ({
      provider: 'p',
      model: 'm',
      maxTokens: 4096,
    }))
    assert.equal(result.maxTokens, 4096)
  })

  await checkAsync('谷时不碰 maxTokens', async () => {
    at(OFFPEAK)
    const { handlers } = harness()
    const result = await handlers['agent/request']({ agent: agentOf() }, async () => ({
      provider: 'p',
      model: 'm',
      maxTokens: 200000,
    }))
    assert.equal(result.maxTokens, 200000)
  })

  await checkAsync('子代理用更小的上限', async () => {
    at(PEAK)
    const { handlers } = harness()
    const result = await handlers['agent/request']({ agent: agentOf(true) }, async () => ({
      provider: 'p',
      model: 'm',
    }))
    assert.equal(result.maxTokens, 16384)
  })

  await checkAsync('provider 白名单外时不压 maxTokens', async () => {
    at(PEAK)
    const { handlers } = harness({ officialProviders: ['deepseek-official'] })
    const result = await handlers['agent/request']({ agent: agentOf() }, async () => ({
      provider: 'my-relay',
      model: 'm',
    }))
    assert.equal(result.maxTokens, undefined)
  })

  // ── 6. systemPrompt 峰时精简段 ──────────────────────────────
  check('注册了 peak:brevity 提示段（order 60）', () => {
    const { sections } = harness()
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'peak:brevity')
    assert.equal(sections[0].order, 60)
  })
  check('峰时精简段给出文案', () => {
    at(PEAK)
    const { sections } = harness()
    assert.match(sections[0].text(), /峰时精简模式/)
  })
  check('谷时精简段为空串', () => {
    at(OFFPEAK)
    const { sections } = harness()
    assert.equal(sections[0].text(), '')
  })
  check('brevitySection=false 时也注册 section，但文案为空串（支持热开）', () => {
    // 旧版在 apply 里判一次 `if (scope.get().brevitySection)` ⇒ false→true 的热改不生效，
    // 与 README「热改即时生效」矛盾（对抗性测试发现）。现在无条件注册，开关放进 text()。
    const { sections } = harness({ brevitySection: false })
    assert.equal(sections.length, 1, '应注册（否则热开不了）')
    assert.equal(sections[0].text(), '', '关着的时候文案为空')
  })
  check('brevitySection 从 false 热改成 true = 立即生效', () => {
    at(PEAK)
    const { sections, set } = harness({ brevitySection: false })
    assert.equal(sections[0].text(), '')
    set({ brevitySection: true })
    assert.match(sections[0].text(), /峰时精简模式/, '热改后应立刻给出文案')
  })

  // ── 10. 峰谷日历：联网 / 磁盘缓存 / 内置兜底 三层 ─────────────
  // 样例放假日：天数**必须不少于下界**（`MIN_OFF_DAYS_PER_YEAR = 15`），
  // 否则会被 `parseHolidayDoc` 判成"可疑/半截响应"（之后加的下界）。
  const SAMPLE_OFF = Array.from({ length: 15 }, (_, index) => `2026-01-${String(index + 1).padStart(2, '0')}`)
  const HOL_DOC = JSON.stringify({ year: 2026, days: SAMPLE_OFF.map((date) => ({ date, isOffDay: true })) })
  /** 内存版 fs（不碰真实磁盘）。 */
  const memIo = (initial = {}) => {
    const files = { ...initial }
    return {
      files,
      io: {
        readFile: async (p) => {
          if (!(p in files)) { const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err }
          return files[p]
        },
        writeFile: async (p, data) => { files[p] = data },
        mkdir: async () => {},
      },
    }
  }
  const okFetch = (payload = HOL_DOC, calls = []) => async (url) => {
    calls.push(url)
    return { ok: true, status: 200, text: async () => payload }
  }

  await checkAsync('日历联网：第一个源成功就不试第二个', async () => {
    const calls = []
    const r = await fetchHolidayYear(2026, {
      urls: ['https://a/{year}.json', 'https://b/{year}.json'],
      fetchImpl: okFetch(HOL_DOC, calls),
    })
    assert.equal(r.ok, true)
    assert.equal(r.source, 'https://a/2026.json')
    assert.equal(calls.length, 1)
    assert.equal(r.offDays.length, 15)
  })
  await checkAsync('日历联网：第一个源 500 就换下一个源', async () => {
    const calls = []
    const fetchImpl = async (url) => {
      calls.push(url)
      if (url.includes('a/')) return { ok: false, status: 500, text: async () => '' }
      return { ok: true, status: 200, text: async () => HOL_DOC }
    }
    const r = await fetchHolidayYear(2026, { urls: ['https://a/{year}.json', 'https://b/{year}.json'], fetchImpl })
    assert.equal(r.ok, true)
    assert.equal(r.source, 'https://b/2026.json')
    assert.equal(calls.length, 2)
  })
  await checkAsync('日历联网：全失败 → ok=false 且列清每次尝试的原因', async () => {
    const fetchImpl = async () => { throw new Error('网络炸了') }
    const r = await fetchHolidayYear(2026, { urls: ['https://a/{year}.json', 'https://b/{year}.json'], fetchImpl })
    assert.equal(r.ok, false)
    assert.equal(r.attempts.length, 2)
    assert.match(r.attempts[0], /网络炸了/)
  })
  await checkAsync('日历联网：投毒 / 半截数据不会被当成日历', async () => {
    const r = await fetchHolidayYear(2026, {
      urls: ['https://a/{year}.json'],
      fetchImpl: okFetch(JSON.stringify({ year: 2026, days: [] })),
    })
    assert.equal(r.ok, false)
    assert.match(r.attempts[0], /可疑/)
  })
  await checkAsync('日历联网：年份不符的源会被跳过（防串年）', async () => {
    const wrong = JSON.stringify({
      year: 2025,
      days: SAMPLE_OFF.map((date) => ({ date: date.replace('2026', '2025'), isOffDay: true })),
    })
    const r = await fetchHolidayYear(2026, { urls: ['https://a/{year}.json'], fetchImpl: okFetch(wrong) })
    assert.equal(r.ok, false)
    assert.match(r.attempts[0], /年份不符/)
  })
  await checkAsync('日历组装：无缓存 + 联网成功 → 用网络数据并写缓存', async () => {
    const { files, io } = memIo()
    const r = await resolveHolidayCalendar({
      nowMs: utc(2026, 10, 1, 2),
      cachePath: 'X:/cache.json',
      io,
      fetchImpl: okFetch(),
      urls: ['https://a/{year}.json'],
    })
    assert.equal(r.source, 'network+cache')
    assert.equal(isHolidayDate('2026-01-03', r.calendar), true)
    assert.ok('X:/cache.json' in files, '应把日历写进缓存')
    assert.ok(r.warnings.every((w) => !w.includes('未覆盖')), '当年有数据就不该报未覆盖')
    // 缓存与内置兜底重合时不该重复（重复会让计数虚高，14 = 7+7）。
    assert.equal(new Set(r.calendar).size, r.calendar.length, '日历不该有重复条目')
  })
  await checkAsync('日历组装：联网失败但有旧缓存 → 用缓存 + 告警（不静默）', async () => {
    const cache = JSON.stringify({ fetchedAt: 0, years: { 2026: { offDays: SAMPLE_OFF, workdays: [] } } })
    const { io } = memIo({ 'X:/c.json': cache })
    const fetchImpl = async () => { throw new Error('断网') }
    const r = await resolveHolidayCalendar({
      nowMs: utc(2026, 10, 1, 2),
      cachePath: 'X:/c.json',
      io,
      fetchImpl,
      urls: ['https://a/{year}.json'],
    })
    assert.equal(r.source, 'cache')
    assert.equal(isHolidayDate('2026-01-02', r.calendar), true)
    assert.ok(r.warnings.some((w) => w.includes('联网更新失败')))
  })
  await checkAsync('日历组装：关掉自动更新又没缓存 → 内置兜底 + 必须告警', async () => {
    const { io } = memIo()
    const r = await resolveHolidayCalendar({
      nowMs: utc(2026, 10, 1, 2),
      cachePath: 'X:/none.json',
      io,
      autoRefresh: false,
    })
    assert.equal(r.source, 'builtin')
    assert.ok(r.warnings.length > 0, '不能静默')
    assert.equal(isHolidayDate('2026-10-01', r.calendar), true)
  })
  await checkAsync('日历组装：显式空源 = 一个请求都不发', async () => {
    const { io } = memIo()
    let calls = 0
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => HOL_DOC } }
    const r = await resolveHolidayCalendar({
      nowMs: utc(2026, 10, 1, 2),
      cachePath: 'X:/none.json',
      io,
      fetchImpl,
      urls: [],
    })
    assert.equal(calls, 0)
    assert.equal(r.source, 'builtin')
    assert.ok(r.warnings.some((w) => w.includes('日历源为空')))
  })
  await checkAsync('日历组装：缓存新鲜时不联网（省流量）', async () => {
    const cache = JSON.stringify({ fetchedAt: utc(2026, 10, 1, 2), years: { 2026: { offDays: SAMPLE_OFF, workdays: [] } } })
    const { io } = memIo({ 'X:/c.json': cache })
    let calls = 0
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => HOL_DOC } }
    const r = await resolveHolidayCalendar({
      nowMs: utc(2026, 10, 1, 2),
      cachePath: 'X:/c.json',
      io,
      fetchImpl,
      urls: ['https://a/{year}.json'],
    })
    assert.equal(calls, 0)
    assert.equal(r.source, 'cache')
  })

  // ── 对抗性审查修复的回填用例（异步段） ────────────────
  await checkAsync('缓存：fetchedAt 在未来 ⇒ 判损坏、告警、重新联网', async () => {
    const future = JSON.stringify({ fetchedAt: Date.now() + 100 * 365 * 86400000, years: { 2026: { offDays: SAMPLE_OFF, workdays: [] } } })
    const { io } = memIo({ 'X:/future.json': future })
    let calls = 0
    const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => HOL_DOC } }
    const r = await resolveHolidayCalendar({
      nowMs: Date.now(),
      cachePath: 'X:/future.json',
      io,
      fetchImpl,
      urls: ['https://a/{year}.json'],
    })
    assert.equal(calls, 1, '未来时间戳的缓存应被忽略并重新拉取')
    assert.ok(r.warnings.some((w) => w.includes('时间戳异常')))
  })
  await checkAsync('合并：联网只回半截 ⇒ 与已有缓存**取并集**，不覆盖', async () => {
    const ideal = [
      '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
    ]
    const cache = JSON.stringify({ fetchedAt: 0, years: { 2026: { offDays: ideal, workdays: [] } } })
    const { io } = memIo({ 'X:/c.json': cache })
    // 半截但**合法**（20 天）的响应，且不含国庆 —— 旧版会整体覆盖上去，国庆就消失了
    const partial = Array.from({ length: 20 }, (_, index) => ({ date: `2026-03-${String(index + 1).padStart(2, '0')}`, isOffDay: true }))
    const r = await resolveHolidayCalendar({
      nowMs: utc(2026, 10, 1, 2),
      cachePath: 'X:/c.json',
      io,
      fetchImpl: okFetch(JSON.stringify({ year: 2026, days: partial })),
      urls: ['https://a/{year}.json'],
    })
    assert.equal(isHolidayDate('2026-10-01', r.calendar), true, '完整数据不该被半截响应覆盖')
    assert.equal(isHolidayDate('2026-03-05', r.calendar), true, '新数据应当并进去')
  })
  await checkAsync('联网：响应过大 ⇒ 该源判失败', async () => {
    const r = await fetchHolidayYear(2026, { urls: ['https://a/{year}.json'], fetchImpl: okFetch('x'.repeat(1_000_001)) })
    assert.equal(r.ok, false)
    assert.match(r.attempts[0], /响应过大/)
  })
  await checkAsync('组装：覆盖告警不再由 resolve 重复返回（去重）', async () => {
    const { io } = memIo()
    const r = await resolveHolidayCalendar({ nowMs: utc(2028, 10, 1, 2), cachePath: 'X:/none.json', io, autoRefresh: false })
    assert.ok(!r.warnings.some((w) => w.includes('覆盖')), '覆盖告警由 apply 侧的 checkHolidayCalendar 统一负责')
  })
  await checkAsync('缓存里的**调休上班日**也会进谷价日历', async () => {
    const cache = JSON.stringify({ fetchedAt: Date.now(), years: { 2026: { offDays: SAMPLE_OFF, workdays: ['2026-10-10'] } } })
    const { io } = memIo({ 'X:/c.json': cache })
    const r = await resolveHolidayCalendar({ nowMs: Date.now(), cachePath: 'X:/c.json', io, urls: [] })
    assert.equal(isHolidayDate('2026-10-10', r.calendar), true, '缓存里的补班日要按谷价')
    assert.equal(isHolidayDate('2026-10-11', r.calendar), false, '没标的日期不受影响')
  })

  check('apply 装配：关掉自动日历也不影响其它钩子（harness 已断网）', () => {
    at(PEAK)
    const { handlers } = harness()
    assert.equal(typeof handlers['agent/pre-step'], 'function')
  })

  Date.now = realNow
  console.log(results.join('\n'))
  const failed = results.filter((r) => r.startsWith('  FAIL')).length
  console.log(`\n共 ${results.length} 项，失败 ${failed} 项`)
}

await run()
