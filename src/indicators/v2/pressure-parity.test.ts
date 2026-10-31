/**
 * CM_Williams_Vix_Fix and Zeiierman Trend Pressure must reproduce btcAnalyzerV2. The fixture holds
 * what V2's own code (origin/main 4fad720) computed on v2-golden.json's 1m candles, with defaults.
 */
import { describe, expect, it } from 'vitest'
import { parseInterval } from '../../data/intervals'
import type { Candle } from '../../data/types'
import { buildModel, verdictAt } from '../../ui/floatingModel'
import { createInstance, INDICATOR_BY_TYPE } from '../catalog'
import candles from './fixtures/v2-golden.json'
import golden from './fixtures/pressure-golden.json'
import { calculateTrendPressure, TREND_PRESSURE_DEFAULTS } from './trendPressure'
import { calculateVixFix } from './vixFix'

const m1 = candles.candles.m1 as Candle[]
const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6)
const ctx = { interval: parseInterval('1')!, product: 'BTC-USD', feed: () => m1, timeToIndex: (t: number) => t }

function run(type: string, inputs: Record<string, unknown> = {}) {
  const def = INDICATOR_BY_TYPE.get(type)!
  const inst = createInstance(type)
  const out = def.compute(m1, { ...inst.inputs, ...(inputs as typeof inst.inputs) }, inst.styles, ctx)
  const input = { def, out, bars: m1, styles: inst.styles, end: m1.length - 1, count: 30 }
  const callAt = (i: number) => verdictAt({ ...input, i }, buildModel({ ...input, end: i }))
  return { def, out, callAt, model: buildModel(input) }
}

describe('CM_Williams_Vix_Fix (22, 20, 2, 50, 0.85, 1.01)', () => {
  const v = calculateVixFix(m1, { pd: 22, bbl: 20, mult: 2, lb: 50, ph: 0.85, pl: 1.01 })

  it('matches V2: WVF, bands, range and the lime bars', () => {
    expect(v.wvf.map(round)).toEqual(golden.vixFix.wvf)
    expect(v.upperBand.map(round)).toEqual(golden.vixFix.upperBand)
    expect(v.rangeHigh.map(round)).toEqual(golden.vixFix.rangeHigh)
    expect(v.rangeLow.map(round)).toEqual(golden.vixFix.rangeLow)
    expect(v.isGreen).toEqual(golden.vixFix.isGreen)
  })

  it('shows the band and range lines only when switched on, and calls a fear spike a bottom', () => {
    const { def, out, callAt, model } = run('cmVixFix')
    expect(def.plots.filter((p) => p.hidden).map((p) => p.key)).toEqual(['rangeHigh', 'rangeLow', 'upperBand'])
    expect(model.lines).toEqual([])
    expect(out.colors!.wvf.filter((c) => c === '#00ff00')).toHaveLength(golden.vixFix.isGreen.filter(Boolean).length)

    const first = golden.vixFix.isGreen.findIndex((g, i) => g && !golden.vixFix.isGreen[i - 1])
    expect(callAt(first)).toEqual({ text: '▲ POTENTIAL BOTTOM', tone: 'bull' })
    const held = golden.vixFix.isGreen.findIndex((g, i) => g && golden.vixFix.isGreen[i - 1])
    expect(callAt(held)).toEqual({ text: '▲ BOTTOM SIGNAL HOLDS', tone: 'bull' })
    expect(callAt(0)).toEqual({ text: 'WARMING UP', tone: 'flat' })
    const gray = golden.vixFix.isGreen.findIndex((g, i) => !g && i > 100)
    expect(['QUIET', '⚠ NEAR TRIGGER'].some((t) => callAt(gray).text.startsWith(t))).toBe(true)
  })
})

describe('Zeiierman Trend Pressure', () => {
  const v = calculateTrendPressure(m1, { ...TREND_PRESSURE_DEFAULTS }, 0.01)
  const tp = golden.trendPressure

  it('matches V2: pulse, trend, core and its colours', () => {
    expect(v.pulse.map(round)).toEqual(tp.pulse)
    expect(v.trend.map(round)).toEqual(tp.trend)
    expect(v.core.map(round)).toEqual(tp.core)
    expect(v.coreTone).toEqual(tp.coreColors.map((c) => (c.startsWith('#40e3c3') ? 'bull' : c.startsWith('#df5141') ? 'bear' : 'neutral')))
  })

  it('matches V2: exhaustion states, releases, crosses and price boxes', () => {
    expect([v.upper, v.lower]).toEqual([tp.upper, tp.lower])
    expect(v.upperActive).toEqual(tp.upperActive)
    expect(v.lowerActive).toEqual(tp.lowerActive)
    expect(v.upperRelease).toEqual(tp.upperRelease)
    expect(v.lowerRelease).toEqual(tp.lowerRelease)
    expect(v.crossUp).toEqual(tp.crossUp)
    expect(v.crossDown).toEqual(tp.crossDown)
    expect(v.boxes).toEqual(tp.boxes)
  })

  it('says upper / lower pressure or neutral, boxes the candles and keeps its window on −112…10', () => {
    const { out, callAt, model } = run('trendPressure')
    const upper = tp.upperActive.indexOf(true)
    const lower = tp.lowerActive.indexOf(true)
    const neutral = tp.upperActive.findIndex((on, i) => !on && !tp.lowerActive[i] && i > 200)
    expect(callAt(upper).text.startsWith('UPPER PRESSURE')).toBe(true)
    expect(callAt(upper).tone).toBe('ob')
    expect(callAt(lower).text.startsWith('LOWER PRESSURE')).toBe(true)
    expect(callAt(lower).tone).toBe('os')
    expect(callAt(neutral).text.startsWith('NEUTRAL')).toBe(true)

    expect(out.priceDrawings!.filter((d) => d.type === 'box')).toHaveLength(tp.boxes.length)
    expect(run('trendPressure', { priceBoxes: false }).out.priceDrawings).toEqual([])
    expect(model.domain).toEqual({ min: -112, max: 10 })
  })
})
