/**
 * Bayesian/nQQE/BankFunds on the chart, drawn as V2's pane draws it: red Break Down, green
 * Break Up and blue Prime areas from zero (transp 60), the nQQE area from 50 in its regime
 * colours (lime above 60, red below 40, yellow between, transp 30), dashed 40 / 60, the banker
 * bodies between the fund line and its slow line, the yellow entry block across the bottom half,
 * and long / short circles on Prime (the script's barcolor, which a pane cannot paint).
 */
import type { Drawing, IndicatorDef, InputDef, InputValue } from '../types'
import {
  BAYES_COLORS,
  BAYESIAN_NQQE_DEFAULTS as D,
  BAYESIAN_NQQE_SOURCES,
  calculateBayesianNqqeBankfunds,
  isBayesianNqqeBankfundsSettings,
  type BayesianNqqeSettings,
} from './bayesian'

const alpha = (hex: string, a: number) => {
  const c = parseInt(hex.slice(1), 16)
  return `rgba(${c >> 16}, ${(c >> 8) & 255}, ${c & 255}, ${a})`
}
const toNaN = (values: (number | null)[]) => values.map((v) => (v === null ? NaN : v))

const BAYES = 'Bayesian BBSMA'
const BW = 'Bill Williams'
const NQQE = 'nQQE'
const SHOW = 'Display'
const int = (key: keyof BayesianNqqeSettings, label: string, group: string, min = 1, max = 2000): InputDef => ({
  key,
  label,
  type: 'int',
  default: D[key] as number,
  min,
  max,
  group,
})
const bool = (key: keyof BayesianNqqeSettings, label: string, group: string): InputDef => ({
  key,
  label,
  type: 'bool',
  default: D[key] as boolean,
  group,
})

/** The chart's inputs as V2's settings; out of range, the published defaults (as V2 does). */
function settingsOf(i: Record<string, InputValue>): BayesianNqqeSettings {
  const s = Object.fromEntries(
    Object.entries(D).map(([key, fallback]) => {
      const v = i[key]
      if (typeof fallback === 'number') return [key, Number.isInteger(fallback) ? Math.round(Number(v)) : Number(v)]
      if (typeof fallback === 'boolean') return [key, Boolean(v)]
      return [key, v]
    }),
  ) as unknown as BayesianNqqeSettings
  return isBayesianNqqeBankfundsSettings(s) ? s : { ...D }
}

export const bayesianNqqe: IndicatorDef = {
  type: 'bayesianNqqe',
  name: 'Bayesian/nQQE/BankFunds',
  short: 'Bayesian/nQQE/BankFunds',
  category: 'Oscillators',
  overlay: false,
  format: 'fixed',
  inputs: [
    int('bbSmaPeriod', 'BB SMA Period', BAYES),
    { key: 'bbStdDev', label: 'BB Standard Deviation', type: 'float', default: D.bbStdDev, min: 0.01, max: 100, step: 0.1, group: BAYES },
    int('aoFast', 'AO Fast EMA Length', BW),
    int('aoSlow', 'AO Slow EMA Length', BW),
    int('acFast', 'AC Fast SMA Length', BW),
    int('acSlow', 'AC Slow SMA Length', BW),
    int('acAoMa', 'AC AO MA Period', BW),
    int('lipsLength', 'Lips Length', BW),
    int('teethLength', 'Teeth Length', BW),
    int('jawLength', 'Jaw Length', BW),
    int('lipsOffset', 'Lips Offset', BW, 0, 200),
    int('teethOffset', 'Teeth Offset', BW, 0, 200),
    int('jawOffset', 'Jaw Offset', BW, 0, 200),
    int('smaPeriod', 'SMA Period', BAYES),
    int('bayesPeriod', 'Bayesian Lookback Period', BAYES),
    { key: 'lowerThreshold', label: 'Lower Threshold', type: 'float', default: D.lowerThreshold, min: 0, max: 100, step: 1, group: BAYES },
    { key: 'nqqeSource', label: 'nQQE Source', type: 'select', default: D.nqqeSource, options: [...BAYESIAN_NQQE_SOURCES], group: NQQE },
    int('nqqeRsiLength', 'nQQE RSI Length', NQQE),
    int('nqqeSmooth', 'nQQE RSI Smoothing Factor', NQQE),
    bool('useBwConfirmation', 'Use Bill Williams confirmation', BW),
    bool('showProbabilities', 'Show Break Up / Break Down', SHOW),
    bool('showNqqe', 'Show nQQE', SHOW),
    bool('showBankFunds', 'Show Bank funds', SHOW),
    bool('showSignals', 'Show long / short signals', SHOW),
  ],
  plots: [
    { key: 'probDown', title: 'Break Down', kind: 'line', color: BAYES_COLORS.down, width: 2 },
    { key: 'probUp', title: 'Break Up', kind: 'line', color: BAYES_COLORS.up, width: 2 },
    { key: 'prime', title: 'Prime', kind: 'line', color: BAYES_COLORS.prime, width: 2 },
    { key: 'nqqe', title: 'nQQE', kind: 'line', color: BAYES_COLORS.nqqeYellow, width: 2 },
    { key: 'long', title: 'Long', kind: 'dots', color: BAYES_COLORS.long, width: 3 },
    { key: 'short', title: 'Short', kind: 'dots', color: BAYES_COLORS.short, width: 3 },
  ],
  levels: [
    { title: '60', value: 60, color: BAYES_COLORS.gray, style: 'dashed' },
    { title: '40', value: 40, color: BAYES_COLORS.gray, style: 'dashed' },
  ],
  // The published areas, in paint order: from zero at transp 60, then nQQE from 50 at transp 30.
  fills: [
    { from: 'probDown', to: 0, color: alpha(BAYES_COLORS.down, 0.4) },
    { from: 'probUp', to: 0, color: alpha(BAYES_COLORS.up, 0.4) },
    { from: 'prime', to: 0, color: alpha(BAYES_COLORS.prime, 0.4) },
    { from: 'nqqe', to: 50, color: alpha(BAYES_COLORS.nqqeYellow, 0.7), colorsKey: 'nqqeFill' },
  ],
  compute: (bars, i) => {
    const s = settingsOf(i)
    const v = calculateBayesianNqqeBankfunds(bars, s)
    const off = (values: (number | null)[], on: boolean) => toNaN(on ? values : values.map(() => null))
    const drawings: Drawing[] = []
    if (s.showBankFunds)
      bars.forEach((_, x) => {
        const fund = v.fundtrend[x]
        const slow = v.bullbear[x]
        // plotcandle(fundtrend, bullbearline): a body between the two, in the published colour stack.
        if (fund !== null && slow !== null)
          drawings.push({ type: 'box', x1: x - 0.35, x2: x + 0.35, top: Math.max(fund, slow), bottom: Math.min(fund, slow), fill: v.bankerColors[x] })
        // plotcandle(0, 50, 0, 50): the yellow entry block across the bottom half.
        if (v.entry[x] !== null) drawings.push({ type: 'box', x1: x - 0.35, x2: x + 0.35, top: 50, bottom: 0, fill: BAYES_COLORS.bankerYellow })
      })
    return {
      values: {
        probDown: off(v.probDown, s.showProbabilities),
        probUp: off(v.probUp, s.showProbabilities),
        prime: toNaN(v.prime),
        nqqe: off(v.nqqe, s.showNqqe),
        long: off(v.longSignal, s.showSignals),
        short: off(v.shortSignal, s.showSignals),
      },
      colors: { nqqe: v.nqqeColors, nqqeFill: v.nqqeColors.map((c) => alpha(c, 0.7)) },
      drawings,
    }
  },
}
