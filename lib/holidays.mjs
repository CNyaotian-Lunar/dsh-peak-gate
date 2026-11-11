/**
 * dsh-peak-gate · 中国法定节假日日历（纯逻辑 + 可注入 IO）
 *
 * 官方口径（2026-09 补充，见 https://www.ithome.com/0/100/4494.htm ）：
 *   「**调休上班的周末、中国法定节假日全天均按空闲时段计费**」
 * ⇒ 判定只需要一张「法定放假日」表：
 *    · 放假日（含落在工作日的中秋/国庆…）→ 全天谷价；
 *    · 调休上班的周末 → 官方明确**仍按空闲**，所以**不需要"补班日"反向表**；
 *      周末恒谷价，别把补班日恢复成高峰。
 *
 * 数据来源优先级（见 `resolveHolidayCalendar`）：
 *   ① 磁盘缓存（`~/.dsh/data/peak-gate/holidays-cn.json`，带 `fetchedAt`）
 *   ② 联网：`NateScarlet/holiday-cn`（社区按国务院公告生成，字段带 `isOffDay`）
 *   ③ 内置兜底 `DEFAULT_HOLIDAYS`（离线 / 首次启动可用）
 * 任何一层不可用时都返回 `warning`，由调用方**显式打日志** —— 绝不静默按工作日判峰。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * 内置兜底日历（**北京时间**日期，`YYYY-MM-DD` 或 `YYYY-MM-DD~YYYY-MM-DD` 闭区间）。
 *
 * 数据来源：国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04）。
 * 只是**离线兜底**：正常情况下由联网缓存（holiday-cn）自动更新，不必手改。
 */
export const DEFAULT_HOLIDAYS = [
  '2026-01-01~2026-01-03', // 元旦
  '2026-02-15~2026-02-23', // 春节
  '2026-04-04~2026-04-06', // 清明节
  '2026-05-01~2026-05-05', // 劳动节
  '2026-06-19~2026-06-21', // 端午节
  '2026-09-25~2026-09-27', // 中秋节
  '2026-10-01~2026-10-07', // 国庆节
]

/**
 * 内置兜底的**调休上班日**（国家标定，`YYYY-MM-DD`）。
 *
 * 🗓️ 为什么它也算谷价日：官方口径是「**调休上班的周末**、法定节假日全天均按空闲计费」——
 * 这条与 `weekendOffPeak` 开关**无关**：补班日**无条件按谷价**
 * （否则把 `weekendOffPeak` 关掉时，2026-10-10 这种"调休上班的周六"会被当高峰拦，
 * 与官方口径相反）。数据来源同 `DEFAULT_HOLIDAYS`（国务院办公厅 2026 年放假通知）。
 */
export const DEFAULT_MAKEUP_DAYS = [
  '2026-01-04', // 元旦调休
  '2026-02-14', // 春节调休
  '2026-02-28', // 春节调休
  '2026-05-09', // 劳动节调休
  '2026-09-20', // 国庆调休
  '2026-10-10', // 国庆调休
]

/** 日历源模板（`{year}` 替换成 4 位年份）；按顺序尝试，全失败才降级。 */
export const DEFAULT_HOLIDAY_URLS = [
  'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
  'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
  'https://gh-proxy.com/https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json',
]

/** 缓存最长可用天数：超过就先尝试联网；联网失败仍用旧缓存，但会告警。 */
export const DEFAULT_CACHE_MAX_AGE_DAYS = 30

/**
 * 一年里放假日数的**下界**：少于它 ⇒ 这份年份数据判「可疑」直接抛（防半截响应 / 投毒）。
 * 真实量级：2026 年含调休连休共 33 天，历年最少也有 ~11 天 ⇒ 取 15 既拦得住半截、又不误杀。
 * 🩸 原来是 5（太松）：一份只回 5 天的截断响应会被当成"有效 2027"，让国庆被**静默误拦**
 * （对抗性审查发现）。
 */
export const MIN_OFF_DAYS_PER_YEAR = 15

/** 一年里放假日数的**上界**：多于它 ⇒ 判可疑（防"全年都标成放假"把闸门悄悄废掉）。 */
export const MAX_OFF_DAYS_PER_YEAR = 45

/** 覆盖自检的**日级**阈值：当年落在日历里的放假日少于它 ⇒ 告警（"年份在不在"不够）。 */
export const MIN_YEAR_COVERAGE_DAYS = 10

/** 缓存 `fetchedAt` 最多允许比当前时间"未来"这么多（容忍轻微时钟漂移）；超过即判损坏。 */
export const CACHE_FUTURE_TOLERANCE_MS = 24 * 3600 * 1000

/** 单份日历文档的字符数上限（真实文档约 4.6 KB）——防超大响应把内存吃光。 */
export const MAX_HOLIDAY_DOC_BYTES = 1_000_000

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * 校验 `YYYY-MM-DD`（**含月份天数与闰年**）。
 * @param {unknown} value - 待校验值。
 * @returns {boolean} true 表示是形如 2026-10-01 的合法日期键。
 */
export function isDateKey(value) {
  const matched = DATE_KEY_RE.exec(String(value ?? '').trim())
  if (matched === null) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12 || day < 1) return false
  // 🩸 旧版只查 `day <= 31`，于是 `2026-02-31`、`2026-02-30` 都判合法；
  // 还会让 `mergeDateKeysToRanges` 用不存在的日期算"下一天"算错。
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return day <= daysInMonth
}

/**
 * 解析一条日历项：`YYYY-MM-DD` 或 `YYYY-MM-DD~YYYY-MM-DD`（闭区间）。
 * @param {unknown} spec - 日历项。
 * @returns {{start: string, end: string} | undefined} 合法返回区间；非法返回 undefined（宁可少算不误算）。
 */
export function parseHolidaySpec(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return undefined
  const parts = text.split('~')
  if (parts.length > 2) return undefined
  const start = parts[0].trim()
  const end = (parts.length === 2 ? parts[1] : parts[0]).trim()
  if (!isDateKey(start) || !isDateKey(end)) return undefined
  // 倒序区间视为非法：与其猜意图，不如报出来让人看见。
  if (end < start) return undefined
  return { start, end }
}

/** 解析缓存（日历项数组 → 区间数组），避免每次判定都重新解析。 */
let calendarMemoKey = ''
let calendarMemoRanges = []

/**
 * @param {unknown} calendar - 日历项数组。
 * @returns {{start: string, end: string}[]} 去重后的合法区间。
 */
function calendarRanges(calendar) {
  const specs = Array.isArray(calendar) ? calendar : []
  // 键必须**单射**：旧的 `specs.join('\u0000')` 会让 `['a','b']` 之类的不同数组撞成同一个键，
  // 从而复用错误的解析结果。
  const key = JSON.stringify(specs)
  if (key === calendarMemoKey) return calendarMemoRanges
  const ranges = []
  const seen = new Set()
  for (const spec of specs) {
    const range = parseHolidaySpec(spec)
    if (range === undefined) continue
    const id = `${range.start}~${range.end}`
    if (seen.has(id)) continue
    seen.add(id)
    ranges.push(range)
  }
  calendarMemoKey = key
  calendarMemoRanges = ranges
  return ranges
}

/**
 * 列出日历里解析不了的项（调用方应打日志，别让一条写错的日期静默失效）。
 * @param {unknown} calendar - 日历项数组。
 * @returns {string[]} 非法项原文。
 */
export function invalidHolidaySpecs(calendar) {
  const bad = []
  for (const spec of Array.isArray(calendar) ? calendar : []) {
    if (parseHolidaySpec(spec) === undefined) bad.push(String(spec))
  }
  return bad
}

/**
 * 某一天是否法定节假日（放假日）。
 * @param {string} dateKey - `YYYY-MM-DD`（北京时间口径）。
 * @param {unknown} calendar - 日历项数组。
 * @returns {boolean} true 表示全天谷价。
 */
export function isHolidayDate(dateKey, calendar = DEFAULT_HOLIDAYS) {
  const key = String(dateKey ?? '')
  if (key === '') return false
  for (const range of calendarRanges(calendar)) {
    if (key >= range.start && key <= range.end) return true
  }
  return false
}

/**
 * 北京时间日期键（不依赖本机时区）。
 * @param {number} timeMs - 毫秒时间戳。
 * @param {number} offsetMinutes - 时区偏移，默认 +480。
 * @returns {string} `YYYY-MM-DD`。
 */
export function beijingDateKey(timeMs, offsetMinutes = 480) {
  const shifted = new Date(Number(timeMs) + offsetMinutes * 60000)
  const pad = (value) => String(value).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * 把一堆日期键合并成尽量少的区间串（连续日期合并），用于喂给 `isPeakNow`。
 * @param {unknown} dateKeys - `YYYY-MM-DD` 数组。
 * @returns {string[]} 区间串数组。
 */
export function mergeDateKeysToRanges(dateKeys) {
  const days = [...new Set((Array.isArray(dateKeys) ? dateKeys : []).filter(isDateKey))].sort()
  const nextDay = (key) => {
    const date = new Date(`${key}T00:00:00Z`)
    date.setUTCDate(date.getUTCDate() + 1)
    return date.toISOString().slice(0, 10)
  }
  const out = []
  let start
  let prev
  for (const day of days) {
    if (start === undefined) {
      start = day
      prev = day
      continue
    }
    if (day === nextDay(prev)) {
      prev = day
      continue
    }
    out.push(start === prev ? start : `${start}~${prev}`)
    start = day
    prev = day
  }
  if (start !== undefined) out.push(start === prev ? start : `${start}~${prev}`)
  return out
}

/**
 * 列出日历覆盖到的年份（用于「日历未覆盖」自检）。
 * @param {unknown} calendar - 日历项数组。
 * @returns {number[]} 年份升序。
 */
export function calendarYears(calendar) {
  const years = new Set()
  for (const range of calendarRanges(calendar)) {
    const from = Number(range.start.slice(0, 4))
    const to = Number(range.end.slice(0, 4))
    for (let year = from; year <= to; year += 1) years.add(year)
  }
  return [...years].sort()
}

/**
 * 统计日历里**属于某一年**的放假日天数（日级覆盖自检用）。
 * 区间都很短（最长一个连休约 10 天），展开安全；仍加硬上限防病态输入。
 * @param {unknown} calendar - 日历项数组。
 * @param {number} year - 4 位年份。
 * @returns {number} 该年的放假日天数。
 */
export function countHolidayDaysInYear(calendar, year) {
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  let count = 0
  for (const range of calendarRanges(calendar)) {
    const start = range.start > from ? range.start : from
    const end = range.end < to ? range.end : to
    if (end < start) continue
    const cursor = new Date(`${start}T00:00:00Z`)
    const last = new Date(`${end}T00:00:00Z`)
    while (cursor <= last && count <= 400) {
      count += 1
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
  }
  return count
}

/**
 * 「日历未覆盖」自检：当年数据**不足**时返回警告文案。
 *
 * 为什么要它：节假日表逐年更新，若某年漏更新/只拉到半截，插件会**静默**把节假日当工作日判峰
 * （多拦用户的活）。用户对"会静默失效"零容忍 ⇒ 这里必须显式喊出来。
 *
 * 🩸 旧版只查「年份在不在」⇒ 一条跨年区间（`2026-12-28~2027-01-03`）
 * 或一份只回 5 天的截断数据都能骗过自检，于是 2027 国庆被静默误拦。现在是**日级**判定。
 *
 * @param {number} timeMs - 当前时刻。
 * @param {unknown} calendar - 最终生效的日历。
 * @param {number} offsetMinutes - 时区偏移。
 * @returns {string | undefined} 警告文案；覆盖正常时 undefined。
 */
export function holidayCoverageWarning(timeMs, calendar, offsetMinutes = 480) {
  const year = Number(beijingDateKey(timeMs, offsetMinutes).slice(0, 4))
  const specs = Array.isArray(calendar) ? calendar : []
  if (specs.length === 0) return `peak-gate: 节假日日历为空 —— ${year} 年的法定节假日会被按工作日判峰`
  const days = countHolidayDaysInYear(specs, year)
  if (days >= MIN_YEAR_COVERAGE_DAYS) return undefined
  const years = calendarYears(specs)
  return `peak-gate: 节假日日历对 ${year} 年覆盖不足（只有 ${days} 天放假日，少于 ${MIN_YEAR_COVERAGE_DAYS}；已覆盖年份：${years.join(', ') || '无'}）—— 该年的法定节假日可能被按工作日判峰，请检查联网更新或手动补 holidays`
}

/**
 * 解析 holiday-cn 的年度文档（也接受已解析的对象）。
 * 只取 `isOffDay === true` 的日期；`isOffDay === false` 是**调休上班日**，按官方口径仍算空闲，
 * 这里只记录下来供日志/排查，不参与判定。
 *
 * @param {string | object} raw - JSON 文本或对象。
 * @returns {{year: number, offDays: string[], workdays: string[]}} 解析结果。
 * @throws {Error} 结构不符 / 一整天放假日都没有时抛错（**绝不**当空日历用）。
 */
export function parseHolidayDoc(raw) {
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (doc === null || typeof doc !== 'object') throw new Error('日历文档不是对象')
  if (!Array.isArray(doc.days)) throw new Error('日历文档缺少 days 数组')
  const year = Number.isInteger(doc.year) ? doc.year : Number.NaN
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error('日历文档年份不可信')
  const offDays = []
  const workdays = []
  let foreign = 0
  for (const item of doc.days) {
    const date = String(item?.date ?? '')
    if (!isDateKey(date)) continue
    // 🩸 只认**属于 doc.year 的日期** —— 否则"请求 2026 却回一堆 2027 的日期"
    // 会被判成有效数据（只看 `doc.year === year` 是能被骗过的）。
    if (Number(date.slice(0, 4)) !== year) {
      foreign += 1
      continue
    }
    if (item?.isOffDay === true) offDays.push(date)
    else if (item?.isOffDay === false) workdays.push(date)
  }
  if (offDays.length < MIN_OFF_DAYS_PER_YEAR) {
    const extra = foreign > 0 ? `；另有 ${foreign} 条日期不属于该年` : ''
    throw new Error(`日历文档可疑：${year} 年只有 ${offDays.length} 天放假日（少于 ${MIN_OFF_DAYS_PER_YEAR}${extra}）`)
  }
  // 🩸 旧版只有下界 ⇒ 一份"全年 365 天都标成放假"的文档会被判有效，
  // 于是闸门静默 fail-open（用户既不被拦、也收不到任何提示）。
  if (offDays.length > MAX_OFF_DAYS_PER_YEAR) {
    throw new Error(`日历文档可疑：${year} 年有 ${offDays.length} 天放假日（多于 ${MAX_OFF_DAYS_PER_YEAR}，疑似被污染）`)
  }
  return { year, offDays, workdays }
}

/**
 * 拉取某一年的日历：按 `urls` 顺序逐个尝试，第一个成功即返回。
 * @param {number} year - 4 位年份。
 * @param {object} [options] - 选项。
 * @param {string[]} [options.urls] - 源模板数组。
 * @param {Function} [options.fetchImpl] - 注入的 fetch（自测用）。
 * @param {number} [options.timeoutMs] - 单源超时。
 * @returns {Promise<{ok: true, year: number, offDays: string[], workdays: string[], source: string} | {ok: false, error: string, attempts: string[]}>} 结果。
 */
export async function fetchHolidayYear(year, options = {}) {
  // 显式传空数组 = 「没有源，别联网」（自测/离线环境用）；不传才用默认三源。
  const urls = Array.isArray(options.urls) ? options.urls : DEFAULT_HOLIDAY_URLS
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000
  if (typeof fetchImpl !== 'function') return { ok: false, error: '运行环境没有可用的 fetch', attempts: [] }
  const attempts = []
  for (const template of urls) {
    const url = String(template).replaceAll('{year}', String(year))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
      if (response === undefined || response === null) {
        attempts.push(`${url} -> 空响应`)
        continue
      }
      if (response.ok !== true) {
        attempts.push(`${url} -> HTTP ${response.status}`)
        continue
      }
      const text = await response.text()
      // 🩸 旧版对响应体没有任何上限，可能被塞超大响应把内存吃光。
      if (typeof text !== 'string' || text.length > MAX_HOLIDAY_DOC_BYTES) {
        attempts.push(`${url} -> 响应过大（${typeof text === 'string' ? `${text.length} 字符` : '非文本'}）`)
        continue
      }
      const doc = parseHolidayDoc(text)
      if (doc.year !== year) {
        attempts.push(`${url} -> 年份不符（拿到 ${doc.year}）`)
        continue
      }
      return { ok: true, year, offDays: doc.offDays, workdays: doc.workdays, source: url }
    } catch (error) {
      attempts.push(`${url} -> ${error?.message ?? String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, error: `全部 ${urls.length} 个源都失败`, attempts }
}

/** 默认缓存路径：`<DSH_HOME>/data/peak-gate/holidays-cn.json`。 */
export function holidayCachePath(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(dshHome, 'data', 'peak-gate', 'holidays-cn.json')
}

const defaultIo = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  mkdir: (path) => mkdir(path, { recursive: true }),
}

/**
 * 读磁盘缓存。
 * @param {string} cachePath - 缓存文件路径。
 * @param {object} [io] - 注入的 fs 方法。
 * @param {number} [nowMs] - 当前时刻（用于判 `fetchedAt` 是否在未来）。
 * @returns {Promise<{years: Record<string, {offDays: string[], workdays: string[]}>, fetchedAt: number, futureStamp?: boolean} | undefined>} 缓存内容；读不到返回 undefined。
 */
export async function readHolidayCache(cachePath, io = defaultIo, nowMs = Date.now()) {
  try {
    const text = await io.readFile(cachePath)
    const doc = JSON.parse(text)
    const years = doc?.years
    if (years === null || typeof years !== 'object') return undefined
    const fetchedAt = Number(doc?.fetchedAt) || 0
    // 🩸 `fetchedAt` 在未来 ⇒ `ageMs` 为负 ⇒ 永远"新鲜"、永不刷新、零告警
    // （日历被永久冻结）。超过容差就判这份缓存坏了，让上层重新联网。
    if (fetchedAt > nowMs + CACHE_FUTURE_TOLERANCE_MS) return { years: {}, fetchedAt, futureStamp: true }
    const clean = {}
    for (const [key, value] of Object.entries(years)) {
      const year = Number(key)
      if (!Number.isInteger(year)) continue
      const raw = Array.isArray(value?.offDays) ? value.offDays.filter(isDateKey) : []
      // 🩸 只保留**属于该年份键**的日期 —— 否则随便塞一批别的年份的日期，
      // 就能让这一年"看起来有数据"、把覆盖自检顶掉。
      const offDays = raw.filter((day) => Number(day.slice(0, 4)) === year)
      if (offDays.length === 0) continue
      const workdays = Array.isArray(value?.workdays)
        ? value.workdays.filter((day) => isDateKey(day) && Number(day.slice(0, 4)) === year)
        : []
      clean[String(year)] = { offDays, workdays }
    }
    if (Object.keys(clean).length === 0) return undefined
    return { years: clean, fetchedAt }
  } catch {
    // 缓存不存在 / 坏了都算「没有缓存」：由上层决定联网或兜底，并告警。
    return undefined
  }
}

/**
 * 写磁盘缓存（失败不抛 —— 只是缓存，别影响插件主流程）。
 * @param {string} cachePath - 缓存文件路径。
 * @param {{years: object, fetchedAt: number}} payload - 内容。
 * @param {object} [io] - 注入的 fs 方法。
 * @returns {Promise<boolean>} 是否写成功。
 */
export async function writeHolidayCache(cachePath, payload, io = defaultIo) {
  try {
    await io.mkdir(dirname(cachePath))
    await io.writeFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 组装最终生效的日历。
 *
 * 顺序：**缓存 → 联网刷新 → 内置兜底**；任一层拿不到都记进 `warnings`。
 * 保证「永远有一份日历可用」：最差情况是内置表 + 一条显式告警。
 *
 * @param {object} [options] - 选项。
 * @param {number} [options.nowMs] - 当前时刻。
 * @param {number} [options.offsetMinutes] - 时区偏移。
 * @param {string} [options.cachePath] - 缓存路径。
 * @param {boolean} [options.autoRefresh] - 是否允许联网。
 * @param {string[]} [options.urls] - 源模板。
 * @param {number} [options.maxAgeDays] - 缓存最长可用天数。
 * @param {number} [options.timeoutMs] - 单源超时。
 * @param {Function} [options.fetchImpl] - 注入 fetch。
 * @param {object} [options.io] - 注入 fs。
 * @param {boolean} [options.forceRefresh] - 忽略缓存年龄，强制联网。
 * @returns {Promise<{calendar: string[], source: string, years: number[], network: string[], warnings: string[]}>} 结果。
 */
export async function resolveHolidayCalendar(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now()
  const offsetMinutes = Number.isFinite(options.offsetMinutes) ? Number(options.offsetMinutes) : 480
  const maxAgeDays = Number(options.maxAgeDays) > 0 ? Number(options.maxAgeDays) : DEFAULT_CACHE_MAX_AGE_DAYS
  const cachePath = typeof options.cachePath === 'string' && options.cachePath !== '' ? options.cachePath : holidayCachePath()
  const io = options.io ?? defaultIo
  const warnings = []
  const network = []

  const currentYear = Number(beijingDateKey(nowMs, offsetMinutes).slice(0, 4))
  // 只拉「当年」：次年公告通常 11 月才出，提前拉会 404 刷告警；缓存里已有的年份照用。
  const wanted = [currentYear]
  // 显式 `urls: []` = 「没有源」：跳过联网（自测 / 纯离线环境用），但仍可走缓存与兜底。
  const urls = Array.isArray(options.urls) ? options.urls : DEFAULT_HOLIDAY_URLS
  const canNetwork = urls.length > 0

  let cache = await readHolidayCache(cachePath, io, nowMs)
  // 🩸 `fetchedAt` 在未来时那份缓存会永远"新鲜"（ageMs 为负）⇒ 永不刷新、零告警。
  if (cache !== undefined && cache.futureStamp === true) {
    warnings.push(`peak-gate: 节假日缓存时间戳异常（fetchedAt=${new Date(cache.fetchedAt).toISOString()} 是未来时间）—— 已忽略该缓存并重新拉取`)
    cache = undefined
  }
  if (cache === undefined) warnings.push('peak-gate: 节假日缓存不存在或已损坏（将尝试联网刷新）')

  const ageMs = cache === undefined ? Number.POSITIVE_INFINITY : nowMs - cache.fetchedAt
  const stale = !Number.isFinite(ageMs) || ageMs > maxAgeDays * 86400000
  const autoRefresh = options.autoRefresh !== false
  if (autoRefresh && !canNetwork) warnings.push('peak-gate: 日历源为空（holidayCalendarUrls=[]），已跳过联网更新')
  const needNetwork = autoRefresh && canNetwork && (options.forceRefresh === true || stale || wanted.some((year) => cache?.years?.[String(year)] === undefined))

  if (needNetwork) {
    const fetched = {}
    for (const year of wanted) {
      const result = await fetchHolidayYear(year, {
        urls,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      })
      if (result.ok) {
        fetched[String(year)] = { offDays: result.offDays, workdays: result.workdays }
        network.push(`${year} <- ${result.source}（${result.offDays.length} 天放假 / ${result.workdays.length} 天补班）`)
      } else {
        warnings.push(`peak-gate: 节假日日历联网更新失败（${year}）：${result.error}；${result.attempts.join(' | ')}`)
      }
    }
    if (Object.keys(fetched).length > 0) {
      // 🩸 旧版是「同年**整体替换**」⇒ 一次半截响应（例如只回 5 天）会把磁盘/内存里
      // 完整的那一年覆盖掉，于是国庆被**静默误拦**。改成**取并集**：只增不减。
      const merged = { ...(cache?.years ?? {}) }
      for (const [year, value] of Object.entries(fetched)) {
        const previous = merged[year]
        merged[year] = {
          offDays: [...new Set([...(previous?.offDays ?? []), ...value.offDays])],
          workdays: [...new Set([...(previous?.workdays ?? []), ...value.workdays])],
        }
      }
      const payload = { fetchedAt: nowMs, years: merged }
      const written = await writeHolidayCache(cachePath, payload, io)
      if (!written) warnings.push('peak-gate: 节假日缓存写入失败（本次仍用内存里的新数据）')
      cache = { years: merged, fetchedAt: nowMs }
    }
  } else if (!autoRefresh && cache === undefined) {
    warnings.push('peak-gate: 自动更新已关闭且没有可用缓存 —— 只能用内置兜底日历')
  }

  // 🗓️ 「谷价日」= 放假日 ＋ **调休上班日**（官方口径里补班日也按空闲，与 `weekendOffPeak` 无关）。
  const offDays = []
  for (const year of Object.keys(cache?.years ?? {})) {
    offDays.push(...cache.years[year].offDays)
    offDays.push(...(cache.years[year].workdays ?? []))
  }
  const fromCache = mergeDateKeysToRanges(offDays)
  // 去重：缓存与内置兜底在同年重合时会出现重复条目（判定内部本来就会去重，
  // 但 `calendar.length` 会误导日志与界面 —— 重复条目会让它虚高，14 = 7+7）。
  // `includeBuiltin: false` ⇒ 只用自动日历，不再并入内置兜底（给"要手动收窄"的用户的开关）。
  const includeBuiltin = options.includeBuiltin !== false
  const builtinDays = includeBuiltin ? [...DEFAULT_HOLIDAYS, ...DEFAULT_MAKEUP_DAYS] : []
  const calendar = [...new Set([...fromCache, ...builtinDays])]
  const source = fromCache.length > 0 ? (network.length > 0 ? 'network+cache' : 'cache') : 'builtin'

  // ⚠️ 覆盖自检**故意不在这里**做：`checkHolidayCalendar`（index.mjs）已经负责，而且它会随配置
  // 热改重新自检。放这里会让启动时同一件事打两条告警。
  return { calendar, source, years: calendarYears(calendar), network, warnings }
}
