/**
 * Backtests: one rule played on every past round, with Kalshi's fees, then counted up. A rule
 * enters at most once a round, at the first minute its `enter` holds, buying at that minute's ask;
 * it leaves at its target, stop or `exit`, else holds to the result.
 *
 * Past fills take the best price of the minute in full (Kalshi kept no depth), as a small order
 * would get. Hence the stake is capped: what is learned at $10 is not what $1,000 would do.
 */
import { TAKER_FEE, type TradeOutcome } from '../../src/trade/kalshiTrade'
import { Moment, FNS, VARS } from './moment'
import { fillBuy, fillSell } from './paper'
import type { Scene } from './past'
import { compile, evaluate, RuleError, truthy } from './rules'

export interface RuleSpec {
  name: string
  /** up, down, favorite, underdog, or an expression giving 'up' or 'down'. */
  side: string
  /** When to buy: the first minute this holds. */
  enter: string
  /** The minutes into the round it may buy in, 1 to 14 (default 1 to 13). */
  minutes?: [number, number]
  /** Dollars per trade, fees included (default 10, at most 100). */
  stake?: number
  /** Skip the trade when the side's ask is above / below these, cents. */
  maxCents?: number
  minCents?: number
  /** Sell when this holds (bid, paid and gain are known in it). */
  exit?: string
  /** Sell everything once buyers pay this, cents (a resting order: the minute's best bid reaching it). */
  target?: number
  /** Sell at the bid once it falls to this, cents. */
  stop?: number
}

export interface BacktestTrade {
  ticker: string
  product: string
  close: string
  minute: number
  side: TradeOutcome
  contracts: number
  paidCents: number
  cost: number
  fees: number
  exit: 'result' | 'target' | 'stop' | 'exit'
  exitMinute: number | null
  exitCents: number | null
  result: 'up' | 'down' | null
  won: boolean
  pnl: number
}

const money = (value: number) => Math.round(value * 10_000) / 10_000
const SIDES = new Set(['up', 'down', 'favorite', 'underdog'])

/** Reads a rule once: every expression checked, so a typo fails before any round is played. */
export function compileRule(spec: RuleSpec) {
  const known = { vars: [...VARS], fns: [...FNS] }
  const exitKnown = { vars: [...VARS, 'bid', 'paid', 'gain'], fns: [...FNS] }
  if (typeof spec.enter !== 'string' || !spec.enter.trim()) throw new RuleError('A rule needs "enter": when to buy.')
  const side = typeof spec.side === 'string' ? spec.side.trim() : ''
  if (!side) throw new RuleError('A rule needs "side": up, down, favorite, underdog or an expression.')
  const minutes = spec.minutes ?? [1, 13]
  if (!Array.isArray(minutes) || minutes.length !== 2 || !(minutes[0] >= 1 && minutes[1] <= 14 && minutes[0] <= minutes[1]))
    throw new RuleError('"minutes" is [first, last] between 1 and 14.')
  const stake = spec.stake ?? 10
  if (!(stake >= 1 && stake <= 100)) throw new RuleError('"stake" is $1 to $100: past fills only know the best price, not how much was there.')
  return {
    spec,
    enter: compile(spec.enter, known),
    side: SIDES.has(side.toLowerCase()) ? side.toLowerCase() : compile(side, known),
    exit: spec.exit ? compile(spec.exit, exitKnown) : null,
    minutes,
    stake,
  }
}

type Compiled = ReturnType<typeof compileRule>

/** Mills of a side's ask / bid from Up's book. */
const askOf = (m: Moment, side: TradeOutcome) => (side === 'up' ? m.kalshi.upAsk : m.kalshi.upBid === null ? null : 1000 - m.kalshi.upBid)
const bidOf = (m: Moment, side: TradeOutcome) => (side === 'up' ? m.kalshi.upBid : m.kalshi.upAsk === null ? null : 1000 - m.kalshi.upAsk)
/** The best bid seen during the minute: what a resting target could have sold to. */
const bidHighOf = (m: Moment, side: TradeOutcome) => (side === 'up' ? m.kalshi.upBidHigh : m.kalshi.upAskLow === null ? null : 1000 - m.kalshi.upAskLow)

function sideAt(rule: Compiled, m: Moment): TradeOutcome | null {
  if (typeof rule.side === 'string') {
    if (rule.side === 'up' || rule.side === 'down') return rule.side
    const fav = m.favorite()
    return rule.side === 'favorite' ? fav : fav === 'up' ? 'down' : 'up'
  }
  const v = evaluate(rule.side, m.scope())
  return v === 'up' || v === 'down' ? v : null
}

/** One round played by a rule: its trade, or null when it did not enter. */
export function playRound(rule: Compiled, scene: Scene, coefficient = TAKER_FEE): BacktestTrade | null {
  const { round } = scene
  if (!round.result) return null
  for (let k = rule.minutes[0]; k <= rule.minutes[1]; k++) {
    const m = new Moment(scene, k)
    if (!truthy(evaluate(rule.enter, m.scope()))) continue
    const side = sideAt(rule, m)
    if (!side) continue
    const ask = askOf(m, side)
    if (ask === null || ask >= 1000) continue
    if (rule.spec.maxCents !== undefined && ask > rule.spec.maxCents * 10) continue
    if (rule.spec.minCents !== undefined && ask < rule.spec.minCents * 10) continue
    const buy = fillBuy([{ mills: ask, size: 1e9 }], rule.stake, ask, coefficient)
    if (!buy.count) continue
    const cost = money(buy.value + buy.fee)
    const paid = ask / 10
    // Leaving early: target first (it rests on the book), then the stop, then the exit rule.
    for (let j = k + 1; j <= 14; j++) {
      const later = new Moment(scene, j)
      const bid = bidOf(later, side)
      let how: BacktestTrade['exit'] | null = null
      let at: number | null = null
      const high = bidHighOf(later, side)
      if (rule.spec.target !== undefined && high !== null && high >= rule.spec.target * 10) {
        how = 'target'
        at = rule.spec.target * 10
      } else if (bid !== null && rule.spec.stop !== undefined && bid <= rule.spec.stop * 10) {
        how = 'stop'
        at = bid
      } else if (bid !== null && rule.exit && truthy(evaluate(rule.exit, later.scope({ bid: bid / 10, paid, gain: bid / 10 - paid })))) {
        how = 'exit'
        at = bid
      }
      if (how && at !== null) {
        const sell = fillSell([{ mills: at, size: 1e9 }], buy.count, at, coefficient)
        const pnl = money(sell.value - sell.fee - cost)
        return { ticker: round.ticker, product: round.product, close: new Date(round.close * 1000).toISOString(), minute: k, side, contracts: buy.count, paidCents: paid, cost, fees: money(buy.fee + sell.fee), exit: how, exitMinute: j, exitCents: at / 10, result: round.result, won: pnl > 0, pnl }
      }
    }
    const won = round.result === side
    const pnl = money((won ? buy.count : 0) - cost)
    return { ticker: round.ticker, product: round.product, close: new Date(round.close * 1000).toISOString(), minute: k, side, contracts: buy.count, paidCents: paid, cost, fees: buy.fee, exit: 'result', exitMinute: null, exitCents: null, result: round.result, won, pnl }
  }
  return null
}

function group(trades: readonly BacktestTrade[]) {
  const pnl = money(trades.reduce((s, t) => s + t.pnl, 0))
  const staked = trades.reduce((s, t) => s + t.cost, 0)
  const wins = trades.filter((t) => t.won).length
  const held = trades.filter((t) => t.exit === 'result')
  return {
    trades: trades.length,
    winRate: trades.length ? Math.round((wins / trades.length) * 1000) / 10 : null,
    pnl,
    fees: money(trades.reduce((s, t) => s + t.fees, 0)),
    perTrade: trades.length ? money(pnl / trades.length) : null,
    roiPct: staked ? Math.round((pnl / staked) * 1000) / 10 : null,
    avgPaidCents: trades.length ? Math.round((trades.reduce((s, t) => s + t.paidCents, 0) / trades.length) * 10) / 10 : null,
    // Held to the result, the price paid is the market's chance: winning more often than it is the edge.
    edgePct: held.length
      ? Math.round(((held.filter((t) => t.won).length / held.length) * 100 - held.reduce((s, t) => s + t.paidCents, 0) / held.length) * 10) / 10
      : null,
  }
}

/** The numbers of a run: overall, its halves (does it hold up?), by price, minute, coin and exit. */
export function summarize(trades: readonly BacktestTrade[], rounds: number) {
  let peak = 0
  let total = 0
  let drawdown = 0
  let streak = 0
  let worstStreak = 0
  for (const t of trades) {
    total += t.pnl
    peak = Math.max(peak, total)
    drawdown = Math.max(drawdown, peak - total)
    streak = t.pnl < 0 ? streak + 1 : 0
    worstStreak = Math.max(worstStreak, streak)
  }
  const by = (key: (t: BacktestTrade) => string) => {
    const groups = new Map<string, BacktestTrade[]>()
    for (const t of trades) groups.set(key(t), [...(groups.get(key(t)) ?? []), t])
    return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, list]) => [k, group(list)]))
  }
  const half = Math.floor(trades.length / 2)
  const sorted = [...trades].sort((a, b) => a.pnl - b.pnl)
  return {
    rounds,
    entered: trades.length,
    ...group(trades),
    maxDrawdown: money(drawdown),
    worstLosingStreak: worstStreak,
    worst: sorted.slice(0, 3),
    best: sorted.slice(-3).reverse(),
    halves: { first: group(trades.slice(0, half)), second: group(trades.slice(half)) },
    byPrice: by((t) => {
      const low = Math.min(90, Math.floor(t.paidCents / 10) * 10)
      return `${low}-${low + 10}¢`
    }),
    byMinute: by((t) => `minute ${t.minute}`),
    byMonth: by((t) => t.close.slice(0, 7)),
    byProduct: by((t) => t.product),
    byExit: by((t) => t.exit),
  }
}

/** A rule over every scene, oldest first. */
export function backtest(spec: RuleSpec, scenes: readonly Scene[], coefficient = TAKER_FEE) {
  const rule = compileRule(spec)
  const sorted = [...scenes].sort((a, b) => a.round.close - b.round.close)
  const trades: BacktestTrade[] = []
  for (const scene of sorted) {
    const trade = playRound(rule, scene, coefficient)
    if (trade) trades.push(trade)
  }
  return { trades, summary: summarize(trades, sorted.filter((s) => s.round.result).length) }
}
