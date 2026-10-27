/**
 * Bayesian/nQQE/BankFunds must reproduce btcAnalyzerV2 exactly: bayes-golden.json is what V2's own
 * calculateBayesianNqqeBankfunds (origin/main 4fad720) computed on v2-golden.json's m1 candles.
 */
import { describe, expect, it } from 'vitest'
import { parseInterval } from '../../data/intervals'
import type { Candle } from '../../data/types'
import { createInstance, INDICATOR_BY_TYPE } from '../catalog'
import { BAYESIAN_NQQE_DEFAULTS, calculateBayesianNqqeBankfunds, publishedBayesProduct } from './bayesian'
import bayes from './fixtures/bayes-golden.json'
import golden from './fixtures/v2-golden.json'

const m1 = golden.candles.m1 as Candle[]
const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6)
const ctx = { interval: parseInterval('1')!, product: 'BTC-USD', feed: () => m1, timeToIndex: (t: number) => t }

describe('Bayesian/nQQE/BankFunds vs btcAnalyzerV2', () => {
  for (const [name, settings] of [
    ['published defaults', BAYESIAN_NQQE_DEFAULTS],
    ['Bill Williams confirmation', { ...BAYESIAN_NQQE_DEFAULTS, useBwConfirmation: true }],
  ] as const) {
    it(name, () => {
      const want = name === 'published defaults' ? bayes.defaults : bayes.billWilliams
      const v = calculateBayesianNqqeBankfunds(m1, settings)
      for (const key of ['probDown', 'probUp', 'prime', 'nqqe', 'fundtrend', 'bullbear', 'longSignal', 'shortSignal', 'entry'] as const)
        expect(v[key].map(round), key).toEqual(want[key])
      expect(v.nqqeColors).toEqual(want.nqqeColors)
      expect(v.bankerColors).toEqual(want.bankerColors)
    })
  }

  it('the chart draws the same values, signals and banker bodies', () => {
    const def = INDICATOR_BY_TYPE.get('bayesianNqqe')!
    const inst = createInstance('bayesianNqqe')
    const out = def.compute(m1, inst.inputs, inst.styles, ctx)
    const back = (xs: number[]) => xs.map((x) => round(Number.isFinite(x) ? x : null))
    expect(back(out.values.prime)).toEqual(bayes.defaults.prime)
    expect(back(out.values.nqqe)).toEqual(bayes.defaults.nqqe)
    expect(back(out.values.long)).toEqual(bayes.defaults.longSignal)
    expect(back(out.values.short)).toEqual(bayes.defaults.shortSignal)
    const entries = out.drawings!.filter((d) => d.type === 'box' && d.top === 50 && d.bottom === 0)
    expect(entries).toHaveLength(bayes.defaults.entry.filter((e) => e !== null).length)
  })

  it('keeps the published left-associative "Bayes" expression', () => {
    // ((((a*b)*c)/a)*b)*c + (1-a)(1-b)(1-c), not a*b*c / (a*b*c + …).
    expect(publishedBayesProduct(0.5, 0.4, 0.3)).toBeCloseTo(0.4 * 0.3 * 0.4 * 0.3 + 0.5 * 0.6 * 0.7, 12)
    expect(publishedBayesProduct(0, 0.4, 0.3)).toBe(0)
  })
})
