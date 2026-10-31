/**
 * Paper fills against Kalshi's real book: what an order WOULD have done, level by level, with
 * Kalshi's taker fee, without sending anything. The book carries only bids: buying Up takes the NO
 * bids (an Up ask at 1 − the NO bid), selling Up hits the YES bids; Down the other way round.
 *
 * A paper order does not use the liquidity up, so two paper orders in a row both see the whole
 * book; at the sizes practiced here that changes nothing.
 */
import { feeDollars, type TradeOutcome } from '../../src/trade/kalshiTrade'

/** One price level for the side being traded: mills of that outcome, contracts there. */
export interface Level {
  mills: number
  size: number
}

export interface PaperBook {
  /** YES and NO bids as [mills, contracts]. */
  yes: readonly (readonly [number, number])[]
  no: readonly (readonly [number, number])[]
}

export interface Fill {
  count: number
  /** Average price of the outcome, mills. */
  avgMills: number
  /** Dollars: contracts × price, and the fee on top (buys) or taken off (sells). */
  value: number
  fee: number
  levels: { mills: number; count: number }[]
}

/** The asks to buy `outcome` at, cheapest first. */
export function asksFor(book: PaperBook, outcome: TradeOutcome): Level[] {
  const other = outcome === 'up' ? book.no : book.yes
  return other.map(([mills, size]) => ({ mills: 1000 - mills, size })).sort((a, b) => a.mills - b.mills)
}

/** The bids to sell `outcome` to, best first. */
export function bidsFor(book: PaperBook, outcome: TradeOutcome): Level[] {
  const own = outcome === 'up' ? book.yes : book.no
  return own.map(([mills, size]) => ({ mills, size })).sort((a, b) => b.mills - a.mills)
}

const money = (value: number) => Math.round(value * 10_000) / 10_000

function summary(levels: { mills: number; count: number }[], fee: number): Fill {
  const count = levels.reduce((n, l) => n + l.count, 0)
  const value = levels.reduce((v, l) => v + (l.count * l.mills) / 1000, 0)
  return { count, avgMills: count ? Math.round(((value * 1000) / count) * 10) / 10 : 0, value: money(value), fee: money(fee), levels }
}

/**
 * Whole contracts `dollars` buys, cheapest asks first, never above `maxMills`, the fee included in
 * what it spends.
 */
export function fillBuy(asks: readonly Level[], dollars: number, maxMills: number, coefficient: number): Fill {
  const taken: { mills: number; count: number }[] = []
  let left = dollars
  let fee = 0
  for (const level of asks) {
    if (level.mills > maxMills || level.mills <= 0 || level.mills >= 1000) break
    const per = level.mills / 1000 + (coefficient * level.mills * (1000 - level.mills)) / 1e6
    let count = Math.min(Math.floor(level.size), Math.floor(left / per))
    while (count > 0 && (count * level.mills) / 1000 + feeDollars(count, level.mills, coefficient) > left + 1e-9) count -= 1
    if (count <= 0) break
    const levelFee = feeDollars(count, level.mills, coefficient)
    left -= (count * level.mills) / 1000 + levelFee
    fee += levelFee
    taken.push({ mills: level.mills, count })
    if (count < Math.floor(level.size)) break
  }
  return summary(taken, fee)
}

/** Up to `count` contracts sold to the best bids, never under `minMills`. */
export function fillSell(bids: readonly Level[], count: number, minMills: number, coefficient: number): Fill {
  const taken: { mills: number; count: number }[] = []
  let left = count
  let fee = 0
  for (const level of bids) {
    if (left <= 1e-9 || level.mills < minMills) break
    const n = Math.min(level.size, left)
    fee += feeDollars(n, level.mills, coefficient)
    taken.push({ mills: level.mills, count: n })
    left -= n
  }
  return summary(taken, fee)
}
