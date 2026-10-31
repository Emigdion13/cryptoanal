/**
 * The phone's History screen, btcAnalyzerV2's: what each round (market) made or lost after fees,
 * from Kalshi's own fills and settlements. P&L from trades only: deposits and withdrawals are not
 * growth, so they are left out.
 *
 * Kalshi keeps one YES book and nets positions: owning a YES and a NO in the same market is worth
 * $1 at once (it pays out either way). So a market's cash, after everything, is
 *
 *   −(what every fill paid, YES at its YES price, NO at its NO price)
 *   + $1 for every YES/NO pair that netted out
 *   + the settlement's payout for what was still held
 *   − the fills' fees
 *
 * A sell is a fill on the other side (selling Up = buying NO at 1 − price), so a round trip of Up
 * bought at 52¢ and sold at 61¢ pays 0.52 + 0.39 and nets $1: +$0.09 before fees.
 */
import { formatCents, type TradeEnv } from './kalshiTrade'

/** One fill, as `GET /portfolio/fills` gives it (only the fields used). */
export interface KalshiFill {
  ticker: string
  outcome: 'yes' | 'no'
  count: number
  /** The price paid for that outcome, dollars (YES price for yes, NO price for no). */
  price: number
  fee: number
  /** Unix seconds. */
  time: number
}

/** One settlement, as `GET /portfolio/settlements` gives it (only the fields used). */
export interface KalshiSettlement {
  ticker: string
  result: string
  /** Payout for what was held at settlement, dollars. */
  revenue: number
  /** Unix seconds. */
  time: number
}

export type HistoryOutcome = 'won' | 'lost' | 'sold' | 'open'

/** One round (market) in the history, newest first in a response. */
export interface HistoryRound {
  ticker: string
  /** When it ended: the settlement, or the last fill while it has none. Unix seconds. */
  time: number
  /** "Up"/"Down" for the 15-minute crypto rounds, "Yes"/"No" for any other market. */
  side: string
  /** Contracts bought on the side first taken, and their average price, dollars. */
  bought: number
  boughtAvg: number
  /** Contracts sold back before the end, and their average price on the same side, dollars. */
  sold: number
  soldAvg: number | null
  /** Contracts still held when it settled (or now, while open). */
  held: number
  outcome: HistoryOutcome
  /** After fees, dollars; null while the round is still open (not settled, still held). */
  pnl: number | null
  fees: number
}

export interface HistoryTotals {
  pnl: number
  fees: number
  rounds: number
  won: number
  lost: number
}

/** `GET /api/trade/history`. */
export interface TradeHistory {
  env: TradeEnv
  /** Unix seconds the history starts at (0: everything Kalshi still has). */
  from: number
  rounds: HistoryRound[]
  totals: HistoryTotals
  /** More fills than the server reads at once: the oldest are left out. */
  truncated: boolean
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000

/** The 15-minute crypto rounds read as Up/Down; anything else as Yes/No. */
const sideName = (ticker: string, outcome: 'yes' | 'no') =>
  /^KX[A-Z]+15M-/.test(ticker) ? (outcome === 'yes' ? 'Up' : 'Down') : outcome === 'yes' ? 'Yes' : 'No'

/**
 * Fills and settlements → one row per market that has fills, newest first. A settlement without
 * any of its fills is left out (its cost is unknown); the server reads an hour before the period so
 * a 15-minute round that straddles its start still has all of them.
 */
export function historyRounds(fills: readonly KalshiFill[], settlements: readonly KalshiSettlement[]): HistoryRound[] {
  const byTicker = new Map<string, KalshiFill[]>()
  for (const fill of fills) {
    const list = byTicker.get(fill.ticker) ?? []
    list.push(fill)
    byTicker.set(fill.ticker, list)
  }
  const settled = new Map(settlements.map((s) => [s.ticker, s]))
  const rounds: HistoryRound[] = []
  for (const [ticker, list] of byTicker) {
    list.sort((a, b) => a.time - b.time)
    const first = list[0].outcome
    let yes = 0
    let no = 0
    let paid = 0
    let fees = 0
    let bought = 0
    let boughtCost = 0
    let sold = 0
    let soldValue = 0
    for (const fill of list) {
      paid += fill.price * fill.count
      fees += fill.fee
      if (fill.outcome === 'yes') yes += fill.count
      else no += fill.count
      if (fill.outcome === first) {
        bought += fill.count
        boughtCost += fill.price * fill.count
      } else {
        // A fill on the other side closes the first one: worth 1 − its price on the first side.
        sold += fill.count
        soldValue += (1 - fill.price) * fill.count
      }
    }
    const held = round4(Math.abs(yes - no))
    const settlement = settled.get(ticker) ?? null
    const lastFill = list[list.length - 1].time
    const open = held > 0 && !settlement
    const cash = -paid + Math.min(yes, no) + (settlement?.revenue ?? 0) - fees
    rounds.push({
      ticker,
      time: settlement ? Math.max(settlement.time, lastFill) : lastFill,
      side: sideName(ticker, first),
      bought: round4(bought),
      boughtAvg: bought > 0 ? round4(boughtCost / bought) : 0,
      sold: round4(sold),
      soldAvg: sold > 0 ? round4(soldValue / sold) : null,
      held,
      outcome: open ? 'open' : held > 0 && settlement ? (settlement.revenue > 0 ? 'won' : 'lost') : 'sold',
      pnl: open ? null : round4(cash),
      fees: round4(fees),
    })
  }
  return rounds.sort((a, b) => b.time - a.time)
}

export function historyTotals(rounds: readonly HistoryRound[]): HistoryTotals {
  let pnl = 0
  let fees = 0
  let won = 0
  let lost = 0
  let count = 0
  for (const r of rounds) {
    if (r.pnl === null) continue
    count += 1
    pnl += r.pnl
    fees += r.fees
    if (r.pnl > 0) won += 1
    else if (r.pnl < 0) lost += 1
  }
  return { pnl: round4(pnl), fees: round4(fees), rounds: count, won, lost }
}

/** The running P&L after each finished round, oldest first: the History screen's line. */
export function historyCurve(rounds: readonly HistoryRound[]): { time: number; pnl: number }[] {
  let total = 0
  return [...rounds]
    .filter((r) => r.pnl !== null)
    .sort((a, b) => a.time - b.time)
    .map((r) => {
      total += r.pnl!
      return { time: r.time, pnl: round4(total) }
    })
}

const numberOf = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : null
}
const secondsOf = (value: unknown, fallback: unknown): number | null => {
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  return numberOf(fallback)
}

/** `GET /portfolio/fills` rows → fills; rows it cannot read are skipped. */
export function parseFills(rows: unknown): KalshiFill[] {
  if (!Array.isArray(rows)) return []
  const out: KalshiFill[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const ticker = typeof r.ticker === 'string' ? r.ticker : r.market_ticker
    const outcome =
      r.outcome_side === 'yes' || r.outcome_side === 'no' ? r.outcome_side : r.book_side === 'bid' ? 'yes' : r.book_side === 'ask' ? 'no' : null
    const count = numberOf(r.count_fp ?? r.count)
    const price = numberOf(outcome === 'yes' ? r.yes_price_dollars : r.no_price_dollars)
    const time = secondsOf(r.created_time, r.ts)
    if (typeof ticker !== 'string' || !outcome || !count || price === null || time === null) continue
    out.push({ ticker, outcome, count, price, fee: numberOf(r.fee_cost) ?? 0, time })
  }
  return out
}

/** `GET /portfolio/settlements` rows → settlements (revenue arrives in cents). */
export function parseSettlements(rows: unknown): KalshiSettlement[] {
  if (!Array.isArray(rows)) return []
  const out: KalshiSettlement[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const time = secondsOf(r.settled_time, null)
    const cents = numberOf(r.revenue)
    if (typeof r.ticker !== 'string' || time === null || cents === null) continue
    out.push({ ticker: r.ticker, result: typeof r.market_result === 'string' ? r.market_result : '', revenue: cents / 100, time })
  }
  return out
}

// ── How the phone shows it ──────────────────────────────────────────────────────────────────

export type HistoryPeriod = 'today' | '7d' | '30d' | 'all'
export const HISTORY_PERIODS: { key: HistoryPeriod; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
  { key: 'all', label: 'All' },
]

/** Where a period starts, unix seconds: today from local midnight, All from the beginning (0). */
export function periodStart(period: HistoryPeriod, now = new Date()): number {
  if (period === 'all') return 0
  if (period === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return Math.floor(midnight.getTime() / 1000)
  }
  return Math.floor(now.getTime() / 1000) - (period === '7d' ? 7 : 30) * 86_400
}

export const historyMoney = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`
const cents = (price: number | null) => formatCents(price === null ? null : price * 1000)
const count = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

/** "4:15 PM", or "Oct 19 · 4:15 PM" for another day. */
export function historyWhen(seconds: number, now = new Date()): string {
  const date = new Date(seconds * 1000)
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${time}`
}

/** "Up 10 @ 52¢ → 61¢", "Down 8 @ 47¢ · won", "Up 10 @ 50¢ · 4 sold at 60¢ · won". */
export function historyRoundText(r: HistoryRound): string {
  const head = `${r.side} ${count(r.bought)} @ ${cents(r.boughtAvg)}`
  if (r.outcome === 'sold') return `${head} → ${cents(r.soldAvg)}`
  const sold = r.sold > 0 ? ` · ${count(r.sold)} sold at ${cents(r.soldAvg)}` : ''
  return `${head}${sold} · ${r.outcome}`
}
