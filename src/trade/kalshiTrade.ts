/**
 * Trading Kalshi's 15-minute contracts: the math the server's engine and the phone's quick-trade
 * circles share. Ported from btcAnalyzerV2's shared/kalshi-trade.ts (its tests came along).
 *
 * Kalshi's order API (`POST /portfolio/events/orders`) has one book per market, priced in YES:
 * `bid` buys YES and `ask` sells YES. Selling YES you do not hold is the same as buying NO, so the
 * four moves map onto two book sides (`toV2Order`). There are no market orders: "buy now" is an
 * immediate-or-cancel limit a little above the ask, and Kalshi fills it at the sellers' own prices.
 *
 * Prices are whole MILLS here (thousandths of a dollar, 1..999), because BTC 15m trades in 0.1¢
 * steps below 10¢ and above 90¢ and in 1¢ steps between (`price_ranges`). Off-grid prices are
 * rejected by Kalshi, so every price sent is snapped onto the market's own grid.
 */

export type TradeEnv = 'demo' | 'live'
/** Up = the YES contract, Down = the NO contract. */
export type TradeOutcome = 'up' | 'down'
export type TradeAction = 'buy' | 'sell'
export type TimeInForce = 'immediate_or_cancel' | 'good_till_canceled' | 'fill_or_kill'

export const isEnv = (value: unknown): value is TradeEnv => value === 'demo' || value === 'live'
export const isOutcome = (value: unknown): value is TradeOutcome => value === 'up' || value === 'down'

/**
 * Kalshi's taker fee per order is 0.07 · multiplier · C · P · (1 − P), rounded UP to the hundredth
 * of a cent (fixed-point dollars): 1 contract at 58¢ is charged $0.0171, as a real demo fill showed.
 */
export const TAKER_FEE = 0.07
/** The maker fee, only on series whose `fee_type` carries maker fees (BTC 15m does not). */
export const MAKER_FEE = 0.0175

/** Whether a series' `fee_type` charges makers; unknown types count it, to stay on the safe side. */
export function seriesChargesMakers(feeType: unknown): boolean {
  if (typeof feeType !== 'string' || !feeType) return true
  return feeType === 'quadratic' ? false : /maker/i.test(feeType) || !feeType.startsWith('quadratic')
}

/** The series record's `fee_type`, or null. */
export function parseFeeType(payload: unknown): string | null {
  const series = payload && typeof payload === 'object' ? (payload as { series?: unknown }).series : null
  const type = series && typeof series === 'object' ? (series as { fee_type?: unknown }).fee_type : null
  return typeof type === 'string' ? type : null
}

/** The series' fee multiplier when its fee is quadratic; anything else reads as 1. */
export function parseFeeMultiplier(payload: unknown): number {
  const series = payload && typeof payload === 'object' ? (payload as { series?: unknown }).series : null
  if (!series || typeof series !== 'object') return 1
  const row = series as Record<string, unknown>
  if (typeof row.fee_type !== 'string' || !row.fee_type.startsWith('quadratic')) return 1
  const value = Number(row.fee_multiplier)
  return Number.isFinite(value) && value > 0 ? value : 1
}

/** How far past the ask "buy now" may pay, and past the bid "sell now" may give, in mills. */
export const NOW_SLIPPAGE_MILLS = 20
/** Client order ids this app places start with this, so its own orders can be told apart. */
export const TRADE_ORDER_PREFIX = 'ca-'

/** One band of valid prices, in mills: `start..end` inclusive, every `step`. */
export interface PriceBand {
  start: number
  end: number
  step: number
}

/** Kalshi's `tapered_deci_cent`, which BTC 15m uses: 0.1¢ near the ends, 1¢ in the middle. */
export const TAPERED_BANDS: readonly PriceBand[] = [
  { start: 0, end: 100, step: 1 },
  { start: 100, end: 900, step: 10 },
  { start: 900, end: 1000, step: 1 },
]

const toMills = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? Math.round(n * 1000) : null
}

/** `price_ranges` from a market record, in mills; null when absent or unreadable. */
export function parseBands(raw: unknown): PriceBand[] | null {
  if (!Array.isArray(raw) || !raw.length) return null
  const bands: PriceBand[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null
    const { start, end, step } = row as Record<string, unknown>
    const band = { start: toMills(start), end: toMills(end), step: toMills(step) }
    if (band.start === null || band.end === null || band.step === null || band.step <= 0) return null
    if (band.end < band.start) return null
    bands.push(band as PriceBand)
  }
  return bands
}

/** Every price the market accepts, strictly between 0 and $1, ascending. */
export function priceTicks(bands: readonly PriceBand[]): number[] {
  const seen = new Set<number>()
  for (const band of bands) for (let price = band.start; price <= band.end; price += band.step) if (price > 0 && price < 1000) seen.add(price)
  return [...seen].sort((a, b) => a - b)
}

export const isTick = (mills: number, ticks: readonly number[]): boolean => ticks.includes(mills)

/** The highest valid price at or below `mills`, or null when there is none. */
export function snapDown(mills: number, ticks: readonly number[]): number | null {
  let best: number | null = null
  for (const tick of ticks) if (tick <= mills + 1e-9) best = tick
  return best
}

/** The lowest valid price at or above `mills`, or null when there is none. */
export function snapUp(mills: number, ticks: readonly number[]): number | null {
  for (const tick of ticks) if (tick >= mills - 1e-9) return tick
  return null
}

/** "52¢", "0.1¢", "99.9¢". */
export function formatCents(mills: number | null | undefined): string {
  if (mills === null || mills === undefined || !Number.isFinite(mills)) return '—'
  const tenths = Math.round(mills)
  return tenths % 10 === 0 ? `${tenths / 10}¢` : `${(tenths / 10).toFixed(1)}¢`
}

/** "0.5200": the fixed-point dollar string Kalshi's order API takes. */
export const millsToDollars = (mills: number): string => (mills / 1000).toFixed(4)

/** Kalshi's fee for `count` contracts at `mills`, in dollars, rounded UP to the hundredth of a cent. */
export function feeDollars(count: number, mills: number, coefficient: number): number {
  if (!(count > 0) || !(mills > 0 && mills < 1000) || !(coefficient > 0)) return 0
  const dollars = (coefficient * count * mills * (1000 - mills)) / 1e6
  return Math.ceil(dollars * 10_000 - 1e-6) / 10_000
}

/** What buying `count` at `mills` takes from the balance, fee included, in dollars. */
export function buyCostDollars(count: number, mills: number, coefficient: number): number {
  return Math.round(((count * mills) / 1000 + feeDollars(count, mills, coefficient)) * 10_000) / 10_000
}

/** The most whole contracts `dollars` buys at `mills`, fee included. */
export function contractsFor(dollars: number, mills: number, coefficient: number): number {
  if (!(dollars > 0) || !(mills > 0 && mills < 1000)) return 0
  const perContract = mills / 1000 + (coefficient * mills * (1000 - mills)) / 1e6
  let count = Math.max(0, Math.floor(dollars / perContract))
  while (count > 0 && buyCostDollars(count, mills, coefficient) > dollars + 1e-9) count -= 1
  while (buyCostDollars(count + 1, mills, coefficient) <= dollars + 1e-9) count += 1
  return count
}

/**
 * Net result of buying `count` at `entry` (as a taker) and selling at `exit`, in dollars: as a
 * taker when `takerExit` (a watched target selling to the bid), else as a resting maker, which pays
 * only where the series charges makers. `exit = 1000` is holding to settlement: no fee.
 */
export function netProfitDollars(count: number, entry: number, exit: number, feeMultiplier = 1, makerFees = true, takerExit = false): number {
  const entryFee = feeDollars(count, entry, TAKER_FEE * feeMultiplier)
  const exitFee =
    exit >= 1000 ? 0 : takerExit ? feeDollars(count, exit, TAKER_FEE * feeMultiplier) : !makerFees ? 0 : feeDollars(count, exit, MAKER_FEE * feeMultiplier)
  return ((exit - entry) * count) / 1000 - entryFee - exitFee
}

/**
 * The price of the sell every buy queues: the lowest on the grid at which selling all `count` bought
 * at `entry` makes the most the buy can make (all of it settling at $1) less `underPct`%, after the
 * buy's fee and the resting sale's. Past the top of the grid, the top; null when even that loses.
 * 10 bought at 60¢ can make $3.83; 5% less is $3.64, at 98.2¢.
 */
export function autoSellMills(count: number, entry: number, ticks: readonly number[], feeMultiplier = 1, makerFees = true, underPct = 5): number | null {
  const most = netProfitDollars(count, entry, 1000, feeMultiplier)
  if (!(most > 0)) return null
  const wanted = most * (1 - underPct / 100)
  let top: number | null = null
  for (const tick of ticks) {
    if (tick <= entry || tick >= 1000) continue
    const net = netProfitDollars(count, entry, tick, feeMultiplier, makerFees)
    if (net >= wanted - 1e-9) return tick
    if (net >= 0) top = tick
  }
  return top
}

/** Selling the whole holding to the bid right now, in dollars: the move, both fees, and the cash. */
export interface SellNowResult {
  grossDollars: number
  buyFeeDollars: number
  saleFeeDollars: number
  /** What the cash ends up with: the move less both fees. */
  netDollars: number
}

/**
 * Selling `count` bought at `entry` to the bid right now. 20 bought at 69¢ and sold at 74¢ is
 * +$1.00 on the move but +$0.43 in cash: a $0.2995 buy fee and a $0.2694 sale fee.
 */
export function sellNowResult(count: number, entry: number, bid: number, feeMultiplier = 1): SellNowResult {
  const grossDollars = ((bid - entry) * count) / 1000
  const buyFeeDollars = feeDollars(count, entry, TAKER_FEE * feeMultiplier)
  const saleFeeDollars = feeDollars(count, bid, TAKER_FEE * feeMultiplier)
  return { grossDollars, buyFeeDollars, saleFeeDollars, netDollars: grossDollars - buyFeeDollars - saleFeeDollars }
}

/** "+$1.00 move − $0.30 buy fee − $0.27 sale fee": the text behind a net figure. */
export function sellNowBreakdown(result: SellNowResult): string {
  const dollars = (value: number) => `$${Math.abs(value).toFixed(2)}`
  const sign = result.grossDollars < 0 ? '−' : '+'
  return `${sign}${dollars(result.grossDollars)} move − ${dollars(result.buyFeeDollars)} buy fee − ${dollars(result.saleFeeDollars)} sale fee`
}

/** The first valid sell price at least `pct`% above `entry`, or null past the top of the book. */
export function targetForPercent(entry: number, pct: number, ticks: readonly number[]): number | null {
  const target = snapUp(Math.max(entry * (1 + pct / 100), entry + 1e-6), ticks)
  return target !== null && target > entry ? target : null
}

/** One order as the trader means it: buy or sell Up or Down, at a price of THAT contract. */
export interface OrderIntent {
  ticker: string
  outcome: TradeOutcome
  action: TradeAction
  /** Price of the Up or Down contract being traded, in mills. */
  mills: number
  /** Contracts; whole for buys, up to two decimals for sells (Kalshi allows 0.01). */
  count: number
  timeInForce: TimeInForce
  reduceOnly?: boolean
  clientOrderId: string
}

/** The YES price of an outcome price: Down at 30¢ is YES at 70¢. */
export const yesMills = (outcome: TradeOutcome, mills: number): number => (outcome === 'up' ? mills : 1000 - mills)

/** The single book side an intent trades on: buying Up or selling Down both bid for YES. */
export const bookSide = (outcome: TradeOutcome, action: TradeAction): 'bid' | 'ask' => ((outcome === 'up') === (action === 'buy') ? 'bid' : 'ask')

/** Whether `mills` of `outcome` is a price the market takes (its YES mirror must be on the grid too). */
export const onGrid = (outcome: TradeOutcome, mills: number, ticks: readonly number[]): boolean =>
  Number.isInteger(mills) && isTick(mills, ticks) && isTick(yesMills(outcome, mills), ticks)

/** The request body for `POST /portfolio/events/orders`. */
export function toV2Order(intent: OrderIntent): Record<string, unknown> {
  return {
    ticker: intent.ticker,
    side: bookSide(intent.outcome, intent.action),
    count: Number.isInteger(intent.count) ? String(intent.count) : intent.count.toFixed(2),
    price: millsToDollars(yesMills(intent.outcome, intent.mills)),
    time_in_force: intent.timeInForce,
    self_trade_prevention_type: 'taker_at_cross',
    client_order_id: intent.clientOrderId,
    ...(intent.reduceOnly ? { reduce_only: true } : {}),
  }
}

/** A new client order id: `ca-<kind>-<time>-<random>`. */
export function newClientOrderId(kind: string, now = Date.now()): string {
  return `${TRADE_ORDER_PREFIX}${kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The running market as the circles show it. Prices in mills; null when that side is empty. */
export interface TradeMarket {
  ticker: string
  /** The strike Up has to finish above. */
  strike: number | null
  /** Open and close, unix seconds. */
  open: number | null
  close: number
  upBid: number | null
  upAsk: number | null
  downBid: number | null
  downAsk: number | null
  bands: PriceBand[]
  feeMultiplier: number
  /** The series charges a fee on resting orders that fill (BTC 15m does not). */
  makerFees: boolean
  /** The Kalshi exchange (shard) the market trades on; crypto is 2. Cash is held per exchange. */
  exchangeIndex: number
}

/** The best prices on the book, in mills of each contract. */
export type BookPrices = Pick<TradeMarket, 'upBid' | 'upAsk' | 'downBid' | 'downAsk'>

/** Best prices from the best YES bid and the best NO bid (the book carries only bids). */
export function bookPrices(yesBid: number | null, noBid: number | null): BookPrices {
  return {
    upBid: yesBid,
    upAsk: noBid === null ? null : 1000 - noBid,
    downBid: noBid,
    downAsk: yesBid === null ? null : 1000 - yesBid,
  }
}

/** The account's holding in the running market, from the trader's side. */
export interface TradePosition {
  outcome: TradeOutcome
  /** Contracts held, positive. */
  contracts: number
  /** Average price paid per contract, in mills (may be fractional). */
  avgMills: number | null
  costDollars: number | null
}

/** A resting order on the running market, still in YES-book terms. */
export interface TradeOrder {
  orderId: string
  clientOrderId: string
  side: 'bid' | 'ask'
  /** YES price, in mills. */
  yesMills: number
  remaining: number
}

export const kalshiIsoSeconds = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

export function kalshiMarketRows(payload: unknown): Record<string, unknown>[] {
  const markets = payload && typeof payload === 'object' ? (payload as { markets?: unknown }).markets : null
  return Array.isArray(markets) ? (markets.filter((m) => m && typeof m === 'object') as Record<string, unknown>[]) : []
}

/**
 * The running market of a series: the earliest-closing one open at `nowSec`. Kalshi's listing can
 * still carry markets that closed long ago (seen on demo), so the status and times are both checked.
 */
export function pickRunningMarket(payload: unknown, nowSec: number): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null
  let bestClose = Infinity
  for (const row of kalshiMarketRows(payload)) {
    const status = typeof row.status === 'string' ? row.status : ''
    // "initialized" is a round that has just opened, in a listing a few seconds old.
    if (status && status !== 'active' && status !== 'open' && status !== 'initialized') continue
    const close = kalshiIsoSeconds(row.close_time)
    const open = kalshiIsoSeconds(row.open_time)
    if (close === null || close <= nowSec) continue
    if (open !== null && open > nowSec) continue
    if (typeof row.ticker !== 'string' || !row.ticker) continue
    if (close < bestClose) {
      best = row
      bestClose = close
    }
  }
  return best
}

/** The exchange (shard) a market record says it trades on; 0, Kalshi's default, when absent. */
export function exchangeIndexOf(row: Record<string, unknown>): number {
  const index = Number(row.exchange_index)
  return Number.isInteger(index) && index >= 0 ? index : 0
}

/** A market record as a `TradeMarket`, with no prices yet (the live book fills them in). */
export function toTradeMarket(row: Record<string, unknown>, feeMultiplier: number, makerFees: boolean): TradeMarket | null {
  const close = kalshiIsoSeconds(row.close_time)
  if (typeof row.ticker !== 'string' || close === null) return null
  const strike = Number(row.floor_strike)
  return {
    ticker: row.ticker,
    strike: Number.isFinite(strike) && strike > 0 ? strike : null,
    open: kalshiIsoSeconds(row.open_time),
    close,
    upBid: null,
    upAsk: null,
    downBid: null,
    downAsk: null,
    bands: parseBands(row.price_ranges) ?? [...TAPERED_BANDS],
    feeMultiplier,
    makerFees,
    exchangeIndex: exchangeIndexOf(row),
  }
}

const countOf = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null
}
const dollarsOf = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** The holding in `ticker` from `GET /portfolio/positions`, or null when flat. */
export function parsePosition(payload: unknown, ticker: string): TradePosition | null {
  const rows = payload && typeof payload === 'object' ? (payload as { market_positions?: unknown }).market_positions : null
  if (!Array.isArray(rows)) return null
  const row = rows.find((r) => r && typeof r === 'object' && (r as { ticker?: unknown }).ticker === ticker) as Record<string, unknown> | undefined
  if (!row) return null
  const signed = countOf(row.position_fp) ?? countOf(row.position)
  if (!signed) return null
  const contracts = Math.abs(signed)
  const cost = dollarsOf(row.market_exposure_dollars)
  return {
    outcome: signed > 0 ? 'up' : 'down',
    contracts,
    avgMills: cost !== null && contracts > 0 ? (cost / contracts) * 1000 : null,
    costDollars: cost,
  }
}

/** The resting orders in `GET /portfolio/orders`. */
export function parseOrders(payload: unknown): TradeOrder[] {
  const rows = payload && typeof payload === 'object' ? (payload as { orders?: unknown }).orders : null
  if (!Array.isArray(rows)) return []
  const orders: TradeOrder[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    if (row.status !== undefined && row.status !== 'resting') continue
    const side =
      row.book_side === 'bid' || row.book_side === 'ask'
        ? row.book_side
        : // Older payloads: buying YES or selling NO bids for YES.
          (row.side === 'yes') === (row.action !== 'sell')
          ? 'bid'
          : 'ask'
    const yes = toMills(row.yes_price_dollars)
    const remaining = countOf(row.remaining_count_fp) ?? countOf(row.remaining_count)
    if (typeof row.order_id !== 'string' || yes === null || !remaining) continue
    orders.push({ orderId: row.order_id, clientOrderId: typeof row.client_order_id === 'string' ? row.client_order_id : '', side, yesMills: yes, remaining })
  }
  return orders
}

/** Cash per exchange (shard) in `GET /portfolio/balance`'s `balance_breakdown`, in dollars. */
export function parseBalanceBreakdown(payload: unknown): Map<number, number> {
  const rows = payload && typeof payload === 'object' ? (payload as { balance_breakdown?: unknown }).balance_breakdown : null
  const out = new Map<number, number>()
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const { exchange_index: index, balance } = row as Record<string, unknown>
    const dollars = dollarsOf(balance)
    if (Number.isInteger(index) && dollars !== null) out.set(index as number, dollars)
  }
  return out
}

/** Cash in `GET /portfolio/balance`, in dollars. */
export function parseBalance(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as { balance_dollars?: unknown; balance?: unknown }
  const dollars = dollarsOf(body.balance_dollars)
  if (dollars !== null) return dollars
  const cents = Number(body.balance)
  return Number.isFinite(cents) ? cents / 100 : null
}

/** True when a resting order would shrink `position` if it filled (it trades against the holding). */
export const reducesPosition = (order: TradeOrder, position: TradePosition | null): boolean =>
  !!position && order.side === (position.outcome === 'up' ? 'ask' : 'bid')

/**
 * One market's order book as Kalshi's WebSocket keeps it: YES bids and NO bids, price (mills) →
 * contracts. A snapshot replaces it; each delta adds to one level (a level at zero is gone).
 */
export class LiveBook {
  readonly yes = new Map<number, number>()
  readonly no = new Map<number, number>()

  /** `yes_dollars_fp` / `no_dollars_fp`: [["0.5200", "12.00"], …]. */
  snapshot(msg: Record<string, unknown>): void {
    this.yes.clear()
    this.no.clear()
    for (const [side, key] of [
      [this.yes, 'yes_dollars_fp'],
      [this.no, 'no_dollars_fp'],
    ] as const) {
      const levels = msg[key] ?? msg[key.replace('_fp', '')]
      if (!Array.isArray(levels)) continue
      for (const level of levels) {
        if (!Array.isArray(level)) continue
        const price = toMills(level[0])
        const size = Number(level[1])
        if (price !== null && price > 0 && price < 1000 && size > 0) side.set(price, size)
      }
    }
  }

  /** `{price_dollars, delta_fp, side}`; false when unreadable (the book should be fetched again). */
  delta(msg: Record<string, unknown>): boolean {
    const side = msg.side === 'yes' ? this.yes : msg.side === 'no' ? this.no : null
    const price = toMills(msg.price_dollars)
    const delta = Number(msg.delta_fp ?? msg.delta)
    if (!side || price === null || !Number.isFinite(delta)) return false
    const size = Math.round(((side.get(price) ?? 0) + delta) * 100) / 100
    if (size > 0) side.set(price, size)
    else side.delete(price)
    return true
  }

  /** The REST book (`GET /markets/{ticker}/orderbook`) in the same shape. */
  fromRest(payload: unknown): boolean {
    const body = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
    const book = (body?.orderbook_fp ?? body?.orderbook) as Record<string, unknown> | undefined
    if (!book || typeof book !== 'object') return false
    this.snapshot({ yes_dollars_fp: book.yes_dollars ?? [], no_dollars_fp: book.no_dollars ?? [] })
    return true
  }

  private static best(side: Map<number, number>): number | null {
    let top: number | null = null
    for (const price of side.keys()) if (top === null || price > top) top = price
    return top
  }

  prices(): BookPrices {
    return bookPrices(LiveBook.best(this.yes), LiveBook.best(this.no))
  }
}

/**
 * A target: sell the WHOLE holding once buyers pay `topMills`. The server watches the book and
 * sells to the best buyers, never under the target, so a jump past it sells higher.
 */
export interface TradeTarget {
  id: string
  env: TradeEnv
  ticker: string
  outcome: TradeOutcome
  topMills: number
  state: 'watching' | 'selling' | 'done' | 'ended' | 'canceled'
  message: string
  soldContracts: number
  /** When the round closes, unix ms: the target ends with it. */
  closesAt: number
  /**
   * 'auto-sell': the sell every buy queues on Kalshi, resting, for everything held at `topMills`:
   * the price that makes the most the buy can make less `underPct`%, after fees (0 until it rests).
   * Never at a loss: with no such price, none is queued.
   */
  kind?: 'target' | 'auto-sell'
  underPct?: number
  /** Its order on Kalshi while it rests. */
  orderId?: string
  /** What selling everything at `topMills` makes, after both fees. */
  profitDollars?: number
}

/** What the phone sees: one environment's account on one coin's running round. */
export interface TradeState {
  env: TradeEnv
  product: string
  series: string | null
  /** A key for this environment is set and reads. */
  connected: boolean
  /** Real-money orders are switched on (on the computer). */
  liveEnabled: boolean
  canTrade: boolean
  /** What to set up when trading is not possible, or null. */
  setup: string | null
  market: TradeMarket | null
  /** How prices arrive: pushed by Kalshi's stream, polled, or not at all yet. */
  feed: 'stream' | 'poll' | 'off'
  balance: number | null
  position: TradePosition | null
  targets: TradeTarget[]
  asOf: number
  message: string
}

/** What the order routes answer. */
export interface TradeResult {
  ok: boolean
  message: string
  filled?: number
  avgFillMills?: number | null
  /** How long the order took, from the tap reaching the computer to Kalshi's answer, in ms. */
  ms?: number
}
