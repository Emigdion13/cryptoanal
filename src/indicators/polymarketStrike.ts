/**
 * Polymarket Strike: the "Price to Beat" of Polymarket's 5-minute up/down market on Bitcoin. The live
 * window's strike as a line across the chart to the price axis, and a badge: UP or DOWN, by how
 * much, time left in the window, the Up price and the strike as Polymarket shows it. Past windows'
 * strikes (a step line) and ± target lines are optional.
 *
 * The strike is Polymarket's own number (a 60-second Chainlink average), never an estimate from
 * Coinbase candles: with no answer from Polymarket the chart says so instead. That average runs some
 * dollars off Coinbase's price, so by default the line moves by the gap measured on the recent
 * strikes: Coinbase's price on the line is then even odds.
 */
import { isChainlink } from '../data/chainlink'
import { POLYMARKET_WINDOW, polymarketState } from '../data/polymarket'
import { formatCountdown, formatPrice } from '../format'
import type { Drawing, IndicatorDef } from './types'

const BLUE = '#4c8dff'
const UP = '#2bb99b'
const DOWN = '#ed6773'

export const polymarketStrike: IndicatorDef = {
  type: 'polymarketStrike',
  name: 'Polymarket Strike (5m up/down)',
  short: 'Polymarket Strike',
  category: 'Price Action',
  overlay: true,
  format: 'price',
  external: true,
  inputs: [
    { key: 'showHistory', label: 'Show past windows', type: 'bool', default: false },
    { key: 'lineUp', label: 'Line up with Coinbase (move by the Chainlink gap)', type: 'bool', default: true },
    { key: 'buffer', label: 'Target buffer ($)', type: 'float', default: 50, min: 0, max: 100000, step: 5, hideInTitle: true },
    { key: 'showBadge', label: 'Show UP/DOWN badge', type: 'bool', default: true },
    { key: 'showOdds', label: 'Show Polymarket Up price', type: 'bool', default: true },
  ],
  plots: [
    { key: 'strike', title: 'Strike', kind: 'step', color: BLUE, width: 2 },
    { key: 'upper', title: 'Upper target', kind: 'line', color: UP, hidden: true },
    { key: 'lower', title: 'Lower target', kind: 'line', color: DOWN, hidden: true },
  ],
  compute: (bars, i, st, ctx) => {
    const { reply, status, message } = polymarketState(ctx.product)
    const windows = new Map<number, number>()
    // Past windows only on request: by default the chart shows the strike that counts now.
    if (i.showHistory) for (const w of reply?.history ?? []) windows.set(w.start, w.strike)
    // In Coinbase's terms: the strike less how far Chainlink runs over Coinbase.
    // On a Chainlink chart the strike is already in the chart's own prices: nothing to move.
    const gap = i.lineUp !== false && !isChainlink(ctx.product) ? (reply?.basis?.dollars ?? 0) : 0
    const live = reply?.current ?? null
    const current = live ? { ...live, strike: live.strike - gap } : null
    for (const [start, strike] of windows) windows.set(start, strike - gap)
    if (current) windows.set(current.start, current.strike)

    // Each bar takes the strike of the window running at its last moment (the newest bar: now).
    const now = Date.now() / 1000
    const strike = bars.map((b) => {
      const t = Math.min(b.time + ctx.interval.seconds - 1, now)
      return windows.get(Math.floor(t / POLYMARKET_WINDOW) * POLYMARKET_WINDOW) ?? NaN
    })
    const buffer = Number(i.buffer) || 0
    const drawings: Drawing[] = []
    const last = bars[bars.length - 1]

    if (last && live && current && now >= current.start && now < current.end) {
      const color = st.strike?.color ?? BLUE
      // The live strike runs on to the axis, like TradingView's price line: from its window's start
      // under the past windows' steps, across the whole chart without them.
      const from = i.showHistory ? ctx.timeToIndex(current.start) : 0
      drawings.push({ type: 'line', x1: from, y1: current.strike, x2: 'end', y2: current.strike, color, width: 1, dash: [4, 4], extendRight: true })
      if (i.showBadge) {
        const diff = last.close - current.strike
        // A dead-even close resolves Up.
        const up = diff >= 0
        const odds = i.showOdds && live.upPrice !== null ? ` · Up ${Math.round(live.upPrice * 100)}¢` : ''
        drawings.push({
          type: 'text',
          x: 'end',
          y: current.strike,
          text: `${up ? '▲ UP' : '▼ DOWN'} ${diff >= 0 ? '+' : '−'}${formatPrice(Math.abs(diff), 2)} · ${formatCountdown(current.end - now)}${odds} · beat ${formatPrice(live.strike, 2)}`,
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
