/** The indicators carried over from btcAnalyzerV2, with V2's inputs, defaults and colors. */
import type { Drawing, IndicatorDef, InputDef, InputValue } from '../types'
import type { Candle } from '../../data/types'
import { calculateCmMacd, CM_COLORS, CM_RESOLUTIONS, cmCrosses, cmHistogramColor } from './cmMacd'
import { asNullable, detectMacdDivergences, DIVERGENCE_INPUTS, divergenceDrawings, divergenceSettings } from './divergence'
import { calculateMsbZigZag } from './msbZigZag'
import { SMC_DEFAULTS, smcDrawings, type SmcSettings } from './smc'
import { calculateTmoScalper, TMO_COLORS, TMO_CUTOFF, TMO_FILL_EDGE, TMO_FILL_OPACITY, TMO_RESOLUTIONS } from './tmoScalper'
import { calculateTmoLux, TMO_LUX_COLORS } from './tmoLux'
import { calculateTrendPressure, TREND_PRESSURE_COLORS, TREND_PRESSURE_DEFAULTS, type TrendPressureSettings } from './trendPressure'
import { calculateVixFix, vixFixCall, WVF_COLORS } from './vixFix'
import { rsi as wilderRsi, source as sourceValues, type Source } from '../math'

const n = (v: InputValue) => Math.max(1, Math.round(Number(v)))
/** "#rrggbb" with an opacity. */
const alpha = (hex: string, a: number) => {
  const c = parseInt(hex.slice(1), 16)
  return `rgba(${c >> 16}, ${(c >> 8) & 255}, ${c & 255}, ${a})`
}
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
    { title: 'OB Cutoff Line', value: TMO_CUTOFF, color: TMO_COLORS.bear, style: 'solid' },
    { title: 'Zero Line', value: 0, color: '#434651', style: 'solid' },
    { title: 'OS Cutoff Line', value: -TMO_CUTOFF, color: TMO_COLORS.bull, style: 'solid' },
  ],
  // The OB/OS zones (±15 to ±10) and each wheel's Main-to-Signal cloud, at 75% transparency.
  fills: [
    { from: TMO_CUTOFF, to: TMO_FILL_EDGE, color: alpha(TMO_COLORS.bear, TMO_FILL_OPACITY) },
    { from: -TMO_FILL_EDGE, to: -TMO_CUTOFF, color: alpha(TMO_COLORS.bull, TMO_FILL_OPACITY) },
    ...[3, 2, 1].map((k) => ({
      from: `main${k}`,
      to: `signal${k}`,
      color: alpha(TMO_COLORS.bull, TMO_FILL_OPACITY),
      colorBelow: alpha(TMO_COLORS.bear, TMO_FILL_OPACITY),
    })),
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

// ── TMO [LuxAlgo] ───────────────────────────────────────────────────────────

export const tmoLux: IndicatorDef = {
  type: 'tmoLux',
  name: 'Triangular Momentum Oscillator & Real Time Divergences [LuxAlgo]',
  short: 'TMO [LuxAlgo]',
  category: 'Oscillators',
  overlay: false,
  format: 'price',
  inputs: [
    { key: 'length', label: 'Length', type: 'int', default: 7, min: 1, max: 1000 },
    { key: 'source', label: 'Source', type: 'source', default: 'close' },
    { key: 'showLines', label: 'Show lines', type: 'bool', default: true },
    { key: 'correlationColors', label: 'Color based on price/oscillator correlation', type: 'bool', default: false },
  ],
  plots: [
    { key: 'osc', title: 'Osc', kind: 'histogram', color: TMO_LUX_COLORS.up },
    { key: 'bull', title: 'Bullish Circle', kind: 'dots', color: TMO_LUX_COLORS.up, width: 3 },
    { key: 'bear', title: 'Bearish Circle', kind: 'dots', color: TMO_LUX_COLORS.down, width: 3 },
  ],
  compute: (bars, i) => {
    const v = calculateTmoLux(bars, sourceValues(bars, i.source as Source), n(i.length), Boolean(i.showLines), Boolean(i.correlationColors))
    const drawings: Drawing[] = []
    for (const line of v.lines)
      drawings.push({
        type: 'line',
        x1: line.fromIndex,
        y1: line.fromValue,
        x2: line.toIndex,
        y2: line.toValue,
        color: line.kind === 'bull' ? TMO_LUX_COLORS.up : TMO_LUX_COLORS.down,
      })
    // The script's Buy / Sell labels, under a bullish turn and over a bearish one.
    v.osc.forEach((y, x) => {
      if (y === null || (!v.bull[x] && !v.bear[x])) return
      const bull = v.bull[x]
      drawings.push({
        type: 'text',
        x,
        y,
        text: bull ? 'Buy' : 'Sell',
        color: '#ffffff',
        bg: bull ? TMO_LUX_COLORS.up : TMO_LUX_COLORS.down,
        size: 9,
        dy: bull ? 17 : -17,
      })
    })
    return {
      values: {
        osc: toNaN(v.osc),
        bull: toNaN(v.osc.map((y, k) => (v.bull[k] ? y : null))),
        bear: toNaN(v.osc.map((y, k) => (v.bear[k] ? y : null))),
      },
      colors: { osc: v.colors },
      drawings,
    }
  },
}

// ── RSI Divergence ──────────────────────────────────────────────────────────

export const rsiDivergence: IndicatorDef = {
  type: 'rsiDivergence',
  name: 'RSI Divergence',
  short: 'RSI Divergence',
  category: 'Oscillators',
  overlay: false,
  format: 'fixed',
  inputs: [{ key: 'length', label: 'RSI length', type: 'int', default: 14, min: 1, max: 1000 }, ...DIVERGENCE_INPUTS],
  plots: [{ key: 'rsi', title: 'RSI', kind: 'line', color: '#ad91e5' }],
  levels: [
    { title: 'Overbought (70)', value: 70, color: '#ef5350', style: 'solid' },
    { title: 'Midline (50)', value: 50, color: '#6b7280', style: 'dotted' },
    { title: 'Oversold (30)', value: 30, color: '#26a69a', style: 'solid' },
  ],
  compute: (bars, i) => {
    const rsi = wilderRsi(bars.map((b) => b.close), n(i.length))
    const div = divergenceSettings(i)
    return { values: { rsi }, drawings: divergenceDrawings(detectMacdDivergences(bars, asNullable(rsi), div), div) }
  },
}

// ── CM_Williams_Vix_Fix ─────────────────────────────────────────────────────

const flag = (on: boolean) => (on ? 1 : 0)

export const cmVixFix: IndicatorDef = {
  type: 'cmVixFix',
  name: 'CM_Williams_Vix_Fix Finds Market Bottoms',
  short: 'CM_Williams_Vix_Fix',
  category: 'Volatility',
  overlay: false,
  format: 'fixed',
  inputs: [
    { key: 'pd', label: 'LookBack period standard deviation high', type: 'int', default: 22, min: 1, max: 2000 },
    { key: 'bbl', label: 'Bollinger band length', type: 'int', default: 20, min: 1, max: 2000 },
    { key: 'mult', label: 'Bollinger band standard deviation up', type: 'float', default: 2, min: 1, max: 5, step: 0.1 },
    { key: 'lb', label: 'Look back period percentile high', type: 'int', default: 50, min: 1, max: 2000 },
    { key: 'ph', label: 'Highest percentile (0.90 = 90%, 0.95 = 95%, 0.99 = 99%)', type: 'float', default: 0.85, min: 0.01, max: 5, step: 0.01 },
    { key: 'pl', label: 'Lowest percentile (1.10 = 90%, 1.05 = 95%, 1.01 = 99%)', type: 'float', default: 1.01, min: 0.01, max: 5, step: 0.01 },
  ],
  plots: [
    { key: 'wvf', title: 'Williams Vix Fix', kind: 'histogram', color: WVF_COLORS.lime, color2: WVF_COLORS.gray, width: 4 },
    // The script's "Show high range" and "Show standard deviation line" (both off): switched on in Style.
    { key: 'rangeHigh', title: 'Range High Percentile', kind: 'line', color: WVF_COLORS.orange, width: 4, hidden: true },
    { key: 'rangeLow', title: 'Range Low Percentile', kind: 'line', color: WVF_COLORS.orange, width: 4, hidden: true },
    { key: 'upperBand', title: 'Upper Band', kind: 'line', color: WVF_COLORS.aqua, width: 3, hidden: true },
  ],
  compute: (bars, i, st) => {
    const v = calculateVixFix(bars, { pd: n(i.pd), bbl: n(i.bbl), mult: Number(i.mult), lb: n(i.lb), ph: Number(i.ph), pl: Number(i.pl) })
    return {
      values: {
        wvf: toNaN(v.wvf),
        rangeHigh: toNaN(v.rangeHigh),
        rangeLow: toNaN(v.rangeLow),
        upperBand: toNaN(v.upperBand),
        green: v.isGreen.map(flag),
      },
      colors: { wvf: v.isGreen.map((g) => (g ? st.wvf.color : (st.wvf.color2 ?? WVF_COLORS.gray))) },
    }
  },
  verdict: (out, i) => {
    const at = (key: string, k = i) => {
      const v = out.values[key]?.[k]
      return v !== undefined && Number.isFinite(v) ? v : null
    }
    const wvf = at('wvf')
    if (wvf === null) return { text: 'WARMING UP', tone: 'flat' }
    // Read from the triggers whether they are drawn or not.
    return vixFixCall(wvf, at('wvf', i - 1), at('green') === 1, at('green', i - 1) === 1, at('upperBand'), at('rangeHigh'))
  },
}

// ── Zeiierman Trend Pressure ────────────────────────────────────────────────

const TP = TREND_PRESSURE_COLORS
const tpInput = (key: keyof TrendPressureSettings, label: string, group: string, min: number, max: number, step = 1): InputDef => ({
  key,
  label,
  type: step === 1 ? 'int' : 'float',
  default: TREND_PRESSURE_DEFAULTS[key],
  min,
  max,
  step,
  group,
})
/** Pine's color.new(c, 20) for the pressure levels. */
const LEVEL_ALPHA = 0.8
/** The extreme-only gradient: this opaque at the bound, clear 30 points inside it. */
const GRADIENT_ALPHA = 0.4
const CLEAR = 'rgba(0, 0, 0, 0)'
const PRESSURE_MARK = { upper: 5, lower: -107 }

export const trendPressure: IndicatorDef = {
  type: 'trendPressure',
  name: 'Zeiierman Trend Pressure',
  short: 'Trend Pressure',
  category: 'Trend',
  overlay: false,
  format: 'fixed',
  priceDrawings: true,
  // Everything lives from 0 to −100, the exhaustion marks just outside it (V2's window scale).
  floatDomain: { min: -112, max: 10 },
  inputs: [
    tpInput('pulseRange', 'Pulse range', 'Z-Pulse', 3, 2000),
    tpInput('pulseStochastic', 'Pulse stochastic', 'Z-Pulse', 3, 2000),
    tpInput('pulseSmoothing', 'Pulse smoothing', 'Z-Pulse', 1, 50),
    tpInput('trendRange', 'Trend range', 'Z-Trend', 5, 2000),
    tpInput('macroTrend', 'Macro trend', 'Z-Trend', 10, 2000),
    tpInput('trendSmoothing', 'Trend smoothing', 'Z-Trend', 1, 30),
    tpInput('trendPersistence', 'Trend persistence', 'Z-Trend', 0, 20, 0.5),
    tpInput('exhaustionZone', 'Exhaustion zone', 'Pressure Exhaustion', 5, 40),
    tpInput('sensitivity', 'Sensitivity', 'Pressure Exhaustion', 1, 10),
    tpInput('reactiveSmoothing', 'Reactive smoothing', 'Pressure Core', 1, 30),
    tpInput('regimeWeight', 'Regime weight', 'Pressure Core', 0, 1, 0.05),
    { key: 'showCrosses', label: 'Pulse / trend crosses', type: 'bool', default: false, group: 'Display' },
    { key: 'gradientFill', label: 'Gradient fill', type: 'bool', default: true, group: 'Display' },
    { key: 'priceBoxes', label: 'Price boxes', type: 'bool', default: true, group: 'Display' },
    { ...tpInput('maxBoxes', 'Max price boxes', 'Display', 1, 300), hideInTitle: true },
    { key: 'hot', label: 'Hot', type: 'color', default: TP.hot, group: 'Display', hideInTitle: true },
    { key: 'cold', label: 'Cold', type: 'color', default: TP.cold, group: 'Display', hideInTitle: true },
  ],
  plots: [
    { key: 'pulse', title: 'Z-Pulse', kind: 'line', color: TP.pulse, width: 1 },
    { key: 'trend', title: 'Z-Trend', kind: 'line', color: TP.trend, width: 2 },
    { key: 'core', title: 'Pressure Core', kind: 'line', color: TP.coreNeutral, width: 2 },
    { key: 'upperMark', title: 'Upper Pressure', kind: 'dots', color: TP.hot, width: 2 },
    { key: 'lowerMark', title: 'Lower Pressure', kind: 'dots', color: TP.cold, width: 2 },
    { key: 'bullCross', title: 'Bullish Cross', kind: 'dots', color: TP.cold, width: 4 },
    { key: 'bearCross', title: 'Bearish Cross', kind: 'dots', color: TP.hot, width: 4 },
  ],
  levels: [
    { title: 'Upper Bound', value: 0, color: alpha(TP.hot, LEVEL_ALPHA), style: 'solid' },
    { title: 'Equilibrium', value: -50, color: alpha(TP.equilibrium, LEVEL_ALPHA), style: 'solid' },
    { title: 'Lower Bound', value: -100, color: alpha(TP.cold, LEVEL_ALPHA), style: 'solid' },
  ],
  // The part of the pulse-to-trend band past −30 (hot) or −70 (cold), as V2's gradient shades it.
  fills: [
    { from: 'hotTop', to: 'hotEdge', color: CLEAR, colorsKey: 'hotBand' },
    { from: 'coldEdge', to: 'coldBottom', color: CLEAR, colorsKey: 'coldBand' },
  ],
  compute: (bars, i, st) => {
    const settings = Object.fromEntries(
      Object.keys(TREND_PRESSURE_DEFAULTS).map((k) => [k, Number(i[k] ?? TREND_PRESSURE_DEFAULTS[k as keyof TrendPressureSettings])]),
    ) as unknown as TrendPressureSettings
    const v = calculateTrendPressure(bars, settings, tickOf(bars))
    const hot = String(i.hot),
      cold = String(i.cold)
    const core = st.core
    const coreColors = v.coreTone.map((t) =>
      t === 'bull' ? alpha(TP.coreBull, 0.85) : t === 'bear' ? alpha(TP.coreBear, 0.85) : alpha(core?.color ?? TP.coreNeutral, 0.65),
    )
    // Stronger the nearer the band reaches its bound; nothing between −30 and −70.
    const hotTop: number[] = [],
      hotEdge: number[] = [],
      coldEdge: number[] = [],
      coldBottom: number[] = []
    const hotBand: string[] = [],
      coldBand: string[] = []
    v.pulse.forEach((p, k) => {
      const t = v.trend[k]
      const top = p === null || t === null ? NaN : Math.max(p, t),
        bottom = p === null || t === null ? NaN : Math.min(p, t)
      const isHot = !!i.gradientFill && top > -30,
        isCold = !!i.gradientFill && bottom < -70
      hotTop.push(isHot ? top : NaN)
      hotEdge.push(isHot ? Math.max(bottom, -30) : NaN)
      hotBand.push(isHot ? alpha(hot, (GRADIENT_ALPHA * (top + 30)) / 30) : CLEAR)
      coldEdge.push(isCold ? Math.min(top, -70) : NaN)
      coldBottom.push(isCold ? bottom : NaN)
      coldBand.push(isCold ? alpha(cold, (GRADIENT_ALPHA * (-70 - bottom)) / 30) : CLEAR)
    })
    const at = (flags: boolean[], y: number | (number | null)[]) =>
      toNaN(flags.map((on, k) => (on ? (typeof y === 'number' ? y : y[k]) : null)))

    // The pressure levels move with the zone and sensitivity, so they are drawn, not fixed levels.
    const drawings: Drawing[] = [
      { type: 'line', x1: 0, y1: v.upper, x2: 'end', y2: v.upper, color: alpha(hot, LEVEL_ALPHA), extendRight: true },
      { type: 'line', x1: 0, y1: v.lower, x2: 'end', y2: v.lower, color: alpha(cold, LEVEL_ALPHA), extendRight: true },
    ]
    // Starts are crosses on the marks' row.
    v.upperStart.forEach((on, x) => on && drawings.push({ type: 'text', x, y: PRESSURE_MARK.upper, text: '×', color: hot, size: 12, weight: 700 }))
    v.lowerStart.forEach((on, x) => on && drawings.push({ type: 'text', x, y: PRESSURE_MARK.lower, text: '×', color: cold, size: 12, weight: 700 }))

    const priceDrawings: Drawing[] = []
    if (i.priceBoxes) {
      for (const box of v.boxes) {
        const color = box.side === 'upper' ? hot : cold
        priceDrawings.push({ type: 'box', x1: box.start, x2: box.end, top: box.top, bottom: box.bottom, fill: alpha(color, 0.2), border: alpha(color, 0.4) })
      }
      // Where pressure let go: ▾ at the top of an upper box, ▴ under a lower one.
      bars.forEach((_, x) => {
        const up = v.upperReleasePrice[x],
          down = v.lowerReleasePrice[x]
        if (up !== null) priceDrawings.push({ type: 'triangle', x, y: up, dir: 'down', color: hot, size: 5 })
        if (down !== null) priceDrawings.push({ type: 'triangle', x, y: down, dir: 'up', color: cold, size: 5 })
      })
    }

    return {
      values: {
        pulse: toNaN(v.pulse),
        trend: toNaN(v.trend),
        core: toNaN(v.core),
        upperMark: at(v.upperActive.map((on, k) => on || v.upperRelease[k]), PRESSURE_MARK.upper),
        lowerMark: at(v.lowerActive.map((on, k) => on || v.lowerRelease[k]), PRESSURE_MARK.lower),
        bullCross: i.showCrosses ? at(v.crossUp, v.trend) : bars.map(() => NaN),
        bearCross: i.showCrosses ? at(v.crossDown, v.trend) : bars.map(() => NaN),
        // The call: 1 upper pressure, −1 lower, 0 neutral; crosses whether drawn or not.
        state: v.upperActive.map((on, k) => (on ? 1 : v.lowerActive[k] ? -1 : 0)),
        cross: v.crossUp.map((up, k) => (up ? 1 : v.crossDown[k] ? -1 : 0)),
        hotTop,
        hotEdge,
        coldEdge,
        coldBottom,
      },
      colors: { core: coreColors, hotBand, coldBand, upperMark: bars.map(() => hot), lowerMark: bars.map(() => cold) },
      drawings,
      priceDrawings,
    }
  },
  verdict: (out, i) => {
    const state = out.values.state?.[i]
    if (state === undefined || !Number.isFinite(out.values.pulse?.[i])) return null
    const cross = out.values.cross?.[i] === 1 ? ' · BULL CROSS' : out.values.cross?.[i] === -1 ? ' · BEAR CROSS' : ''
    if (state === 1) return { text: `UPPER PRESSURE${cross}`, tone: 'ob' }
    if (state === -1) return { text: `LOWER PRESSURE${cross}`, tone: 'os' }
    return { text: `NEUTRAL${cross}`, tone: 'flat' }
  },
}

/** The market's price step (Pine's syminfo.mintick): the finest step the recent prices show. */
function tickOf(bars: readonly Candle[]): number {
  let decimals = 0
  for (const b of bars.slice(-50))
    for (const p of [b.open, b.high, b.low, b.close]) {
      const s = String(p)
      const dot = s.indexOf('.')
      if (dot >= 0 && !s.includes('e')) decimals = Math.max(decimals, s.length - dot - 1)
    }
  return decimals ? 10 ** -Math.min(decimals, 8) : 1
}
