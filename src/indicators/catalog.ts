import type { Candle } from '../data/types'
import * as ta from './math'
import type { IndicatorDef, IndicatorInstance, InputDef, InputValue, LevelDef, PlotStyle } from './types'

// TradingView's built-in palette.
const BLUE = '#2962ff'
const ORANGE = '#ff6d00'
const PURPLE = '#7e57c2'
const GREEN = '#089981'
const RED = '#f23645'
const BAND = '#787b86'
const MIDDLE = 'rgba(120, 123, 134, 0.5)'
const BLUE_FILL = 'rgba(33, 150, 243, 0.05)'
const BLUE_BAND = 'rgba(33, 150, 243, 0.1)'
const PURPLE_BAND = 'rgba(126, 87, 194, 0.1)'

const len = (def: number, label = 'Length'): InputDef => ({ key: 'length', label, type: 'int', default: def, min: 1, max: 5000 })
const src = (def: ta.Source = 'close'): InputDef => ({ key: 'source', label: 'Source', type: 'source', default: def })
const mult = (def = 2, label = 'StdDev'): InputDef => ({ key: 'mult', label, type: 'float', default: def, min: 0.001, max: 50, step: 0.1 })

const n = (v: InputValue) => Math.max(1, Math.round(Number(v)))
const s = (bars: readonly Candle[], v: InputValue) => ta.source(bars, v as ta.Source)

function bands(upper: number, lower: number, middle?: number): LevelDef[] {
  const levels: LevelDef[] = [{ title: 'Upper Band', value: upper, color: BAND, style: 'dashed' }]
  if (middle !== undefined) levels.push({ title: 'Middle Band', value: middle, color: MIDDLE, style: 'dotted' })
  levels.push({ title: 'Lower Band', value: lower, color: BAND, style: 'dashed' })
  return levels
}

function movingAverage(type: string, name: string, short: string, maker: (x: ta.Series, l: number) => ta.Series, length = 9): IndicatorDef {
  return {
    type,
    name,
    short,
    category: 'Trend',
    overlay: true,
    format: 'price',
    inputs: [len(length), src()],
    plots: [{ key: 'ma', title: short, kind: 'line', color: BLUE }],
    compute: (bars, i) => ({ values: { ma: maker(s(bars, i.source), n(i.length)) } }),
  }
}

function bollinger(bars: readonly Candle[], i: Record<string, InputValue>) {
  const x = s(bars, i.source)
  const basis = ta.sma(x, n(i.length))
  const dev = ta.stdev(x, n(i.length)).map((d) => d * Number(i.mult))
  return { x, basis, upper: basis.map((b, k) => b + dev[k]), lower: basis.map((b, k) => b - dev[k]) }
}

const volumeColors = (bars: readonly Candle[], st: Record<string, PlotStyle>, key: string) =>
  bars.map((b) => (b.close >= b.open ? st[key].color : st[key].color2))

export const INDICATORS: IndicatorDef[] = [
  {
    type: 'volume',
    name: 'Volume',
    short: 'Vol',
    category: 'Volume',
    overlay: true,
    ownScale: true,
    format: 'volume',
    inputs: [{ key: 'maLength', label: 'MA Length', type: 'int', default: 20, min: 1, max: 5000, hideInTitle: true }],
    plots: [
      { key: 'volume', title: 'Volume', kind: 'histogram', color: 'rgba(34, 171, 148, 0.5)', color2: 'rgba(247, 82, 95, 0.5)' },
      { key: 'ma', title: 'Volume MA', kind: 'line', color: BLUE, hidden: true },
    ],
    compute: (bars, i, st) => {
      const vol = bars.map((b) => b.volume)
      return { values: { volume: vol, ma: ta.sma(vol, n(i.maLength)) }, colors: { volume: volumeColors(bars, st, 'volume') } }
    },
  },
  movingAverage('sma', 'Moving Average Simple', 'SMA', ta.sma),
  movingAverage('ema', 'Moving Average Exponential', 'EMA', ta.ema),
  movingAverage('wma', 'Moving Average Weighted', 'WMA', ta.wma),
  movingAverage('hma', 'Hull Moving Average', 'HMA', ta.hma),
  {
    type: 'vwma',
    name: 'Volume Weighted Moving Average',
    short: 'VWMA',
    category: 'Trend',
    overlay: true,
    format: 'price',
    inputs: [len(20), src()],
    plots: [{ key: 'ma', title: 'VWMA', kind: 'line', color: BLUE }],
    compute: (bars, i) => ({ values: { ma: ta.vwma(s(bars, i.source), bars.map((b) => b.volume), n(i.length)) } }),
  },
  {
    type: 'maCross',
    name: 'MA Cross',
    short: 'MA Cross',
    category: 'Trend',
    overlay: true,
    format: 'price',
    inputs: [
      { key: 'short', label: 'Short', type: 'int', default: 9, min: 1, max: 5000 },
      { key: 'long', label: 'Long', type: 'int', default: 21, min: 1, max: 5000 },
    ],
    plots: [
      { key: 'short', title: 'Short', kind: 'line', color: ORANGE },
      { key: 'long', title: 'Long', kind: 'line', color: BLUE },
    ],
    compute: (bars, i) => {
      const c = ta.source(bars, 'close')
      return { values: { short: ta.sma(c, n(i.short)), long: ta.sma(c, n(i.long)) } }
    },
  },
  {
    type: 'bb',
    name: 'Bollinger Bands',
    short: 'BB',
    category: 'Volatility',
    overlay: true,
    format: 'price',
    inputs: [len(20), src(), mult()],
    plots: [
      { key: 'basis', title: 'Basis', kind: 'line', color: ORANGE },
      { key: 'upper', title: 'Upper', kind: 'line', color: BLUE },
      { key: 'lower', title: 'Lower', kind: 'line', color: BLUE },
    ],
    fills: [{ from: 'upper', to: 'lower', color: BLUE_FILL }],
    compute: (bars, i) => {
      const { basis, upper, lower } = bollinger(bars, i)
      return { values: { basis, upper, lower } }
    },
  },
  {
    type: 'kc',
    name: 'Keltner Channels',
    short: 'KC',
    category: 'Volatility',
    overlay: true,
    format: 'price',
    inputs: [len(20), mult(2, 'Multiplier'), src(), { key: 'atrLength', label: 'ATR Length', type: 'int', default: 10, min: 1, max: 5000 }],
    plots: [
      { key: 'upper', title: 'Upper', kind: 'line', color: BLUE },
      { key: 'basis', title: 'Basis', kind: 'line', color: BLUE },
      { key: 'lower', title: 'Lower', kind: 'line', color: BLUE },
    ],
    fills: [{ from: 'upper', to: 'lower', color: BLUE_FILL }],
    compute: (bars, i) => {
      const basis = ta.ema(s(bars, i.source), n(i.length))
      const range = ta.atr(bars, n(i.atrLength))
      const m = Number(i.mult)
      return {
        values: { basis, upper: basis.map((b, k) => b + m * range[k]), lower: basis.map((b, k) => b - m * range[k]) },
      }
    },
  },
  {
    type: 'dc',
    name: 'Donchian Channels',
    short: 'DC',
    category: 'Volatility',
    overlay: true,
    format: 'price',
    inputs: [len(20)],
    plots: [
      { key: 'basis', title: 'Basis', kind: 'line', color: ORANGE },
      { key: 'upper', title: 'Upper', kind: 'line', color: BLUE },
      { key: 'lower', title: 'Lower', kind: 'line', color: BLUE },
    ],
    fills: [{ from: 'upper', to: 'lower', color: BLUE_FILL }],
    compute: (bars, i) => {
      const upper = ta.highest(ta.source(bars, 'high'), n(i.length))
      const lower = ta.lowest(ta.source(bars, 'low'), n(i.length))
      return { values: { upper, lower, basis: upper.map((u, k) => (u + lower[k]) / 2) } }
    },
  },
  {
    type: 'env',
    name: 'Envelope',
    short: 'Env',
    category: 'Trend',
    overlay: true,
    format: 'price',
    inputs: [len(20), { key: 'percent', label: 'Percent', type: 'float', default: 10, min: 0, max: 100, step: 0.5 }, src(), { key: 'exponential', label: 'Exponential', type: 'bool', default: false, hideInTitle: true }],
    plots: [
      { key: 'basis', title: 'Basis', kind: 'line', color: ORANGE },
      { key: 'upper', title: 'Upper', kind: 'line', color: BLUE },
      { key: 'lower', title: 'Lower', kind: 'line', color: BLUE },
    ],
    fills: [{ from: 'upper', to: 'lower', color: BLUE_FILL }],
    compute: (bars, i) => {
      const x = s(bars, i.source)
      const basis = i.exponential ? ta.ema(x, n(i.length)) : ta.sma(x, n(i.length))
      const k = Number(i.percent) / 100
      return { values: { basis, upper: basis.map((b) => b * (1 + k)), lower: basis.map((b) => b * (1 - k)) } }
    },
  },
  {
    type: 'vwap',
    name: 'Volume Weighted Average Price',
    short: 'VWAP',
    category: 'Volume',
    overlay: true,
    format: 'price',
    inputs: [src('hlc3')],
    plots: [{ key: 'vwap', title: 'VWAP', kind: 'line', color: BLUE }],
    compute: (bars, i) => {
      // Anchored to the session: crypto sessions start at 00:00 UTC.
      const x = s(bars, i.source)
      const out: number[] = []
      let day = -1,
        pv = 0,
        vol = 0
      bars.forEach((b, k) => {
        const d = Math.floor(b.time / 86400)
        if (d !== day) {
          day = d
          pv = 0
          vol = 0
        }
        pv += x[k] * b.volume
        vol += b.volume
        out.push(vol ? pv / vol : x[k])
      })
      return { values: { vwap: out } }
    },
  },
  {
    type: 'psar',
    name: 'Parabolic SAR',
    short: 'SAR',
    category: 'Trend',
    overlay: true,
    format: 'price',
    inputs: [
      { key: 'start', label: 'Start', type: 'float', default: 0.02, min: 0.001, max: 1, step: 0.01 },
      { key: 'increment', label: 'Increment', type: 'float', default: 0.02, min: 0.001, max: 1, step: 0.01 },
      { key: 'maximum', label: 'Max value', type: 'float', default: 0.2, min: 0.01, max: 1, step: 0.01 },
    ],
    plots: [{ key: 'sar', title: 'ParabolicSAR', kind: 'dots', color: BLUE }],
    compute: (bars, i) => ({ values: { sar: parabolicSar(bars, Number(i.start), Number(i.increment), Number(i.maximum)) } }),
  },
  {
    type: 'supertrend',
    name: 'Supertrend',
    short: 'Supertrend',
    category: 'Trend',
    overlay: true,
    format: 'price',
    inputs: [
      { key: 'atrPeriod', label: 'ATR Length', type: 'int', default: 10, min: 1, max: 5000 },
      { key: 'factor', label: 'Factor', type: 'float', default: 3, min: 0.01, max: 50, step: 0.1 },
    ],
    plots: [
      { key: 'up', title: 'Up Trend', kind: 'line', color: GREEN },
      { key: 'down', title: 'Down Trend', kind: 'line', color: RED },
    ],
    compute: (bars, i) => supertrend(bars, n(i.atrPeriod), Number(i.factor)),
  },
  {
    type: 'rsi',
    name: 'Relative Strength Index',
    short: 'RSI',
    category: 'Oscillators',
    overlay: false,
    format: 'fixed',
    inputs: [len(14, 'RSI Length'), src()],
    plots: [{ key: 'rsi', title: 'RSI', kind: 'line', color: PURPLE }],
    levels: bands(70, 30, 50),
    fills: [{ from: 70, to: 30, color: PURPLE_BAND }],
    compute: (bars, i) => ({ values: { rsi: ta.rsi(s(bars, i.source), n(i.length)) } }),
  },
  {
    type: 'macd',
    name: 'MACD',
    short: 'MACD',
    category: 'Oscillators',
    overlay: false,
    format: 'price',
    inputs: [
      { key: 'fast', label: 'Fast Length', type: 'int', default: 12, min: 1, max: 5000 },
      { key: 'slow', label: 'Slow Length', type: 'int', default: 26, min: 1, max: 5000 },
      src(),
      { key: 'signal', label: 'Signal Smoothing', type: 'int', default: 9, min: 1, max: 50 },
      { key: 'oscMa', label: 'Oscillator MA Type', type: 'select', default: 'EMA', options: ['EMA', 'SMA'], hideInTitle: true },
      { key: 'sigMa', label: 'Signal Line MA Type', type: 'select', default: 'EMA', options: ['EMA', 'SMA'], hideInTitle: true },
    ],
    plots: [
      { key: 'hist', title: 'Histogram', kind: 'histogram', color: '#26a69a', color2: '#ff5252' },
      { key: 'macd', title: 'MACD', kind: 'line', color: BLUE },
      { key: 'signal', title: 'Signal', kind: 'line', color: ORANGE },
    ],
    levels: [{ title: 'Zero Line', value: 0, color: MIDDLE, style: 'solid' }],
    compute: (bars, i, st) => {
      const x = s(bars, i.source)
      const fast = ta.ma(i.oscMa as ta.MaType, x, n(i.fast))
      const slow = ta.ma(i.oscMa as ta.MaType, x, n(i.slow))
      const macd = fast.map((f, k) => f - slow[k])
      const signal = ta.ma(i.sigMa as ta.MaType, macd, n(i.signal))
      const hist = macd.map((m, k) => m - signal[k])
      // TradingView's four histogram shades: strong while growing away from zero.
      const colors = hist.map((h, k) => {
        const rising = k > 0 && h > hist[k - 1]
        if (h >= 0) return rising ? st.hist.color : '#b2dfdb'
        return rising ? '#ffcdd2' : st.hist.color2
      })
      return { values: { hist, macd, signal }, colors: { hist: colors } }
    },
  },
  {
    type: 'stoch',
    name: 'Stochastic',
    short: 'Stoch',
    category: 'Oscillators',
    overlay: false,
    format: 'fixed',
    inputs: [
      { key: 'kLength', label: '%K Length', type: 'int', default: 14, min: 1, max: 5000 },
      { key: 'kSmooth', label: '%K Smoothing', type: 'int', default: 1, min: 1, max: 500 },
      { key: 'dSmooth', label: '%D Smoothing', type: 'int', default: 3, min: 1, max: 500 },
    ],
    plots: [
      { key: 'k', title: '%K', kind: 'line', color: BLUE },
      { key: 'd', title: '%D', kind: 'line', color: ORANGE },
    ],
    levels: bands(80, 20, 50),
    fills: [{ from: 80, to: 20, color: BLUE_BAND }],
    compute: (bars, i) => {
      const raw = ta.stoch(ta.source(bars, 'close'), ta.source(bars, 'high'), ta.source(bars, 'low'), n(i.kLength))
      const k = ta.sma(raw, n(i.kSmooth))
      return { values: { k, d: ta.sma(k, n(i.dSmooth)) } }
    },
  },
  {
    type: 'stochRsi',
    name: 'Stochastic RSI',
    short: 'Stoch RSI',
    category: 'Oscillators',
    overlay: false,
    format: 'fixed',
    inputs: [
      { key: 'k', label: 'K', type: 'int', default: 3, min: 1, max: 500 },
      { key: 'd', label: 'D', type: 'int', default: 3, min: 1, max: 500 },
      { key: 'rsiLength', label: 'RSI Length', type: 'int', default: 14, min: 1, max: 5000 },
      { key: 'stochLength', label: 'Stochastic Length', type: 'int', default: 14, min: 1, max: 5000 },
      src(),
    ],
    plots: [
      { key: 'k', title: 'K', kind: 'line', color: BLUE },
      { key: 'd', title: 'D', kind: 'line', color: ORANGE },
    ],
    levels: bands(80, 20, 50),
    fills: [{ from: 80, to: 20, color: BLUE_BAND }],
    compute: (bars, i) => {
      const r = ta.rsi(s(bars, i.source), n(i.rsiLength))
      const k = ta.sma(ta.stoch(r, r, r, n(i.stochLength)), n(i.k))
      return { values: { k, d: ta.sma(k, n(i.d)) } }
    },
  },
  {
    type: 'cci',
    name: 'Commodity Channel Index',
    short: 'CCI',
    category: 'Oscillators',
    overlay: false,
    format: 'fixed',
    inputs: [len(20), src('hlc3')],
    plots: [{ key: 'cci', title: 'CCI', kind: 'line', color: BLUE }],
    levels: bands(100, -100, 0),
    fills: [{ from: 100, to: -100, color: BLUE_BAND }],
    compute: (bars, i) => {
      const x = s(bars, i.source)
      const l = n(i.length)
      const mean = ta.sma(x, l)
      const cci = x.map((v, k) => {
        if (!Number.isFinite(mean[k])) return NaN
        let dev = 0
        for (let j = 0; j < l; j++) dev += Math.abs(x[k - j] - mean[k])
        dev /= l
        return dev === 0 ? 0 : (v - mean[k]) / (0.015 * dev)
      })
      return { values: { cci } }
    },
  },
  {
    type: 'willr',
    name: 'Williams %R',
    short: '%R',
    category: 'Oscillators',
    overlay: false,
    format: 'fixed',
    inputs: [len(14), src()],
    plots: [{ key: 'r', title: '%R', kind: 'line', color: PURPLE }],
    levels: bands(-20, -80, -50),
    fills: [{ from: -20, to: -80, color: PURPLE_BAND }],
    compute: (bars, i) => {
      const hh = ta.highest(ta.source(bars, 'high'), n(i.length))
      const ll = ta.lowest(ta.source(bars, 'low'), n(i.length))
      const x = s(bars, i.source)
      return { values: { r: x.map((v, k) => (hh[k] === ll[k] ? NaN : (100 * (v - hh[k])) / (hh[k] - ll[k]))) } }
    },
  },
  {
    type: 'mom',
    name: 'Momentum',
    short: 'Mom',
    category: 'Oscillators',
    overlay: false,
    format: 'price',
    inputs: [len(10), src()],
    plots: [{ key: 'mom', title: 'Momentum', kind: 'line', color: BLUE }],
    compute: (bars, i) => ({ values: { mom: ta.change(s(bars, i.source), n(i.length)) } }),
  },
  {
    type: 'roc',
    name: 'Rate Of Change',
    short: 'ROC',
    category: 'Oscillators',
    overlay: false,
    format: 'fixed',
    inputs: [len(9), src()],
    plots: [{ key: 'roc', title: 'ROC', kind: 'line', color: BLUE }],
    levels: [{ title: 'Zero Line', value: 0, color: MIDDLE, style: 'solid' }],
    compute: (bars, i) => {
      const x = s(bars, i.source)
      const l = n(i.length)
      return { values: { roc: x.map((v, k) => (k >= l ? (100 * (v - x[k - l])) / x[k - l] : NaN)) } }
    },
  },
  {
    type: 'ao',
    name: 'Awesome Oscillator',
    short: 'AO',
    category: 'Oscillators',
    overlay: false,
    format: 'price',
    inputs: [],
    plots: [{ key: 'ao', title: 'Plot', kind: 'histogram', color: GREEN, color2: RED }],
    compute: (bars, _i, st) => {
      const hl2 = ta.source(bars, 'hl2')
      const fast = ta.sma(hl2, 5),
        slow = ta.sma(hl2, 34)
      const ao = fast.map((f, k) => f - slow[k])
      return {
        values: { ao },
        colors: { ao: ao.map((v, k) => (k > 0 && v - ao[k - 1] >= 0 ? st.ao.color : st.ao.color2)) },
      }
    },
  },
  {
    type: 'dmi',
    name: 'Directional Movement Index',
    short: 'DMI',
    category: 'Trend',
    overlay: false,
    format: 'fixed',
    inputs: [
      { key: 'adxSmoothing', label: 'ADX Smoothing', type: 'int', default: 14, min: 1, max: 50 },
      { key: 'diLength', label: 'DI Length', type: 'int', default: 14, min: 1, max: 5000 },
    ],
    plots: [
      { key: 'adx', title: 'ADX', kind: 'line', color: '#f50057' },
      { key: 'plus', title: '+DI', kind: 'line', color: BLUE },
      { key: 'minus', title: '-DI', kind: 'line', color: ORANGE },
    ],
    compute: (bars, i) => directionalMovement(bars, n(i.diLength), n(i.adxSmoothing)),
  },
  {
    type: 'aroon',
    name: 'Aroon',
    short: 'Aroon',
    category: 'Trend',
    overlay: false,
    format: 'fixed',
    inputs: [len(14)],
    plots: [
      { key: 'up', title: 'Aroon Up', kind: 'line', color: '#fb8c00' },
      { key: 'down', title: 'Aroon Down', kind: 'line', color: BLUE },
    ],
    compute: (bars, i) => {
      const l = n(i.length)
      const up: number[] = [],
        down: number[] = []
      bars.forEach((_, k) => {
        if (k < l) {
          up.push(NaN)
          down.push(NaN)
          return
        }
        let hi = 0,
          lo = 0
        for (let j = 0; j <= l; j++) {
          if (bars[k - j].high > bars[k - hi].high) hi = j
          if (bars[k - j].low < bars[k - lo].low) lo = j
        }
        up.push((100 * (l - hi)) / l)
        down.push((100 * (l - lo)) / l)
      })
      return { values: { up, down } }
    },
  },
  {
    type: 'atr',
    name: 'Average True Range',
    short: 'ATR',
    category: 'Volatility',
    overlay: false,
    format: 'price',
    inputs: [len(14), { key: 'smoothing', label: 'Smoothing', type: 'select', default: 'RMA', options: ['RMA', 'SMA', 'EMA', 'WMA'] }],
    plots: [{ key: 'atr', title: 'ATR', kind: 'line', color: '#b71c1c' }],
    compute: (bars, i) => ({ values: { atr: ta.ma(i.smoothing as ta.MaType, ta.trueRange(bars), n(i.length)) } }),
  },
  {
    type: 'bbw',
    name: 'Bollinger BandWidth',
    short: 'BBW',
    category: 'Volatility',
    overlay: false,
    format: 'fixed',
    inputs: [len(20), src(), mult()],
    plots: [{ key: 'bbw', title: 'Bollinger BandWidth', kind: 'line', color: '#138484' }],
    compute: (bars, i) => {
      const { basis, upper, lower } = bollinger(bars, i)
      return { values: { bbw: upper.map((u, k) => (100 * (u - lower[k])) / basis[k]) } }
    },
  },
  {
    type: 'bbpb',
    name: 'Bollinger Bands %b',
    short: 'BB %b',
    category: 'Volatility',
    overlay: false,
    format: 'fixed',
    inputs: [len(20), src(), mult()],
    plots: [{ key: 'pb', title: 'Bollinger Bands %b', kind: 'line', color: '#22ab94' }],
    levels: [
      { title: 'Overbought', value: 1, color: BAND, style: 'dashed' },
      { title: 'Oversold', value: 0, color: BAND, style: 'dashed' },
    ],
    fills: [{ from: 1, to: 0, color: 'rgba(34, 171, 148, 0.1)' }],
    compute: (bars, i) => {
      const { x, upper, lower } = bollinger(bars, i)
      return { values: { pb: x.map((v, k) => (v - lower[k]) / (upper[k] - lower[k])) } }
    },
  },
  {
    type: 'obv',
    name: 'On Balance Volume',
    short: 'OBV',
    category: 'Volume',
    overlay: false,
    format: 'volume',
    inputs: [],
    plots: [{ key: 'obv', title: 'OnBalanceVolume', kind: 'line', color: BLUE }],
    compute: (bars) => {
      let total = 0
      return {
        values: {
          obv: bars.map((b, k) => {
            if (k > 0) total += Math.sign(b.close - bars[k - 1].close) * b.volume
            return total
          }),
        },
      }
    },
  },
  {
    type: 'mfi',
    name: 'Money Flow Index',
    short: 'MFI',
    category: 'Volume',
    overlay: false,
    format: 'fixed',
    inputs: [len(14)],
    plots: [{ key: 'mfi', title: 'MF', kind: 'line', color: PURPLE }],
    levels: bands(80, 20, 50),
    fills: [{ from: 80, to: 20, color: PURPLE_BAND }],
    compute: (bars, i) => {
      const tp = ta.source(bars, 'hlc3')
      const l = n(i.length)
      const up = ta.sum(
        tp.map((v, k) => (k > 0 && v > tp[k - 1] ? v * bars[k].volume : 0)),
        l,
      )
      const down = ta.sum(
        tp.map((v, k) => (k > 0 && v < tp[k - 1] ? v * bars[k].volume : 0)),
        l,
      )
      return { values: { mfi: up.map((u, k) => (down[k] === 0 ? 100 : 100 - 100 / (1 + u / down[k]))) } }
    },
  },
  {
    type: 'cmf',
    name: 'Chaikin Money Flow',
    short: 'CMF',
    category: 'Volume',
    overlay: false,
    format: 'fixed',
    inputs: [len(20)],
    plots: [{ key: 'cmf', title: 'MF', kind: 'line', color: '#43a047' }],
    levels: [{ title: 'Zero', value: 0, color: MIDDLE, style: 'solid' }],
    compute: (bars, i) => {
      const ad = bars.map((b) =>
        b.high === b.low ? 0 : (((2 * b.close - b.low - b.high) / (b.high - b.low)) * b.volume),
      )
      const l = n(i.length)
      const vol = ta.sum(
        bars.map((b) => b.volume),
        l,
      )
      return { values: { cmf: ta.sum(ad, l).map((v, k) => v / vol[k]) } }
    },
  },
]

export const INDICATOR_BY_TYPE = new Map(INDICATORS.map((d) => [d.type, d]))

function parabolicSar(bars: readonly Candle[], start: number, inc: number, max: number): number[] {
  const out: number[] = new Array(bars.length).fill(NaN)
  if (bars.length < 2) return out
  let up = bars[1].close >= bars[0].close
  let sar = up ? bars[0].low : bars[0].high
  let ep = up ? bars[1].high : bars[1].low
  let af = start
  out[1] = sar
  for (let k = 2; k < bars.length; k++) {
    const b = bars[k]
    sar = sar + af * (ep - sar)
    if (up) {
      sar = Math.min(sar, bars[k - 1].low, bars[k - 2].low)
      if (b.low < sar) {
        up = false
        sar = ep
        ep = b.low
        af = start
      } else if (b.high > ep) {
        ep = b.high
        af = Math.min(max, af + inc)
      }
    } else {
      sar = Math.max(sar, bars[k - 1].high, bars[k - 2].high)
      if (b.high > sar) {
        up = true
        sar = ep
        ep = b.high
        af = start
      } else if (b.low < ep) {
        ep = b.low
        af = Math.min(max, af + inc)
      }
    }
    out[k] = sar
  }
  return out
}

function supertrend(bars: readonly Candle[], period: number, factor: number) {
  const a = ta.atr(bars, period)
  const hl2 = ta.source(bars, 'hl2')
  const up: number[] = [],
    down: number[] = []
  let lower = NaN,
    upper = NaN,
    trend = 1
  bars.forEach((b, k) => {
    if (!Number.isFinite(a[k])) {
      up.push(NaN)
      down.push(NaN)
      return
    }
    const prevClose = k > 0 ? bars[k - 1].close : b.close
    let lo = hl2[k] - factor * a[k],
      hi = hl2[k] + factor * a[k]
    if (Number.isFinite(lower) && prevClose > lower) lo = Math.max(lo, lower)
    if (Number.isFinite(upper) && prevClose < upper) hi = Math.min(hi, upper)
    if (trend === -1 && Number.isFinite(upper) && b.close > upper) trend = 1
    else if (trend === 1 && Number.isFinite(lower) && b.close < lower) trend = -1
    lower = lo
    upper = hi
    up.push(trend === 1 ? lo : NaN)
    down.push(trend === -1 ? hi : NaN)
  })
  return { values: { up, down } }
}

function directionalMovement(bars: readonly Candle[], diLength: number, adxLength: number) {
  const plusDm = bars.map((b, k) => {
    if (k === 0) return 0
    const u = b.high - bars[k - 1].high,
      d = bars[k - 1].low - b.low
    return u > d && u > 0 ? u : 0
  })
  const minusDm = bars.map((b, k) => {
    if (k === 0) return 0
    const u = b.high - bars[k - 1].high,
      d = bars[k - 1].low - b.low
    return d > u && d > 0 ? d : 0
  })
  const tr = ta.rma(ta.trueRange(bars), diLength)
  const plus = ta.rma(plusDm, diLength).map((v, k) => (100 * v) / tr[k])
  const minus = ta.rma(minusDm, diLength).map((v, k) => (100 * v) / tr[k])
  const dx = plus.map((p, k) => {
    const sum = p + minus[k]
    return Math.abs(p - minus[k]) / (sum === 0 ? 1 : sum)
  })
  const adx = ta.rma(dx, adxLength).map((v) => 100 * v)
  return { values: { adx, plus, minus } }
}

let counter = 0
const uid = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

export function defaultStyles(def: IndicatorDef): Record<string, PlotStyle> {
  return Object.fromEntries(
    def.plots.map((p) => [p.key, { color: p.color, color2: p.color2, width: p.width ?? 1, visible: !p.hidden }]),
  )
}

export function defaultInputs(def: IndicatorDef): Record<string, InputValue> {
  return Object.fromEntries(def.inputs.map((i) => [i.key, i.default]))
}

export function createInstance(type: string): IndicatorInstance {
  const def = INDICATOR_BY_TYPE.get(type)!
  return { id: uid(), type, inputs: defaultInputs(def), styles: defaultStyles(def), hidden: false }
}

/** The legend title: "RSI 14 close", "BB 20 close 2". */
export function instanceTitle(def: IndicatorDef, inst: IndicatorInstance): string {
  const parts = def.inputs
    .filter((i) => !i.hideInTitle && i.type !== 'bool')
    .map((i) => String(inst.inputs[i.key] ?? i.default))
  return [def.short, ...parts].join(' ')
}
