/**
 * Small cron parser for Schedule triggers, written fresh for AgentFlow.
 *
 * Format: `minute hour day-of-month month day-of-week` (five fields), plus
 * the common aliases `@hourly`, `@daily`, `@midnight`, `@weekly`,
 * `@monthly`, `@yearly`, `@annually`. Month and weekday names are accepted
 * (`jan`–`dec`, `sun`–`sat`; `0` and `7` both mean Sunday). Lists, ranges
 * and steps are supported (`1,15`, `9-17`, `*\/15`, `2-30/5`).
 *
 * Day-of-month / day-of-week follow the usual cron rule: when both fields
 * are restricted (neither is `*`) a date matches if EITHER matches; when
 * only one is restricted, that one decides.
 *
 * Times are matched in UTC unless a `timezone` (IANA name, e.g.
 * `Asia/Karachi`) is given, in which case the wall-clock parts in that
 * timezone are used.
 *
 * This is a parser, not a daemon: nothing here fires on its own. Schedules
 * fire only when `POST /api/triggers/check` is called — by the Vercel cron
 * entry in `vercel.json`, or by a manual hit.
 */

export type ParsedCron = {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  /** True when the field was a plain `*` (unrestricted). */
  dayOfMonthStar: boolean
  dayOfWeekStar: boolean
  raw: string
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (7 normalises to 0)
]

function parseField(
  text: string,
  fieldIndex: number,
  names?: Record<string, number>,
): Set<number> {
  const [min, max] = FIELD_RANGES[fieldIndex]
  const values = new Set<number>()
  const parts = text.split(',')
  for (const rawPart of parts) {
    const part = rawPart.trim().toLowerCase()
    if (!part) throw new Error(`Empty value in cron field ${fieldIndex + 1}`)
    const [rangeText, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Bad step "${stepText}" in cron field ${fieldIndex + 1}`)
    }
    let start: number
    let end: number
    if (rangeText === '*') {
      start = min
      end = max
    } else if (rangeText.includes('-')) {
      const [a, b] = rangeText.split('-')
      start = resolveValue(a, names, fieldIndex)
      end = resolveValue(b, names, fieldIndex)
    } else {
      start = resolveValue(rangeText, names, fieldIndex)
      end = stepText === undefined ? start : max
    }
    if (start < min || end > max || start > end) {
      throw new Error(
        `Value out of range in cron field ${fieldIndex + 1}: "${rawPart}" (allowed ${min}–${max})`,
      )
    }
    for (let v = start; v <= end; v += step) {
      // Day of week: 7 is Sunday, same as 0.
      values.add(fieldIndex === 4 && v === 7 ? 0 : v)
    }
  }
  return values
}

function resolveValue(
  text: string,
  names: Record<string, number> | undefined,
  fieldIndex: number,
): number {
  const lower = text.toLowerCase()
  if (names && lower in names) return names[lower]
  const n = Number(text)
  if (!Number.isInteger(n)) {
    throw new Error(`Bad value "${text}" in cron field ${fieldIndex + 1}`)
  }
  return n
}

/** Parse a cron expression. Throws with a plain message on anything invalid. */
export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('Cron expression is empty')
  }
  const trimmed = expression.trim().toLowerCase()
  const expanded = ALIASES[trimmed] ?? trimmed
  const fields = expanded.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression needs exactly 5 fields (minute hour day month weekday), got ${fields.length}: "${expression}"`,
    )
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields
  return {
    minute: parseField(minute, 0),
    hour: parseField(hour, 1),
    dayOfMonth: parseField(dayOfMonth, 2),
    month: parseField(month, 3, MONTH_NAMES),
    dayOfWeek: parseField(dayOfWeek, 4, WEEKDAY_NAMES),
    dayOfMonthStar: dayOfMonth === '*',
    dayOfWeekStar: dayOfWeek === '*',
    raw: expression.trim(),
  }
}

/** Same as parseCron, but returns an error string instead of throwing. */
export function validateCron(expression: string): { ok: true; cron: ParsedCron } | { ok: false; error: string } {
  try {
    return { ok: true, cron: parseCron(expression) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid cron expression' }
  }
}

type DateParts = {
  minute: number
  hour: number
  day: number
  month: number
  weekday: number // 0 = Sunday
}

function partsInTimezone(date: Date, timezone: string): DateParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const parts: Record<string, string> = {}
  for (const part of fmt.formatToParts(date)) {
    parts[part.type] = part.value
  }
  const weekdayName = (parts.weekday || 'Sun').slice(0, 3).toLowerCase()
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAY_NAMES[weekdayName] ?? 0,
  }
}

function partsUtc(date: Date): DateParts {
  return {
    minute: date.getUTCMinutes(),
    hour: date.getUTCHours(),
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    weekday: date.getUTCDay(),
  }
}

/**
 * True when the cron expression matches this minute. Seconds are ignored —
 * a schedule fires at most once per minute, and the check endpoint skips a
 * workflow it already fired in the current minute.
 */
export function isDue(cron: ParsedCron, date: Date = new Date(), timezone?: string): boolean {
  const parts = timezone ? partsInTimezone(date, timezone) : partsUtc(date)
  if (!cron.minute.has(parts.minute)) return false
  if (!cron.hour.has(parts.hour)) return false
  if (!cron.month.has(parts.month)) return false
  const domMatch = cron.dayOfMonth.has(parts.day)
  const dowMatch = cron.dayOfWeek.has(parts.weekday)
  const dayMatch =
    cron.dayOfMonthStar && cron.dayOfWeekStar
      ? true
      : cron.dayOfMonthStar
        ? dowMatch
        : cron.dayOfWeekStar
          ? domMatch
          : domMatch || dowMatch
  return dayMatch
}

/**
 * The next time after `from` (exclusive) when the expression is due, or
 * null when nothing matches within a year — for example 29 February in a
 * non-leap year combined with a February-only month field still finds the
 * next leap year, but a truly impossible expression returns null instead of
 * looping forever.
 */
export function nextRun(
  cron: ParsedCron,
  from: Date = new Date(),
  timezone?: string,
): Date | null {
  // Step minute by minute from the start of the next minute.
  let candidate = new Date(from.getTime())
  candidate.setUTCSeconds(0, 0)
  candidate = new Date(candidate.getTime() + 60_000)
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000
  while (candidate.getTime() <= limit) {
    if (isDue(cron, candidate, timezone)) return candidate
    candidate = new Date(candidate.getTime() + 60_000)
  }
  return null
}
