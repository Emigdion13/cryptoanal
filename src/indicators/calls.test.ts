import { describe, expect, it } from 'vitest'
import type { Candle } from '../data/types'
import { buildModel, verdictAt } from '../ui/floatingModel'
import { atrCall, bayesianCall, bbwCall, cmfCall, dmiCall, obvCall, tmoLuxCall } from './calls'
import { defaultInputs, defaultStyles, INDICATOR_BY_TYPE } from './catalog'
import type { ComputeContext } from './types'

const out = (values: Record<string, number[]>) => ({ values })

describe('the calls the generic reading got wrong', () => {
  it('DMI: the side from +DI against −DI, the strength from ADX', () => {
    // ADX is high in a strong drop: still DOWN, never green.
    expect(dmiCall(out({ plus: [10, 12], minus: [30, 32], adx: [38, 41] }), 1)).toEqual({ text: 'DOWN · VERY STRONG', tone: 'bear' })
    expect(dmiCall(out({ plus: [30, 31], minus: [12, 11], adx: [26, 28] }), 1)).toEqual({ text: 'UP · STRONG', tone: 'bull' })
    expect(dmiCall(out({ plus: [30, 31], minus: [12, 11], adx: [22, 23] }), 1)).toEqual({ text: 'UP · BUILDING', tone: 'bull' })
    expect(dmiCall(out({ plus: [30, 31], minus: [12, 11], adx: [45, 44] }), 1)).toEqual({ text: 'UP · FADING', tone: 'bull' })
    expect(dmiCall(out({ plus: [18, 22], minus: [20, 19], adx: [24, 25] }), 1)).toEqual({ text: 'BULL CROSS · STRONG', tone: 'bull' })
    expect(dmiCall(out({ plus: [18, 22], minus: [20, 19], adx: [15, 16] }), 1)).toEqual({ text: 'NO TREND · BULL CROSS', tone: 'flat' })
    expect(dmiCall(out({ plus: [25, 24], minus: [20, 19], adx: [15, 14] }), 1)).toEqual({ text: 'NO TREND', tone: 'flat' })
    expect(dmiCall(out({ plus: [NaN], minus: [NaN], adx: [NaN] }), 0)).toEqual({ text: 'WARMING UP', tone: 'flat' })
  })

  it('ATR and BandWidth: bigger or smaller moves, no direction', () => {
    expect(atrCall(out({ atr: [10, 12] }), 1)).toEqual({ text: 'VOLATILITY RISING', tone: 'flat' })
    expect(atrCall(out({ atr: [12, 10] }), 1)).toEqual({ text: 'VOLATILITY FALLING', tone: 'flat' })
    const widths = Array.from({ length: 60 }, (_, k) => 10 - (k % 7) * 0.5)
    expect(bbwCall(out({ bbw: [...widths, 9.9] }), 60).text).toBe('BANDS WIDENING')
    expect(bbwCall(out({ bbw: [...widths, 1] }), 60)).toEqual({ text: 'SQUEEZE', tone: 'flat' })
  })

  it('OBV by its direction only; CMF by the side of zero', () => {
    expect(obvCall(out({ obv: [-500, -400] }), 1)).toEqual({ text: 'RISING', tone: 'bull' })
    expect(cmfCall(out({ cmf: [0.2, 0.1] }), 1)).toEqual({ text: 'BUYERS · FALLING', tone: 'bull' })
    expect(cmfCall(out({ cmf: [-0.2, -0.1] }), 1)).toEqual({ text: 'SELLERS · RISING', tone: 'bear' })
  })

  it('Bayesian: Break Down is red, Break Up green; its signals first', () => {
    const base = { probDown: [70, 72], probUp: [20, 18], prime: [5, 5], nqqe: [55, 55], sideways: [0, 0], long: [NaN, NaN], short: [NaN, NaN] }
    expect(bayesianCall(out(base), 1)).toEqual({ text: 'BREAK DOWN 72%', tone: 'bear' })
    expect(bayesianCall(out({ ...base, probDown: [10, 12], probUp: [60, 64] }), 1)).toEqual({ text: 'BREAK UP 64%', tone: 'bull' })
    expect(bayesianCall(out({ ...base, sideways: [0, 1] }), 1)).toEqual({ text: 'SIDEWAYS', tone: 'flat' })
    expect(bayesianCall(out({ ...base, long: [30, NaN] }), 1)).toEqual({ text: 'LONG · 1 bar ago', tone: 'bull' })
    expect(bayesianCall(out({ ...base, probDown: [NaN, NaN], probUp: [NaN, NaN], nqqe: [62, 65] }), 1)).toEqual({ text: 'nQQE BULL', tone: 'bull' })
  })

  it('TMO Lux: its Buy / Sell circles first', () => {
    expect(tmoLuxCall(out({ osc: [-5, -3, -2], bull: [NaN, -3, NaN], bear: [NaN, NaN, NaN] }), 2)).toEqual({ text: 'BUY · 1 bar ago', tone: 'bull' })
    expect(tmoLuxCall(out({ osc: [5, 3], bull: [NaN, NaN], bear: [NaN, NaN] }), 1)).toEqual({ text: 'FALLING · ABOVE 0', tone: 'bear' })
  })

  it('the windows and tiles read DMI by its own call', () => {
    const bars: Candle[] = Array.from({ length: 200 }, (_, i) => {
      const close = 100 + i * 0.5
      return { time: 1_700_000_000 + i * 60, open: close - 0.3, high: close + 0.6, low: close - 0.6, close, volume: 10 }
    })
    const ctx: ComputeContext = {
      interval: { id: '1', label: '1m', name: '1 minute', group: 'minutes', kind: 'fixed', seconds: 60, intraday: true },
      product: 'BTC-USD',
      feed: () => [],
      timeToIndex: () => 0,
    }
    const def = INDICATOR_BY_TYPE.get('dmi')!
    const styles = defaultStyles(def)
    const input = { def, out: def.compute(bars, defaultInputs(def), styles, ctx), bars, styles, end: 199, count: 30 }
    // A steady climb: +DI over −DI, ADX high.
    expect(verdictAt({ ...input, i: 199 }, buildModel(input))).toMatchObject({ tone: 'bull', text: expect.stringMatching(/^UP · /) })
  })
})
