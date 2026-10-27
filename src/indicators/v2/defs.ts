/** The indicators carried over from btcAnalyzerV2, with V2's inputs, defaults and colors. */
import type { Drawing, IndicatorDef, InputDef, InputValue } from '../types'
import { calculateCmMacd, CM_COLORS, CM_RESOLUTIONS, cmCrosses, cmHistogramColor } from './cmMacd'
import { asNullable, detectMacdDivergences, DIVERGENCE_INPUTS, divergenceDrawings, divergenceSettings } from './divergence'
import { calculateMsbZigZag } from './msbZigZag'
import { SMC_DEFAULTS, smcDrawings, type SmcSettings } from './smc'
import { calculateTmoScalper, TMO_COLORS, TMO_CUTOFF, TMO_RESOLUTIONS } from './tmoScalper'

const n = (v: InputValue) => Math.max(1, Math.round(Number(v)))
const toNaN = (values: (number | null)[]) => values.map((v) => (v === null ? NaN : v))

/** "1" → "1m", "60" → "1h", "D" stays: how TradingView names a resolution in a menu. */
function resolutionLabels(keys: string[]): Record<string, string> {
  return Object.fromEntries(
    keys.map((k) => {
      if (!/^\d+$/.test(k)) return [k, k]
      const m = Number(k)
      return [k, m % 60 === 0 ? `${m / 60}h` : `${m}m`]
    }),
  )
}

// ── CM_Ult_MacD_MTF ─────────────────────────────────────────────────────────

const CM_KEYS = Object.keys(CM_RESOLUTIONS)

export const cmUltMacd: IndicatorDef = {
  type: 'cmUltMacd',
  name: 'CM_Ult_MacD_MTF',
  short: 'CM_Ult_MacD_MTF',
  category: 'Oscillators',
  overlay: false,
  format: 'price',
  inputs: [
    { key: 'useCurrentRes', label: 'Use current chart resolution', type: 'bool', default: true },
    { key: 'resCustom', label: 'Resolution (when not the chart’s)', type: 'select', default: '60', options: CM_KEYS, optionLabels: resolutionLabels(CM_KEYS) },
    { key: 'fast', label: 'Fast length', type: 'int', default: 12, min: 1, max: 2000 },
    { key: 'slow', label: 'Slow length', type: 'int', default: 26, min: 1, max: 2000 },
    { key: 'signal', label: 'Signal length', type: 'int', default: 9, min: 1, max: 2000 },
    { key: 'showLines', label: 'Show MACD & signal line', type: 'bool', default: true },
    { key: 'showDots', label: 'Show dots when MACD crosses signal', type: 'bool', default: true },
    { key: 'showHistogram', label: 'Show histogram', type: 'bool', default: true },
    { key: 'macdColorChange', label: 'Change MACD color on signal cross', type: 'bool', default: true },
    { key: 'histColorChange', label: 'Histogram 4 colors', type: 'bool', default: true },
    ...DIVERGENCE_INPUTS,
  ],
  plots: [
    { key: 'hist', title: 'Histogram', kind: 'histogram', color: CM_COLORS.aqua },
    { key: 'macd', title: 'MACD', kind: 'line', color: CM_COLORS.lime, width: 4 },
    { key: 'signal', title: 'Signal Line', kind: 'line', color: CM_COLORS.yellow, width: 2 },
    { key: 'cross', title: 'Cross', kind: 'dots', color: CM_COLORS.lime, width: 4 },
  ],
  levels: [{ title: '0 Line', value: 0, color: CM_COLORS.white, style: 'solid' }],
  feeds: (i, chart) => {
    const seconds = CM_RESOLUTIONS[String(i.resCustom)]
    return i.useCurrentRes || !seconds || seconds === chart.seconds ? [] : [seconds]
  },
  compute: (bars, i, _st, ctx) => {
    const chartSeconds = ctx.interval.seconds
    const custom = CM_RESOLUTIONS[String(i.resCustom)] ?? chartSeconds
    const seconds = i.useCurrentRes ? chartSeconds : custom
    const source = seconds === chartSeconds ? bars : ctx.feed(seconds)
    const v = calculateCmMacd(bars, source, chartSeconds, seconds, { fast: n(i.fast), slow: n(i.slow), signal: n(i.signal) })
    // `smd and outMacD ? outMacD : na` also drops exact zeros.
    const shown = (data: (number | null)[], on: unknown) => data.map((x) => (on && x !== null && x !== 0 ? x : NaN))
    const lineColors = v.macd.map((x, k) =>
      i.macdColorChange && x !== null && v.signal[k] !== null && x >= v.signal[k]! ? CM_COLORS.lime : CM_COLORS.red,
    )
    const div = divergenceSettings(i)
    return {
      values: {
        hist: shown(v.histogram, i.showHistogram),
        macd: shown(v.macd, i.showLines),
        signal: shown(v.signal, i.showLines),
        cross: toNaN(cmCrosses(v).map((x) => (i.showDots ? x : null))),
      },
      colors: {
        hist: v.histogram.map((x, k) => cmHistogramColor(x, v.histogramPrevious[k], Boolean(i.histColorChange))),
        macd: lineColors,
        signal: v.signal.map(() => (i.macdColorChange ? CM_COLORS.yellow : CM_COLORS.lime)),
        cross: lineColors,
      },
      drawings: divergenceDrawings(detectMacdDivergences(bars, v.histogram, div), div),
    }
  },
}

/** Adds V2's divergences to the regular MACD (TradingView's MACD otherwise). */
export function withDivergences(macd: IndicatorDef): IndicatorDef {
  return {
    ...macd,
    inputs: [...macd.inputs, ...DIVERGENCE_INPUTS],
    compute: (bars, i, st, ctx) => {
      const out = macd.compute(bars, i, st, ctx)
      const div = divergenceSettings(i)
      return { ...out, drawings: divergenceDrawings(detectMacdDivergences(bars, asNullable(out.values.hist), div), div) }
    },
  }
}

// ── TMO Scalper ─────────────────────────────────────────────────────────────

const TMO_KEYS = Object.keys(TMO_RESOLUTIONS)
const tf = (key: string, label: string, def: string): InputDef => ({
  key,
  label,
  type: 'select',
  default: def,
  options: TMO_KEYS,
  optionLabels: resolutionLabels(TMO_KEYS),
})
const signals = 'Signals'

export const tmoScalper: IndicatorDef = {
  type: 'tmoScalper',
  name: 'TMO Scalper',
  short: 'TMO Scalper',
  category: 'Oscillators',
  overlay: false,
  format: 'fixed',
  inputs: [
    tf('tf1', 'TMO 1 timeframe', '1'),
    tf('tf2', 'TMO 2 timeframe', '5'),
    tf('tf3', 'TMO 3 timeframe', '30'),
    { key: 'length', label: 'TMO length', type: 'int', default: 14, min: 1, max: 2000 },
    { key: 'calc', label: 'Calc length', type: 'int', default: 5, min: 1, max: 2000 },
    { key: 'smooth', label: 'Smooth length', type: 'int', default: 3, min: 1, max: 2000 },
    { key: 'signalSize', label: 'Signal size', type: 'int', default: 3, min: 1, max: 10, hideInTitle: true, group: signals },
    { key: 'signalOffset', label: 'Signal offset', type: 'float', default: 2, min: -100, max: 100, step: 0.5, hideInTitle: true, group: signals },
    { key: 'extremeOb', label: 'Extreme overbought', type: 'float', default: 9, min: -100, max: 100, hideInTitle: true, group: signals },
    { key: 'extremeOs', label: 'Extreme oversold', type: 'float', default: -9, min: -100, max: 100, hideInTitle: true, group: signals },
    { key: 'tmo1Signals', label: 'TMO 1 signals ▴▾', type: 'bool', default: true, group: signals },
    { key: 'tmo2Signals', label: 'TMO 2 signals ▴▾', type: 'bool', default: true, group: signals },
    { key: 'tmo1Extreme', label: 'TMO 1 extreme signals (OS/OB only)', type: 'bool', default: true, group: signals },
    { key: 'tmo2Extreme', label: 'TMO 2 extreme signals (OS/OB only)', type: 'bool', default: true, group: signals },
    { key: 'showLines', label: 'Show lines', type: 'bool', default: true, group: signals },
  ],
  plots: [
    { key: 'main1', title: 'TMO 1 Main', kind: 'line', color: TMO_COLORS.bull, color2: TMO_COLORS.bear },
    { key: 'signal1', title: 'TMO 1 Signal', kind: 'line', color: TMO_COLORS.bull, color2: TMO_COLORS.bear },
    { key: 'main2', title: 'TMO 2 Main', kind: 'line', color: TMO_COLORS.bull, color2: TMO_COLORS.bear },
    { key: 'signal2', title: 'TMO 2 Signal', kind: 'line', color: TMO_COLORS.bull, color2: TMO_COLORS.bear },
    { key: 'main3', title: 'TMO 3 Main', kind: 'line', color: TMO_COLORS.tmo2Bull, color2: TMO_COLORS.tmo2Bear },
    { key: 'signal3', title: 'TMO 3 Signal', kind: 'line', color: TMO_COLORS.tmo2Bull, color2: TMO_COLORS.tmo2Bear },
  ],
  levels: [
    { title: 'OB Cutoff Line', value: TMO_CUTOFF, color: TMO_COLORS.bear, style: 'dashed' },
    { title: 'Zero Line', value: 0, color: '#434651', style: 'solid' },
    { title: 'OS Cutoff Line', value: -TMO_CUTOFF, color: TMO_COLORS.bull, style: 'dashed' },
  ],
  feeds: (i, chart) =>
    [i.tf1, i.tf2, i.tf3].map((k) => TMO_RESOLUTIONS[String(k)]).filter((s) => s && s !== chart.seconds),
  compute: (bars, i, st, ctx) => {
    const seconds = [i.tf1, i.tf2, i.tf3].map((k) => TMO_RESOLUTIONS[String(k)] ?? 60) as [number, number, number]
    const sources = seconds.map((s) => (s === ctx.interval.seconds ? bars : ctx.feed(s))) as [typeof bars, typeof bars, typeof bars]
    const v = calculateTmoScalper(bars, sources, seconds, ctx.interval.seconds, {
      tmoLength: n(i.length),
      calcLength: n(i.calc),
      smoothLength: n(i.smooth),
      signalOffset: Number(i.signalOffset),
      extremeOb: Number(i.extremeOb),
      extremeOs: Number(i.extremeOs),
    })
    const values: Record<string, number[]> = {}
    const colors: Record<string, string[]> = {}
    for (let k = 0; k < 3; k++) {
      const main = v.main[k],
        signal = v.signal[k]
      // Each pair wears its direction's colour, as the original's color1/2/3.
      const pair = main.map((x, j) => {
        const style = st[`main${k + 1}`]
        return x !== null && signal[j] !== null && x > signal[j]! ? style.color : (style.color2 ?? TMO_COLORS.bear)
      })
      values[`main${k + 1}`] = toNaN(main.map((x) => (i.showLines ? x : null)))
      values[`signal${k + 1}`] = toNaN(signal.map((x) => (i.showLines ? x : null)))
      colors[`main${k + 1}`] = pair
      colors[`signal${k + 1}`] = pair
    }
    // The ▴ / ▾ arrows; extreme ones share the position and stand out by colour.
    const size1 = n(i.signalSize) + 1,
      size2 = n(i.signalSize) + 3
    const drawings: Drawing[] = []
    const arrows = (data: (number | null)[], on: unknown, color: string, size: number, dir: 'up' | 'down') => {
      if (!on) return
      data.forEach((y, x) => y !== null && drawings.push({ type: 'triangle', x, y, dir, color, size }))
    }
    arrows(v.bull1, i.tmo1Signals, TMO_COLORS.tmo1Bull, size1, 'up')
    arrows(v.bear1, i.tmo1Signals, TMO_COLORS.bear, size1, 'down')
    arrows(v.bull1Extreme, i.tmo1Extreme, TMO_COLORS.extremeBull, size1, 'up')
    arrows(v.bear1Extreme, i.tmo1Extreme, TMO_COLORS.extremeBear, size1, 'down')
    arrows(v.bull2, i.tmo2Signals, TMO_COLORS.tmo2Bull, size2, 'up')
    arrows(v.bear2, i.tmo2Signals, TMO_COLORS.tmo2Bear, size2, 'down')
    arrows(v.bull2Extreme, i.tmo2Extreme, TMO_COLORS.extremeBull, size2, 'up')
    arrows(v.bear2Extreme, i.tmo2Extreme, TMO_COLORS.extremeBear, size2, 'down')
    return { values, colors, drawings }
  },
}

// ── MSB-OB ZigZag ───────────────────────────────────────────────────────────

export const msbZigZag: IndicatorDef = {
  type: 'msbZigZag',
  name: 'MSB-OB ZigZag (Market Structure)',
  short: 'MSB-OB ZigZag',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  inputs: [
    { key: 'length', label: 'ZigZag length', type: 'int', default: 9, min: 1, max: 2000 },
    { key: 'color', label: 'Line color', type: 'color', default: '#2196f3', hideInTitle: true },
    { key: 'width', label: 'Line width', type: 'int', default: 1, min: 1, max: 4, hideInTitle: true },
  ],
  plots: [],
  compute: (bars, i) => {
    const { pivots } = calculateMsbZigZag(bars, n(i.length))
    const drawings: Drawing[] = []
    for (let k = 1; k < pivots.length; k++) {
      const from = pivots[k - 1],
        to = pivots[k]
      // A high and a low on the same bar: the candle's own range covers that leg.
      if (to.index <= from.index) continue
      drawings.push({ type: 'line', x1: from.index, y1: from.price, x2: to.index, y2: to.price, color: String(i.color), width: n(i.width) })
    }
    return { values: {}, drawings }
  },
}

// ── Smart Money Concepts ────────────────────────────────────────────────────

const FILTERS = ['All', 'BOS', 'CHoCH']
const SIZES = ['Tiny', 'Small', 'Normal']
const STYLES = ['⎯⎯⎯', '----', '····']

/** One input per SMC setting, grouped as LuxAlgo's settings are. */
function smcInput(key: keyof SmcSettings, label: string, group: string, extra: Partial<InputDef> = {}): InputDef {
  const value = SMC_DEFAULTS[key]
  const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? (Number.isInteger(value) ? 'int' : 'float') : 'select'
  return { key, label, type, default: value, group, hideInTitle: true, ...extra }
}

export const smartMoneyConcepts: IndicatorDef = {
  type: 'smc',
  name: 'Smart Money Concepts [LuxAlgo]',
  short: 'Smart Money Concepts [LuxAlgo]',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  inputs: [
    smcInput('mode', 'Mode', 'Smart Money Concepts', { options: ['Historical', 'Present'] }),
    smcInput('style', 'Style', 'Smart Money Concepts', { options: ['Colored', 'Monochrome'] }),
    smcInput('showInternal', 'Show internal structure', 'Real Time Internal Structure'),
    smcInput('internalBullish', 'Bullish structure', 'Real Time Internal Structure', { options: FILTERS }),
    smcInput('internalBearish', 'Bearish structure', 'Real Time Internal Structure', { options: FILTERS }),
    smcInput('confluenceFilter', 'Confluence filter', 'Real Time Internal Structure'),
    smcInput('internalLabelSize', 'Internal label size', 'Real Time Internal Structure', { options: SIZES }),
    smcInput('showSwing', 'Show swing structure', 'Real Time Swing Structure'),
    smcInput('swingBullish', 'Bullish structure', 'Real Time Swing Structure', { options: FILTERS }),
    smcInput('swingBearish', 'Bearish structure', 'Real Time Swing Structure', { options: FILTERS }),
    smcInput('swingLabelSize', 'Swing label size', 'Real Time Swing Structure', { options: SIZES }),
    smcInput('showSwingPoints', 'Show swing points', 'Real Time Swing Structure'),
    smcInput('swingLength', 'Swing length', 'Real Time Swing Structure', { min: 2, max: 500 }),
    smcInput('showStrongWeakHighsLows', 'Show strong/weak high/low', 'Real Time Swing Structure'),
    smcInput('showInternalOrderBlocks', 'Internal order blocks', 'Order Blocks'),
    smcInput('internalOrderBlockCount', 'Internal order blocks shown', 'Order Blocks', { min: 1, max: 50 }),
    smcInput('showSwingOrderBlocks', 'Swing order blocks', 'Order Blocks'),
    smcInput('swingOrderBlockCount', 'Swing order blocks shown', 'Order Blocks', { min: 1, max: 50 }),
    smcInput('orderBlockFilter', 'Order block filter', 'Order Blocks', { options: ['Atr', 'Cumulative Mean Range'] }),
    smcInput('orderBlockMitigation', 'Order block mitigation', 'Order Blocks', { options: ['High/Low', 'Close'] }),
    smcInput('highlightMitigatedBlocks', 'Dim mitigated order blocks', 'Order Blocks'),
    smcInput('showEqualHighLow', 'Equal highs & lows', 'EQH/EQL'),
    smcInput('equalHighLowBars', 'Bars confirmation', 'EQH/EQL', { min: 1, max: 100 }),
    smcInput('equalHighLowThreshold', 'Threshold', 'EQH/EQL', { type: 'float', min: 0, max: 0.5, step: 0.05 }),
    smcInput('equalHighLowLabelSize', 'Label size', 'EQH/EQL', { options: SIZES }),
    smcInput('showFairValueGaps', 'Fair value gaps', 'Fair Value Gaps'),
    smcInput('fvgAutoThreshold', 'Auto threshold', 'Fair Value Gaps'),
    smcInput('fvgExtend', 'Extend FVG (bars)', 'Fair Value Gaps', { min: 1, max: 500 }),
    smcInput('showDailyHighLow', 'Daily', 'Highs & Lows MTF'),
    smcInput('dailyLineStyle', 'Daily style', 'Highs & Lows MTF', { options: STYLES }),
    smcInput('showWeeklyHighLow', 'Weekly', 'Highs & Lows MTF'),
    smcInput('weeklyLineStyle', 'Weekly style', 'Highs & Lows MTF', { options: STYLES }),
    smcInput('showMonthlyHighLow', 'Monthly', 'Highs & Lows MTF'),
    smcInput('monthlyLineStyle', 'Monthly style', 'Highs & Lows MTF', { options: STYLES }),
    smcInput('showPremiumDiscount', 'Premium/discount zones', 'Premium & Discount Zones'),
  ],
  plots: [],
  compute: (bars, i) => ({ values: {}, drawings: smcDrawings(bars, { ...SMC_DEFAULTS, ...(i as Partial<SmcSettings>) }) }),
}
