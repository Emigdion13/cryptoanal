/**
 * The desktop's indicators over past candles: each bar's calls and values, read as they would have
 * been when the bar closed.
 *
 * Computing once over the whole history is fast, but an indicator that looks ahead (a pivot drawn
 * where it formed, a higher timeframe's candle already complete) would read the future there.
 * `peekCheck` finds those by reading sample bars again from candles that end at the bar; `strict`
 * indicators are then read that way at every bar: slower, but only what was known then.
 */
import { aggregateSeconds, parseInterval, type IntervalDef } from '../../src/data/intervals'
import type { Candle } from '../../src/data/types'
import { defaultInputs, defaultStyles, INDICATOR_BY_TYPE } from '../../src/indicators/catalog'
import type { Drawing, IndicatorInstance, Output } from '../../src/indicators/types'
import { SIGNAL_BARS } from '../../src/indicators/calls'
import { computeContext, failedRead, readIndicator, type IndicatorRead } from './features'

/** Bars a strict read computes over: enough for a 30-minute feed's 150 bars. */
export const STRICT_BARS = 4_500

/** One bar's readings: call and values by indicator name. */
export interface BarRead {
  calls: Record<string, string>
  values: Record<string, Record<string, number | null>>
}

const ONE_MINUTE = parseInterval('1') as IntervalDef

function compute(product: string, inst: IndicatorInstance, bars: readonly Candle[]): Output {
  const def = INDICATOR_BY_TYPE.get(inst.type)!
  const ctx = computeContext(product, ONE_MINUTE, bars, (seconds) => aggregateSeconds(bars, seconds))
  return def.compute(bars, { ...defaultInputs(def), ...inst.inputs }, { ...defaultStyles(def), ...inst.styles }, ctx)
}

/** Reads bar after bar of one output fast: the call only needs the signals drawn in the last few bars. */
function reader(inst: IndicatorInstance, out: Output, bars: readonly Candle[]) {
  const signals = new Map<number, Drawing[]>()
  const keep: Drawing[] = []
  for (const d of out.drawings ?? []) {
    const x = d.type === 'shape' || d.type === 'triangle' ? d.x : d.type === 'text' && typeof d.x === 'number' ? Math.round(d.x) : null
    if (x === null) continue
    const list = signals.get(x) ?? []
    list.push(d)
    signals.set(x, list)
  }
  return (i: number): IndicatorRead => {
    keep.length = 0
    for (let x = i - SIGNAL_BARS; x <= i; x++) keep.push(...(signals.get(x) ?? []))
    return readIndicator(inst, { ...out, drawings: keep }, bars, i)
  }
}

const add = (into: BarRead, read: IndicatorRead) => {
  into.calls[read.name] = read.call
  into.values[read.name] = read.values
}

/**
 * Every bar from `from` (unix seconds, a bar's open) on, read at its close. `bars` start early enough
 * to warm the indicators up. Indicators in `strict` are read only from candles up to the bar.
 */
export function indicatorTimeline(product: string, bars: readonly Candle[], instances: readonly IndicatorInstance[], from: number, strict: ReadonlySet<string> = new Set()) {
  const first = bars.findIndex((b) => b.time >= from)
  const reads = new Map<number, BarRead>()
  if (first < 0) return reads
  for (let i = first; i < bars.length; i++) reads.set(bars[i].time, { calls: {}, values: {} })
  for (const inst of instances) {
    const def = INDICATOR_BY_TYPE.get(inst.type)!
    if (strict.has(def.short)) {
      for (let i = first; i < bars.length; i++) add(reads.get(bars[i].time)!, strictRead(product, inst, bars, i))
      continue
    }
    try {
      const read = reader(inst, compute(product, inst, bars), bars)
      for (let i = first; i < bars.length; i++) add(reads.get(bars[i].time)!, read(i))
    } catch (error) {
      for (let i = first; i < bars.length; i++) add(reads.get(bars[i].time)!, failedRead(inst, error))
    }
  }
  return reads
}

/** One indicator at bar `i`, computed only from the candles up to it. */
export function strictRead(product: string, inst: IndicatorInstance, bars: readonly Candle[], i: number): IndicatorRead {
  const window = bars.slice(Math.max(0, i + 1 - STRICT_BARS), i + 1)
  try {
    return readIndicator(inst, compute(product, inst, window), window, window.length - 1)
  } catch (error) {
    return failedRead(inst, error)
  }
}

const same = (a: IndicatorRead, b: IndicatorRead) => {
  if (a.call !== b.call) return false
  for (const [k, v] of Object.entries(a.values)) {
    const w = b.values[k]
    if (v === null || w === null || w === undefined) {
      if (v !== w) return false
    } else if (Math.abs(v - w) > Math.max(1e-6, Math.abs(v) * 1e-4)) return false
  }
  return true
}

/**
 * Which indicators read a bar differently once the next hour's candles are there: they peek. Each
 * of `samples` bars is read from the same STRICT_BARS candles up to it, then with the hour after
 * added, so a warm-up difference never counts.
 */
export function peekCheck(product: string, bars: readonly Candle[], instances: readonly IndicatorInstance[], samples = 30) {
  const ahead = 60
  const start = STRICT_BARS - 1
  const end = bars.length - 1 - ahead
  if (end <= start) throw new Error(`The peek check needs more than ${STRICT_BARS + ahead} candles.`)
  const at = Array.from({ length: samples }, (_, k) => Math.round(start + ((end - start) * (k + 0.5)) / samples))
  return instances.map((inst) => {
    const def = INDICATOR_BY_TYPE.get(inst.type)!
    let differs = 0
    let example: string | null = null
    for (const i of at) {
      const known = strictRead(product, inst, bars, i)
      const window = bars.slice(i + 1 - STRICT_BARS, i + 1 + ahead)
      let later: IndicatorRead
      try {
        later = readIndicator(inst, compute(product, inst, window), window, STRICT_BARS - 1)
      } catch (error) {
        later = failedRead(inst, error)
      }
      if (!same(known, later)) {
        differs += 1
        example ??= `${new Date(bars[i].time * 1000).toISOString()}: knew "${known.call}", an hour later "${later.call}"`
      }
    }
    return { name: def.short, differs, checked: at.length, example }
  })
}
