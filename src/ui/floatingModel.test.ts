import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import { defaultStyles, INDICATOR_BY_TYPE, INDICATORS } from '../indicators/catalog'
import type { ComputeContext } from '../indicators/types'
import { buildModel, canFloat, clampBars, paneDomain, verdictAt } from './floatingModel'

// A gentle wave, so oscillators swing both ways.
const bars: Candle[] = Array.from({ length: 300 }, (_, i) => {
  const close = 100 + 10 * Math.sin(i / 9) + i * 0.02
  return { time: 1_700_000_000 + i * 300, open: close - 0.4, high: close + 1, low: close - 1, close, volume: 50 + (i % 7) }
})
const ctx: ComputeContext = {
  interval: { id: '5', label: '5m', name: '5 minutes', group: 'minutes', kind: 'fixed', seconds: 300, intraday: true },
  product: 'BTC-USD',
  feed: () => [],
  timeToIndex: () => 0,
}

function model(type: string, end = bars.length - 1, count = 30) {
  const def = INDICATOR_BY_TYPE.get(type)!
  const styles = defaultStyles(def)
  const inputs = Object.fromEntries(def.inputs.map((i) => [i.key, i.default]))
  const out = def.compute(bars, inputs, styles, ctx)
  const input = { def, out, bars, styles, end, count }
  return { input, model: buildModel(input) }
}

describe('floating windows', () => {
  it('only for indicators in a pane of their own, never overlays', () => {
    const floating = INDICATORS.filter(canFloat).map((d) => d.type)
    expect(floating).toEqual(expect.arrayContaining(['rsi', 'macd', 'stoch', 'stochRsi', 'cmUltMacd', 'tmoScalper', 'tmoLux']))
    for (const type of ['tuxEmaScalper', 'luxSrBreaks', 'smartMoneyConcepts', 'msbZigZag', 'kalshiStrike', 'ema', 'bb', 'volume'])
      expect(floating, type).not.toContain(type)
  })

  it('holds the last bars of the same values the pane plots', () => {
    const { input, model: m } = model('rsi')
    expect(m.count).toBe(30)
    expect(m.start).toBe(bars.length - 30)
    const rsi = m.lines.find((l) => l.key === 'rsi')!
    expect(rsi.values).toEqual(input.out.values.rsi.slice(-30))
  })

  it('walks back through history', () => {
    const { model: m } = model('rsi', bars.length - 41, 20)
    expect(m.start).toBe(bars.length - 60)
    expect(m.count).toBe(20)
  })

  it('MACD: a scale symmetric about zero, so the histogram sign reads', () => {
    const { model: m } = model('macd')
    expect(m.centered).toBe(true)
    expect(m.domain.max).toBeCloseTo(-m.domain.min)
    expect(m.histograms).toHaveLength(1)
  })

  it('levels show only once the scale reaches them', () => {
    expect(paneDomain([[40, 60]], false)).toEqual({ domain: { min: 37.2, max: 62.8 }, centered: false })
    const { model: m } = model('rsi')
    for (const level of m.levels) expect(level.value).toBeGreaterThanOrEqual(m.domain.min)
  })

  it('a histogram that stays above zero is drawn from zero', () => {
    expect(paneDomain([[2, 5]], true).domain.min).toBe(0)
  })

  it('reads overbought and oversold past the outer levels', () => {
    const def = INDICATOR_BY_TYPE.get('rsi')!
    const styles = defaultStyles(def)
    const out = { values: { rsi: [50, 75, 25] } }
    const input = { def, out, bars: bars.slice(0, 3), styles, end: 2, count: 3 }
    const m = buildModel(input)
    expect(verdictAt({ ...input, i: 1 }, m)).toEqual({ text: 'OVERBOUGHT', tone: 'ob' })
    expect(verdictAt({ ...input, i: 2 }, m)).toEqual({ text: 'OVERSOLD', tone: 'os' })
  })

  it('names a cross of the first line over the second on its bar', () => {
    const { input, model: m } = model('macd')
    const macd = input.out.values.macd
    const signal = input.out.values.signal
    const cross = macd.findIndex((v, i) => i > 50 && macd[i - 1] - signal[i - 1] <= 0 && v - signal[i] > 0)
    expect(cross).toBeGreaterThan(0)
    const at = { ...input, end: cross }
    expect(verdictAt({ ...at, i: cross }, buildModel(at)).text).toBe('BULL CROSS')
    expect(m.count).toBe(30)
  })

  it('clamps the bars to the window limits', () => {
    expect(clampBars(undefined)).toBe(30)
    expect(clampBars(2)).toBe(8)
    expect(clampBars(999)).toBe(120)
  })
})
