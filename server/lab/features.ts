/**
 * The desktop's indicators, computed here from Coinbase candles: what each one says at the last
 * closed bar (the call the phone's cards print, "BULL CROSS", "OVERSOLD"…) and its plot values.
 * The lab records these every minute and hands them to whoever trades.
 */
import { readFileSync } from 'node:fs'
import { fetchCandles, PAGE } from '../../src/data/coinbase'
import { aggregateSeconds, granularityFor, parseInterval, type IntervalDef } from '../../src/data/intervals'
import type { Candle } from '../../src/data/types'
import { defaultInputs, defaultStyles, INDICATOR_BY_TYPE } from '../../src/indicators/catalog'
import type { ComputeContext, IndicatorInstance, Output } from '../../src/indicators/types'
import { buildModel, verdictAt } from '../../src/ui/floatingModel'

/** One indicator's reading at a bar. */
export interface IndicatorRead {
  type: string
  name: string
  /** Drawn over the price (true) or in a pane of its own. */
  overlay: boolean
  /** The call, as the phone prints it, and its tone. */
  call: string
  tone: string
  /** Plot values at the bar (null where the plot has none). */
  values: Record<string, number | null>
}

export interface Features {
  product: string
  interval: string
  /** Open time of the bar read (the last closed one), unix seconds. */
  bar: number
  close: number
  indicators: IndicatorRead[]
}

type Fetch = typeof fetchCandles

/** The indicators on the desktop's first chart of this interval (any coin), hidden ones left out. */
export function desktopIndicators(workspacePath: string, interval: string): IndicatorInstance[] {
  try {
    const data = JSON.parse(readFileSync(workspacePath, 'utf8')) as { settings?: { charts?: { interval: string; indicators: IndicatorInstance[] }[] } }
    const chart = data.settings?.charts?.find((c) => c.interval === interval)
    return (chart?.indicators ?? []).filter((i) => !i.hidden && INDICATOR_BY_TYPE.has(i.type) && !INDICATOR_BY_TYPE.get(i.type)!.external)
  } catch {
    return []
  }
}

/** The latest PAGE candles of a Coinbase granularity. */
async function latest(fetcher: Fetch, product: string, granularity: number, now: number): Promise<Candle[]> {
  return fetcher(product, granularity, now - (PAGE - 1) * granularity, now)
}

/** Every indicator's reading at the last closed bar of `interval` (minute intervals and up). */
export async function computeFeatures(product: string, interval: string, instances: readonly IndicatorInstance[], now = Math.floor(Date.now() / 1000), fetcher: Fetch = fetchCandles): Promise<Features> {
  const iv = parseInterval(interval)
  if (!iv || iv.kind !== 'fixed' || iv.seconds % 60 !== 0) throw new Error(`The lab reads minute intervals and up, not ${interval}.`)
  const base = granularityFor(iv.seconds)
  const grans = new Set<number>([base])
  for (const inst of instances) {
    const def = INDICATOR_BY_TYPE.get(inst.type)!
    for (const seconds of def.feeds?.({ ...defaultInputs(def), ...inst.inputs }, iv) ?? []) grans.add(granularityFor(seconds))
  }
  const candles = new Map<number, Candle[]>()
  for (const g of grans) candles.set(g, await latest(fetcher, product, g, now))
  const raw = candles.get(base)!
  const bars = iv.seconds === base ? raw : aggregateSeconds(raw, iv.seconds)
  // The last bar whose time is over: its reading no longer changes.
  let i = bars.length - 1
  while (i >= 0 && bars[i].time + iv.seconds > now) i -= 1
  if (i < 1) throw new Error(`Coinbase sent no ${product} candles.`)

  const ctx = computeContext(product, iv, bars, (seconds) => {
    const source = candles.get(granularityFor(seconds)) ?? []
    return seconds === granularityFor(seconds) ? source : aggregateSeconds(source, seconds)
  })
  const indicators = instances.map((inst) => {
    const def = INDICATOR_BY_TYPE.get(inst.type)!
    try {
      const out = def.compute(bars, { ...defaultInputs(def), ...inst.inputs }, { ...defaultStyles(def), ...inst.styles }, ctx)
      return readIndicator(inst, out, bars, i)
    } catch (error) {
      return failedRead(inst, error)
    }
  })
  return { product, interval, bar: bars[i].time, close: bars[i].close, indicators }
}

/** What an indicator's compute needs besides the bars. */
export function computeContext(product: string, interval: IntervalDef, bars: readonly Candle[], feed: (seconds: number) => Candle[]): ComputeContext {
  return {
    interval,
    product,
    feed,
    timeToIndex: (time) => {
      let lo = 0
      let hi = bars.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (bars[mid].time <= time) lo = mid
        else hi = mid - 1
      }
      return lo + (time - bars[lo].time) / interval.seconds
    },
  }
}

/** An indicator's call and plot values at bar `i` of a computed output. */
export function readIndicator(inst: IndicatorInstance, out: Output, bars: readonly Candle[], i: number): IndicatorRead {
  const def = INDICATOR_BY_TYPE.get(inst.type)!
  const styles = { ...defaultStyles(def), ...inst.styles }
  const input = { def, out, bars, styles, end: i, count: 60 }
  let verdict = verdictAt({ ...input, i }, buildModel(input))
  // Over the price, a line's call is where the price is against it (a signal's call stays).
  if (def.overlay && !verdict.text.includes('·')) {
    const line = def.plots.find((p) => p.kind !== 'histogram' && p.kind !== 'value' && Number.isFinite(out.values[p.key]?.[i]))
    if (line) {
      const above = bars[i].close >= out.values[line.key][i]
      verdict = { text: `PRICE ${above ? 'ABOVE' : 'BELOW'} ${line.title.toUpperCase()}`, tone: above ? 'bull' : 'bear' }
    }
  }
  const values: Record<string, number | null> = {}
  for (const plot of def.plots) {
    const v = out.values[plot.key]?.[i]
    if (plot.kind === 'dots' && !Number.isFinite(v)) continue
    values[plot.title] = v !== undefined && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null
  }
  return { type: inst.type, name: def.short, overlay: def.overlay, call: verdict.text, tone: verdict.tone, values }
}

export function failedRead(inst: IndicatorInstance, error: unknown): IndicatorRead {
  const def = INDICATOR_BY_TYPE.get(inst.type)!
  return { type: inst.type, name: def.short, overlay: def.overlay, call: `ERROR: ${error instanceof Error ? error.message : String(error)}`, tone: 'flat', values: {} }
}
