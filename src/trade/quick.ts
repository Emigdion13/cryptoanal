/**
 * The quick-trade circles' math (btcAnalyzerV2's phone-quick): what a $ circle buys, what each
 * target sells at and wins after fees, the keypad, and Sell now's floor.
 */
import {
  NOW_SLIPPAGE_MILLS,
  TAKER_FEE,
  contractsFor,
  netProfitDollars,
  priceTicks,
  snapDown,
  targetForPercent,
  type TradeMarket,
  type TradeOutcome,
  type TradeTarget,
} from './kalshiTrade'

/** The buy circles' amounts, in dollars. */
export const QUICK_DOLLARS = [5, 15, 30] as const
/** The target circles, % over the average price paid: each sells the whole holding. */
export const QUICK_TARGETS = [10, 20, 30, 50, 75] as const

/**
 * A quick buy of `dollars` of `outcome` right now: immediate or cancel, up to 2¢ over the ask, fee
 * included in the amount. Null when nobody is selling or the amount does not buy one contract.
 */
export function quickBuy(market: TradeMarket, outcome: TradeOutcome, dollars: number): { mills: number; count: number } | null {
  const ask = outcome === 'up' ? market.upAsk : market.downAsk
  if (ask === null) return null
  const ticks = priceTicks(market.bands)
  const cap = Math.max(ask, snapDown(Math.min(999, ask + NOW_SLIPPAGE_MILLS), ticks) ?? ask)
  const count = contractsFor(dollars, cap, TAKER_FEE * market.feeMultiplier)
  return count > 0 ? { mills: cap, count } : null
}

export interface QuickTarget {
  pct: number
  /** The target price on Kalshi's grid, or null past 99.9¢. */
  mills: number | null
  /** What it sells at, at least: the target, or the bid when the bid is already there. */
  atMills: number | null
  /** 'over': past the top of the book; 'bid': the bid is already there, so it sells at the bid now. */
  state: 'ok' | 'over' | 'bid'
  /** What selling all at `atMills` makes at least, after fees; null when there is no target. */
  netDollars: number | null
}

/** One target, `pct`% over a holding bought at `entry` (its average). */
export function quickTarget(entry: number, bid: number | null, contracts: number, market: TradeMarket, pct: number): QuickTarget {
  const mills = targetForPercent(entry, pct, priceTicks(market.bands))
  if (mills === null) return { pct, mills, atMills: null, state: 'over', netDollars: null }
  // Watched, not resting: once buyers pay it, everything sells to the best of them as a taker.
  const now = bid !== null && bid >= mills
  const at = now ? bid : mills
  return {
    pct,
    mills,
    atMills: at,
    state: now ? 'bid' : 'ok',
    netDollars: netProfitDollars(contracts, entry, at, market.feeMultiplier, market.makerFees, true),
  }
}

/** The five targets for a holding bought at `entry` (its average), as the circles show them. */
export function quickTargets(entry: number, bid: number | null, contracts: number, market: TradeMarket): QuickTarget[] {
  return QUICK_TARGETS.map((pct) => quickTarget(entry, bid, contracts, market, pct))
}

/** One key on the keypad: digits, one point, two decimals, five whole digits at most. */
export function keypadPress(value: string, key: string): string {
  if (key === 'back') return value.slice(0, -1)
  if (key === '.') return value.includes('.') ? value : `${value || '0'}.`
  if (!/^\d$/.test(key)) return value
  const next = value === '0' ? key : `${value}${key}`
  const [whole, decimals = ''] = next.split('.')
  return whole.length > 5 || decimals.length > 2 ? value : next
}

/** What the keypad holds as a number: null while empty or zero. */
export function keypadNumber(value: string): number | null {
  const n = Number(value)
  return value !== '' && Number.isFinite(n) && n > 0 ? n : null
}

/** Every buy queues a sell that makes the most the buy can make less this much (%). */
export const QUICK_AUTO_SELL_UNDER_PCT = 5

const working = (t: TradeTarget) => t.state === 'watching' || t.state === 'selling'

/** The target working on this round, if any (the auto-sell is not one). */
export function quickPlan(targets: readonly TradeTarget[], ticker: string): TradeTarget | null {
  return targets.find((t) => t.ticker === ticker && t.kind !== 'auto-sell' && working(t)) ?? null
}

/** The auto-sell on this round, if any. */
export function quickAutoSell(targets: readonly TradeTarget[], ticker: string): TradeTarget | null {
  return targets.find((t) => t.ticker === ticker && t.kind === 'auto-sell' && working(t)) ?? null
}

/** The lowest price Sell now accepts: 2¢ under the bid, on Kalshi's grid. */
export function quickSellFloor(bid: number | null, market: TradeMarket): number | null {
  if (bid === null) return null
  const ticks = priceTicks(market.bands)
  return snapDown(Math.max(1, bid - NOW_SLIPPAGE_MILLS), ticks) ?? ticks[0]
}
