import { source, type Source } from './math'
import { calculateTux } from './tux'
import type { Drawing, IndicatorDef } from './types'

// Old Pine named colours, which TradingView keeps for this 2019 script, as its legend shows them.
// Plots without an explicit transparency draw at 65% opacity (TradingView's default for these
// scripts); the triangles and entry arrows set transp = 0.
const RED = '#ff0000'
const GREEN = '#008000'
const LIME = '#00ff00'
const BLUE = '#0000ff'
const DEEP_PINK = '#ff1493'
const LIGHT_GREEN = '#90ee90'
const dim = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, 0.65)`
}

const flag = (on: boolean) => (on ? 1 : 0)

/** "TUX EMA Scalper+SuperTrend" (3, 7, 20, close): see tux.ts for what it is made of. */
export const tuxEmaScalper: IndicatorDef = {
  type: 'tuxEmaScalper',
  name: 'TUX EMA Scalper+SuperTrend',
  short: 'TUX EMA Scalper+SuperTrend',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  precision: 4,
  inputs: [
    { key: 'factor', label: 'Factor', type: 'int', default: 3, min: 1, max: 100 },
    { key: 'pd', label: 'Pd', type: 'int', default: 7, min: 1, max: 100 },
    { key: 'length', label: 'Length', type: 'int', default: 20, min: 1, max: 5000 },
    { key: 'source', label: 'Source', type: 'source', default: 'close' },
  ],
  // The script's ten plots, in its legend order. The marks are values only: drawn as shapes.
  plots: [
    { key: 'tsl', title: 'SuperTrend', kind: 'line', color: dim(GREEN), color2: dim(RED), width: 2 },
    { key: 'upArrow', title: 'Up Arrow', kind: 'value', color: GREEN },
    { key: 'downArrow', title: 'Down Arrow', kind: 'value', color: RED },
    { key: 'entryUp', title: 'Up Entry Arrow', kind: 'value', color: LIME },
    { key: 'entryDown', title: 'Down Entry Arrow', kind: 'value', color: RED },
    { key: 'ema', title: 'EMA', kind: 'line', color: dim(BLUE), width: 1 },
    { key: 'highest', title: 'Highest close (8)', kind: 'line', color: dim(DEEP_PINK), width: 2 },
    { key: 'lowest', title: 'Lowest close (8)', kind: 'line', color: dim(LIGHT_GREEN), width: 2 },
    { key: 'sell', title: 'Sell', kind: 'value', color: dim(RED) },
    { key: 'buy', title: 'Buy', kind: 'value', color: dim(GREEN) },
  ],
  compute: (bars, i, st) => {
    const v = calculateTux(bars, {
      factor: Number(i.factor),
      pd: Math.max(1, Math.round(Number(i.pd))),
      length: Math.max(1, Math.round(Number(i.length))),
      source: source(bars, i.source as Source),
    })
    const shown = (key: string) => st[key]?.visible !== false
    const drawings: Drawing[] = []
    bars.forEach((b, x) => {
      // Marks on the same side of a bar stack outward in plot order, as TradingView stacks them.
      let below = 4,
        above = 4
      if (v.upArrow[x] && shown('upArrow')) {
        drawings.push({ type: 'shape', shape: 'triangleUp', x, y: b.low, offset: below, color: st.upArrow.color })
        below += 10
      }
      if (v.downArrow[x] && shown('downArrow')) {
        drawings.push({ type: 'shape', shape: 'triangleDown', x, y: b.high, offset: above, color: st.downArrow.color })
        above += 10
      }
      if (v.buy[x] && shown('buy')) {
        drawings.push({ type: 'shape', shape: 'arrowUp', x, y: b.low, offset: below, color: st.buy.color, text: 'Buy' })
        below += 30
      }
      if (v.sell[x] && shown('sell')) {
        drawings.push({ type: 'shape', shape: 'arrowDown', x, y: b.high, offset: above, color: st.sell.color, text: 'Sell' })
        above += 30
      }
      // plotarrow draws apart from the shapes, from the bar outward.
      if (v.entryUp[x] && shown('entryUp'))
        drawings.push({ type: 'shape', shape: 'plotArrowUp', x, y: b.low, offset: below, color: st.entryUp.color })
      if (v.entryDown[x] && shown('entryDown'))
        drawings.push({ type: 'shape', shape: 'plotArrowDown', x, y: b.high, offset: above, color: st.entryDown.color })
    })
    return {
      values: {
        tsl: v.tsl,
        upArrow: v.upArrow.map(flag),
        downArrow: v.downArrow.map(flag),
        entryUp: v.entryUp.map((on) => (on ? 1 : NaN)),
        entryDown: v.entryDown.map((on) => (on ? -1 : NaN)),
        ema: v.ema,
        highest: v.highest,
        lowest: v.lowest,
        sell: v.sell.map(flag),
        buy: v.buy.map(flag),
      },
      // linecolor = Trend == 1 ? green : red
      colors: { tsl: v.trend.map((t) => (t === 1 ? st.tsl.color : (st.tsl.color2 ?? dim(RED)))) },
      drawings,
    }
  },
}
