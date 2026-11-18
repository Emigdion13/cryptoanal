/**
 * The Polymarket page's math and shapes (polymarket.html): REAL orders on Polymarket US's 5-minute
 * BTC Up/Down rounds (server/polyUs.ts sends them).
 *
 * Polymarket US has one instrument a round, its Yes side (= Up). Every order's price is the Yes
 * price: buying Down is selling Yes at 1 − the Down price, selling Down is buying Yes back.
 *
 * - A buy is a limit order, immediate-or-cancel, at most 2¢ over the best price.
 * - Taker fees: Θ × contracts × p × (1 − p), Θ by the account's 30-day volume (0.095 at most).
 * - Every buy leaves a sale on the book at the most it can make less 10% (the auto-sell): settling
 *   at $1 makes (1 − avg) a contract, so it sells at avg + 90% of that.
 */

export type PolySide = 'up' | 'down'
export const isPolySide = (v: unknown): v is PolySide => v === 'up' || v === 'down'

/** The buy buttons' amounts, in dollars. */
export const POLY_DOLLARS = [5, 15, 30] as const
/** Every buy leaves a sale at the most it can make less this much (%), unless changed. */
export const POLY_AUTO_SELL_UNDER_PCT = 10
/** A buy or Sell now goes this far past the best price at most, dollars. */
export const POLY_SLIPPAGE = 0.02
/** The highest taker fee coefficient (tier 1, under $10k a month); the real one is never more. */
export const POLY_TAKER_THETA = 0.095

export interface PolyLevel {
  price: number
  size: number
}

/** One side of a book, best first: asks lowest first, bids highest first. */
export interface PolyBook {
  bids: PolyLevel[]
  asks: PolyLevel[]
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

/** The taker fee on `contracts` at `price` (either side: p(1 − p) is the same), dollars. */
export function polyFee(contracts: number, price: number, theta = POLY_TAKER_THETA): number {
  if (!(theta > 0) || price <= 0 || price >= 1) return 0
  return Math.round(contracts * theta * price * (1 - price) * 100) / 100
}

const amount = (v: unknown): number => Number((v as { value?: unknown } | null | undefined)?.value ?? v)

/** Polymarket US's `/book` (Yes prices) → the Up and Down books, best first, in each side's own price. */
export function parseUsBook(payload: unknown): Record<PolySide, PolyBook> {
  const data = ((payload as { marketData?: unknown } | null)?.marketData ?? {}) as { bids?: unknown; offers?: unknown }
  const levels = (rows: unknown): PolyLevel[] =>
    Array.isArray(rows)
      ? rows
          .map((r) => ({ price: amount((r as { px?: unknown })?.px), size: Number((r as { qty?: unknown })?.qty) }))
          .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0 && l.price < 1 && l.size > 0)
      : []
  const bids = levels(data.bids).sort((a, b) => b.price - a.price)
  const asks = levels(data.offers).sort((a, b) => a.price - b.price)
  const flip = (l: PolyLevel): PolyLevel => ({ price: round6(1 - l.price), size: l.size })
  return {
    up: { bids, asks },
    // Down is bought from Yes buyers and sold to Yes sellers.
    down: { bids: asks.map(flip), asks: bids.map(flip) },
  }
}

export interface PolyFill {
  contracts: number
  /** What the contracts cost or brought, before fees, dollars. */
  value: number
  fee: number
  avg: number
}

/** The whole contracts `dollars` (fees included) buys from `asks`, never over `cap`. */
export function planBuy(asks: readonly PolyLevel[], dollars: number, cap: number, theta = POLY_TAKER_THETA): PolyFill | null {
  let left = dollars
  let contracts = 0
  let value = 0
  for (const level of asks) {
    if (level.price > cap + 1e-9 || left <= 0) break
    const each = level.price + theta * level.price * (1 - level.price)
    const take = Math.min(Math.floor(level.size), Math.floor(left / each + 1e-9))
    if (take <= 0) break
    contracts += take
    value += take * level.price
    left -= take * each
  }
  if (contracts <= 0) return null
  return { contracts, value: round6(value), fee: polyFee(contracts, value / contracts, theta), avg: round6(value / contracts) }
}

/**
 * The auto-sell's price for a holding bought at `avg` (its own side's price): the most it can make
 * (settling at $1) less `underPct`%, up to the next tick, at most one tick under $1. Null when no
 * price on the grid is over the entry.
 */
export function autoSellPrice(avg: number, underPct: number, tick = 0.01): number | null {
  const wanted = avg + (1 - avg) * (1 - underPct / 100)
  const top = round6(1 - tick)
  const price = Math.min(top, round6(Math.ceil(wanted / tick - 1e-9) * tick))
  return price > avg ? price : null
}

/** A price on the tick grid, as the API wants it ("0.55"). */
export function priceText(price: number, tick = 0.01): string {
  const decimals = Math.max(0, Math.round(-Math.log10(tick)))
  return (Math.round(price / tick) * tick).toFixed(decimals)
}

/** What Polymarket US calls buying or selling a side. */
export function intentOf(side: PolySide, action: 'buy' | 'sell'): string {
  if (side === 'up') return action === 'buy' ? 'ORDER_INTENT_BUY_LONG' : 'ORDER_INTENT_SELL_LONG'
  return action === 'buy' ? 'ORDER_INTENT_BUY_SHORT' : 'ORDER_INTENT_SELL_SHORT'
}

/** The order's Yes price for a price on `side`. */
export const yesPrice = (side: PolySide, price: number) => (side === 'up' ? price : round6(1 - price))

/** The round's window from its slug's time: `cpc-btc-updown-5m-2026-11-18-2140z` opens at 21:40 UTC. */
export function usRoundSlug(startSec: number): string {
  const d = new Date(startSec * 1000)
  const two = (n: number) => String(n).padStart(2, '0')
  return `cpc-btc-updown-5m-${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}-${two(d.getUTCHours())}${two(d.getUTCMinutes())}z`
}

/** One holding in a round, as the page shows it. */
export interface PolyPosition {
  slug: string
  side: PolySide
  contracts: number
  /** What the contracts still held cost, fees included; null when bought outside this app. */
  cost: number | null
  /** Their average price on their own side, before fees; null when not known. */
  avg: number | null
  start: number
  end: number
  /** The sale left on the book, its price on the holding's side; null: none. */
  autoSell: { price: number; contracts: number } | null
}

export type PolyOutcome = 'won' | 'lost' | 'sold' | 'auto-sold'

/** One finished play: contracts sold or settled. */
export interface PolyPlay {
  slug: string
  side: PolySide
  contracts: number
  cost: number
  /** What came back, fees taken off. */
  proceeds: number
  pnl: number
  outcome: PolyOutcome
  start: number
  end: number
  /** Unix seconds. */
  closedAt: number
}

export interface PolyTotals {
  plays: number
  won: number
  lost: number
  /** Plays that made money, sold or settled. */
  wins: number
  pnl: number
  staked: number
  best: number | null
  worst: number | null
}

export function polyTotals(plays: readonly PolyPlay[]): PolyTotals {
  let pnl = 0
  let staked = 0
  let wins = 0
  let won = 0
  let lost = 0
  let best: number | null = null
  let worst: number | null = null
  for (const p of plays) {
    pnl += p.pnl
    staked += p.cost
    if (p.pnl > 0) wins += 1
    if (p.outcome === 'won') won += 1
    if (p.outcome === 'lost') lost += 1
    best = best === null ? p.pnl : Math.max(best, p.pnl)
    worst = worst === null ? p.pnl : Math.min(worst, p.pnl)
  }
  return { plays: plays.length, won, lost, wins, pnl: round6(pnl), staked: round6(staked), best, worst }
}

/** `GET /api/poly/state`: the running round, its prices, and the account. */
export interface PolyState {
  asOf: number
  round: {
    slug: string
    start: number
    end: number
    /** The price to beat; null until Polymarket US publishes it. */
    strike: number | null
    up: { bid: number | null; ask: number | null }
    down: { bid: number | null; ask: number | null }
    tick: number
    open: boolean
  } | null
  /** BTC on Coinbase (the round settles on CF Benchmarks' BRTI, a few dollars apart). */
  btc: number | null
  /** What can buy now; null without a key. */
  buyingPower: number | null
  positions: PolyPosition[]
  /** Held at the close: waiting for the result. */
  settling: PolyPosition[]
  autoSellPct: number
  /** A key is set and works. */
  keyed: boolean
  /** Real-money orders are switched on, on the computer. */
  live: boolean
  problem: string
}

/** `GET /api/poly/stats`. */
export interface PolyStats {
  from: number
  plays: PolyPlay[]
  totals: PolyTotals
}

export interface PolyResult {
  ok: boolean
  message: string
}

/** `GET /api/poly/settings` (this computer only). The secret never leaves the server. */
export interface PolyKeysView {
  file: string
  keyId: string
  path: string
  error: string | null
  liveTrading: boolean
}
