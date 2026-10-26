import type { Candle } from './types'

/** Coinbase serves candles at these sizes only; every other interval is built from one of them. */
export const GRANULARITIES = [60, 300, 900, 3600, 21600, 86400] as const
export type Granularity = (typeof GRANULARITIES)[number]

export type IntervalGroup = 'minutes' | 'hours' | 'days'

export interface IntervalDef {
  /** TradingView-style id: minutes as a number ('1', '240'), or '1D', '1W', '1M'. */
  id: string
  /** Short label for the toolbar: 1m, 4h, D, W, M. */
  label: string
  /** Long name for menus: "4 hours". */
  name: string
  group: IntervalGroup
  /** Fixed buckets are aligned to the epoch; weeks start Monday, months on the 1st (UTC). */
  kind: 'fixed' | 'week' | 'month'
  /** Nominal length in seconds (a month counts as 30 days). */
  seconds: number
  intraday: boolean
}

const DAY = 86400
const WEEK = 7 * DAY
// 1970-01-05 was the first Monday after the epoch.
const MONDAY = 4 * DAY

function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/**
 * Reads what a user types or stores: '5', '60', '4h', '240', 'D', '1D', 'W', 'M'.
 * Minute intervals must split a day evenly so bars line up with UTC midnight, as on TradingView.
 */
export function parseInterval(input: string): IntervalDef | null {
  const text = input.trim()
  const match = /^(\d*)\s*([smhdwSMHDW]?)$/.exec(text)
  if (!match) return null
  const count = match[1] === '' ? 1 : Number(match[1])
  const unit = match[2]
  if (!Number.isInteger(count) || count <= 0) return null

  if (unit === 'M') return count === 1 ? MONTH : null
  switch (unit.toLowerCase()) {
    case 'w':
      return count === 1 ? WEEK_DEF : null
    case 'd':
      return count === 1 ? DAY_DEF : null
    case 'h':
      return minutes(count * 60)
    case 's':
      return null
    default:
      return minutes(count)
  }
}

function minutes(n: number): IntervalDef | null {
  if (n === 1440) return DAY_DEF
  if (n > 1440 || 1440 % n !== 0) return null
  const hours = n % 60 === 0
  return {
    id: String(n),
    label: hours ? `${n / 60}h` : `${n}m`,
    name: hours ? plural(n / 60, 'hour') : plural(n, 'minute'),
    group: hours ? 'hours' : 'minutes',
    kind: 'fixed',
    seconds: n * 60,
    intraday: true,
  }
}

const DAY_DEF: IntervalDef = {
  id: '1D',
  label: 'D',
  name: '1 day',
  group: 'days',
  kind: 'fixed',
  seconds: DAY,
  intraday: false,
}
const WEEK_DEF: IntervalDef = {
  id: '1W',
  label: 'W',
  name: '1 week',
  group: 'days',
  kind: 'week',
  seconds: WEEK,
  intraday: false,
}
const MONTH: IntervalDef = {
  id: '1M',
  label: 'M',
  name: '1 month',
  group: 'days',
  kind: 'month',
  seconds: 30 * DAY,
  intraday: false,
}

/** The interval menu, in TradingView's order. */
export const INTERVAL_MENU: IntervalDef[] = [
  '1', '2', '3', '5', '10', '15', '30', '45',
  '60', '120', '180', '240', '360', '720',
  '1D', '1W', '1M',
].map((id) => parseInterval(id)!)

/** The biggest Coinbase candle size that splits this interval evenly. */
export function baseGranularity(def: IntervalDef): Granularity {
  if (def.kind !== 'fixed') return 86400
  let best: Granularity = 60
  for (const g of GRANULARITIES) if (g <= def.seconds && def.seconds % g === 0) best = g
  return best
}

/** Start of the bar that holds `time` (seconds, UTC). */
export function bucketStart(def: IntervalDef, time: number): number {
  if (def.kind === 'fixed') return Math.floor(time / def.seconds) * def.seconds
  if (def.kind === 'week') return Math.floor((time - MONDAY) / WEEK) * WEEK + MONDAY
  const d = new Date(time * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000
}

/** Start of the bar after the one starting at `start`. */
export function nextBucket(def: IntervalDef, start: number): number {
  if (def.kind === 'fixed') return start + def.seconds
  if (def.kind === 'week') return start + WEEK
  const d = new Date(start * 1000)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000
}

function merge(into: Candle, c: Candle) {
  if (c.high > into.high) into.high = c.high
  if (c.low < into.low) into.low = c.low
  into.close = c.close
  into.volume += c.volume
}

/** Rolls base candles (sorted, oldest first) up into bars of `def`. */
export function aggregate(base: readonly Candle[], def: IntervalDef): Candle[] {
  if (def.kind === 'fixed' && base.length && baseGranularity(def) === def.seconds)
    return base.map((c) => ({ ...c }))
  const out: Candle[] = []
  let current: Candle | null = null
  for (const c of base) {
    const start = bucketStart(def, c.time)
    if (current && current.time === start) merge(current, c)
    else {
      current = { ...c, time: start }
      out.push(current)
    }
  }
  return out
}

/** Just the newest bar of `aggregate(base, def)`, without redoing the whole series. */
export function aggregateLast(base: readonly Candle[], def: IntervalDef): Candle | null {
  if (!base.length) return null
  const start = bucketStart(def, base[base.length - 1].time)
  let i = base.length - 1
  while (i > 0 && bucketStart(def, base[i - 1].time) === start) i--
  const bar: Candle = { ...base[i], time: start }
  for (let k = i + 1; k < base.length; k++) merge(bar, base[k])
  return bar
}
