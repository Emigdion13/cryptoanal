/**
 * Kalshi Strike: the strike of Kalshi's 15-minute up/down market for the charted coin, as on
 * btcAnalyzerV2. The live window's strike as a line across the chart to the price axis, and a
 * badge: UP or DOWN, by how much, time left in the window and Kalshi's Yes price. Past windows'
 * strikes (a step line) and ± target lines are optional.
 *
 * The strike is Kalshi's own number (`floor_strike`, a 60-second CF Benchmarks average), never an
 * estimate from Coinbase candles: with no answer from Kalshi the chart says so instead.
 */
import { KALSHI_WINDOW, kalshiState } from '../data/kalshi'
import { formatCountdown, formatPrice } from '../format'
import type { Drawing, IndicatorDef } from './types'

const AMBER = '#f5a623'
const UP = '#2bb99b'
const DOWN = '#ed6773'

export const kalshiStrike: IndicatorDef = {
  type: 'kalshiStrike',
  name: 'Kalshi Strike (15m up/down)',
  short: 'Kalshi Strike',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  external: true,
  inputs: [
    { key: 'showHistory', label: 'Show past windows', type: 'bool', default: false },
    { key: 'buffer', label: 'Target buffer ($)', type: 'float', default: 50, min: 0, max: 100000, step: 5, hideInTitle: true },
    { key: 'showBadge', label: 'Show UP/DOWN badge', type: 'bool', default: true },
    { key: 'showOdds', label: 'Show Kalshi Yes price', type: 'bool', default: true },
  ],
  plots: [
    { key: 'strike', title: 'Strike', kind: 'step', color: AMBER, width: 2 },
    { key: 'upper', title: 'Upper target', kind: 'line', color: UP, hidden: true },
    { key: 'lower', title: 'Lower target', kind: 'line', color: DOWN, hidden: true },
  ],
  compute: (bars, i, st, ctx) => {
    const { reply, status, message } = kalshiState(ctx.product)
    const windows = new Map<number, number>()
    // Past windows only on request: by default the chart shows the strike that counts now.
    if (i.showHistory) for (const w of reply?.history ?? []) windows.set(w.start, w.strike)
    const current = reply?.current ?? null
    if (current) windows.set(current.start, current.strike)

    // Each bar takes the strike of the window running at its last moment (the newest bar: now).
    const now = Date.now() / 1000
    const strike = bars.map((b) => {
      const t = Math.min(b.time + ctx.interval.seconds - 1, now)
      return windows.get(Math.floor(t / KALSHI_WINDOW) * KALSHI_WINDOW) ?? NaN
    })
    const buffer = Number(i.buffer) || 0
    const drawings: Drawing[] = []
    const last = bars[bars.length - 1]

    if (last && current && now >= current.start && now < current.end) {
      const color = st.strike?.color ?? AMBER
      // The live strike runs on to the axis, like TradingView's price line: from its window's start
      // under the past windows' steps, across the whole chart without them.
      const from = i.showHistory ? ctx.timeToIndex(current.start) : 0
      drawings.push({ type: 'line', x1: from, y1: current.strike, x2: 'end', y2: current.strike, color, width: 1, dash: [4, 4], extendRight: true })
      if (i.showBadge) {
        const diff = last.close - current.strike
        const up = diff > 0 || (diff === 0 && current.tieGoesUp)
        const digits = current.strike >= 100 ? 2 : current.strike >= 1 ? 4 : 6
        const mid = current.yesBid !== null && current.yesAsk !== null ? (current.yesBid + current.yesAsk) / 2 : (current.yesAsk ?? current.yesBid)
        const odds = i.showOdds && mid !== null ? ` · Yes ${Math.round(mid * 100)}¢` : ''
        drawings.push({
          type: 'text',
          x: 'end',
          y: current.strike,
          text: `${up ? '▲ UP' : '▼ DOWN'} ${diff >= 0 ? '+' : '−'}${formatPrice(Math.abs(diff), digits)} · ${formatCountdown(current.end - now)}${odds}`,
          color: '#ffffff',
          bg: up ? UP : DOWN,
          size: 11,
          align: 'left',
          dx: 14,
          dy: up ? 14 : -14,
        })
      }
    } else if (last && i.showBadge && status !== 'loading') {
      // No live strike: say why, at the last price, rather than draw a guessed one.
      drawings.push({ type: 'text', x: 'end', y: last.close, text: message, color: '#dbdbdb', bg: '#2b2b2b', size: 10, align: 'left', dx: 14, dy: -16 })
    }

    return {
      values: {
        strike,
        upper: strike.map((s) => s + buffer),
        lower: strike.map((s) => s - buffer),
      },
      drawings,
    }
  },
}
