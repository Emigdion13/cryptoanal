/**
 * Forced flow — is the move on the chart leverage being unwound?
 *
 * ## What this reports
 *
 * Coinbase spot cannot see liquidations: a liquidation is a leveraged futures position being
 * force-closed on a derivatives venue, and the spot chart only shows the wick it leaves behind.
 * This module reads the perpetual-futures venues reachable without an account and answers, for
 * the last five minutes:
 *
 * - **Open interest (OI) change against price.** Price falling while OI falls unusually fast means
 *   longs are being closed out — a long squeeze — not new sellers arriving. Price rising while OI
 *   falls is the mirror, a short squeeze. Price moving while OI rises is new positions opening.
 * - **Liquidation prints.** Actual force-closed orders from the OKX, Kraken Futures, Deribit,
 *   Gate.io and Bitget public feeds, split by the side that was liquidated.
 * - **Funding.** Which side is paying to hold its position, i.e. which side is crowded.
 *
 * "Unusual" is relative to the venue's own recent history: the 10th/90th percentile of five-minute
 * OI changes, and the 90th percentile of five-minute absolute price changes, over roughly the last
 * five days of non-overlapping five-minute windows.
 *
 * ## What this cannot do
 *
 * It describes the move that is happening; it does not predict the next one. The forced-flow
 * backtest (btcAnalyzerV2's `src/lib/forced-flow.backtest.test.ts`, 180 days of BTC) found that moves classified as
 * forced by this rule do not retrace more often than other moves of the same size, and that
 * crowded funding did not predict which way price went next. See btcAnalyzerV2's `docs/forced-flow.md`.
 *
 * Coverage is partial: Binance and Bybit, the two largest perpetual venues, refuse connections
 * from this machine's region, and OKX's live feed carries at most one order per instrument per
 * second (its REST list does not, and fills the gaps every 30 seconds). Liquidation totals are
 * therefore a floor, not a count.
 */

/** Venues read for open interest, marks and funding. */
export type DerivativesVenue = 'okx' | 'kraken' | 'deribit' | 'hyperliquid' | 'coinbase-intl'
/** Venues whose public feeds publish individual liquidations. Gate.io and Bitget only for these. */
export type LiquidationVenue = 'okx' | 'kraken' | 'deribit' | 'gate' | 'bitget'

export const DERIVATIVES_VENUES: readonly DerivativesVenue[] = [
  'okx',
  'kraken',
  'deribit',
  'hyperliquid',
  'coinbase-intl',
]
export const LIQUIDATION_VENUES: readonly LiquidationVenue[] = [
  'okx',
  'kraken',
  'deribit',
  'gate',
  'bitget',
]

export const VENUE_LABEL: Record<DerivativesVenue | LiquidationVenue, string> = {
  okx: 'OKX',
  kraken: 'Kraken',
  deribit: 'Deribit',
  hyperliquid: 'Hyperliquid',
  'coinbase-intl': 'Coinbase Intl',
  gate: 'Gate.io',
  bitget: 'Bitget',
}

/**
 * Venues whose liquidation price is the position's bankruptcy price — where its margin hits zero,
 * a little past where the market traded — rather than the fill.
 */
export const BANKRUPTCY_PRICE_VENUES: readonly LiquidationVenue[] = ['okx', 'gate', 'bitget']

/** Length of the OI / price comparison window, in seconds. */
export const FORCED_WINDOW_SECONDS = 300
/** Window liquidation bursts are summed over, in seconds. */
export const LIQUIDATION_BURST_SECONDS = 60
/** USD liquidated on one side inside the burst window that counts as a cascade on its own. */
export const LIQUIDATION_BURST_USD = 100_000
/** A five-minute |price change| at or above this percentile of recent windows is a big move. */
export const MOVE_PERCENTILE = 0.9
/** A five-minute OI change at or below this percentile means positions are being closed. */
export const OI_DROP_PERCENTILE = 0.1
/** A five-minute OI change at or above this percentile means positions are being opened. */
export const OI_RISE_PERCENTILE = 0.9
/** Windows the percentile distributions keep: five days of five-minute windows. */
export const DISTRIBUTION_CAPACITY = 1440
/** Windows needed before the percentile thresholds are trusted. */
export const DISTRIBUTION_MINIMUM = 100
/** How long liquidation prints are kept, in seconds. */
export const LIQUIDATION_MEMORY_SECONDS = 300
/** How long finished forced-flow events stay listed (and marked on the chart), in seconds. */
export const EVENT_MEMORY_SECONDS = 4 * 3600
export const MAX_EVENTS = 24
export const MAX_RECENT_LIQUIDATIONS = 6
/** Funding above this (per 8h) means longs are paying a premium: longs crowded. */
export const CROWDED_LONG_FUNDING = 0.0003
/** Funding below this (per 8h) means shorts are paying: shorts crowded. */
export const CROWDED_SHORT_FUNDING = -0.0001

/**
 * `longs-liquidating`  price falling with OI collapsing, or a long-liquidation burst
 * `shorts-liquidating` price rising with OI collapsing, or a short-liquidation burst
 * `new-shorts`         price falling with OI rising: fresh shorts, not forced selling
 * `new-longs`          price rising with OI rising: fresh longs, not forced buying
 * `big-move`           a big move with OI in its normal range: spot or unhedged flow
 * `calm`               nothing above
 * `warming-up`         not enough OI history yet to say
 */
export type ForcedState =
  | 'longs-liquidating'
  | 'shorts-liquidating'
  | 'new-shorts'
  | 'new-longs'
  | 'big-move'
  | 'calm'
  | 'warming-up'

export const FORCED_STATES: readonly ForcedState[] = [
  'longs-liquidating',
  'shorts-liquidating',
  'new-shorts',
  'new-longs',
  'big-move',
  'calm',
  'warming-up',
]

/**
 * Measured follow-through after a big five-minute move: the share that traded back half the move
 * within 15 minutes and within an hour. From btcAnalyzerV2's `forced-flow.backtest.test.ts` on 180 days of
 * BTC-USD (Coinbase bars, Kraken Futures OI), 2026-04 → 2026-09, 5,432 big moves. Every forced
 * label sits inside the noise of the all-moves rate: the label explains a move, it does not tell
 * you the move will reverse.
 */
export const FORCED_FOLLOW_THROUGH: Record<
  'all' | 'longs-liquidating' | 'shorts-liquidating' | 'new-shorts' | 'new-longs' | 'big-move',
  { n: number; back15m: number; back60m: number }
> = {
  all: { n: 5432, back15m: 0.59, back60m: 0.776 },
  'longs-liquidating': { n: 621, back15m: 0.602, back60m: 0.781 },
  'shorts-liquidating': { n: 844, back15m: 0.576, back60m: 0.758 },
  'new-shorts': { n: 588, back15m: 0.614, back60m: 0.786 },
  'new-longs': { n: 504, back15m: 0.587, back60m: 0.774 },
  'big-move': { n: 2875, back15m: 0.587, back60m: 0.778 },
}

export const isForcedState = (state: ForcedState): boolean =>
  state === 'longs-liquidating' || state === 'shorts-liquidating'

/** One force-closed order. `side` is the position that was liquidated, not the order's side. */
export interface Liquidation {
  venue: LiquidationVenue
  /** Exchange time, seconds. */
  time: number
  price: number
  /** Base-currency size. */
  size: number
  /** USD notional. */
  notional: number
  side: 'long' | 'short'
}

/** One venue's open interest and mark at a moment. */
export interface OpenInterestSample {
  venue: DerivativesVenue
  /** Local receipt time, seconds. */
  time: number
  /** Base-currency open interest. */
  openInterest: number
  mark: number
}

export interface FundingSample {
  venue: DerivativesVenue
  time: number
  /** Funding rate normalized to one 8-hour period, as a fraction (0.0001 = 0.01%). */
  rate8h: number
}

export interface ForcedEvent {
  id: string
  state: 'longs-liquidating' | 'shorts-liquidating'
  /** When the state began, seconds. */
  start: number
  /** Last moment the state was observed, seconds. */
  end: number
  /** Composite mark when the state began. */
  price: number
  /** Most extreme five-minute price change seen during the event, as a fraction. */
  priceChange: number
  /** Most negative five-minute OI change seen during the event, as a fraction. */
  oiChange: number | null
  /** Largest five-minute liquidated USD on the squeezed side seen during the event. */
  liquidatedUsd: number
  /**
   * Replayed from Kraken Futures' published five-minute history rather than seen live. Kraken's
   * liquidation volume carries no side, so `liquidatedUsd` is 0 on these.
   */
  history?: boolean
}

export interface ForcedFlow {
  product: string
  asOf: number
  state: ForcedState
  windowSeconds: number
  /** Five-minute composite mark change, as a fraction. Null until two marks five minutes apart. */
  priceChange: number | null
  /** Five-minute summed OI change, as a fraction. Null until two samples five minutes apart. */
  oiChange: number | null
  /** Summed base-currency OI across the venues that reported. */
  openInterest: number | null
  /** Median mark across venues. */
  mark: number | null
  /** Venues inside the OI change. */
  oiVenues: DerivativesVenue[]
  thresholds: {
    move: number | null
    oiDrop: number | null
    oiRise: number | null
    /** Windows in the distribution. */
    samples: number
    calibrated: boolean
  }
  liquidations: {
    longUsd: number
    shortUsd: number
    longUsd5m: number
    shortUsd5m: number
    burstSeconds: number
    recent: Liquidation[]
    /** The newest print seen on any feed, even one past the memory window. Absent from older servers. */
    last?: { venue: LiquidationVenue; time: number } | null
  }
  funding: {
    /** Mean 8-hour funding across venues, fraction. */
    rate8h: number | null
    venues: DerivativesVenue[]
    crowded: 'longs' | 'shorts' | null
  }
  /** Liquidation feed state per venue. */
  feeds: Partial<Record<LiquidationVenue, 'live' | 'connecting' | 'down'>>
  events: ForcedEvent[]
  /** Coinbase spot against the perps over the same window. Absent from older servers. */
  spot?: SpotVsPerps
  /** Deribit options open interest for the coming week; null for products Deribit lacks. */
  options?: OptionsPositioning | null
  /** Squeezes replayed from Kraken's five-minute history, oldest first. */
  history?: ForcedEvent[]
}

/* ------------------------------------------------------------------------------------------ */
/* Spot against perps                                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * Change in the perp-over-spot premium across the window that counts as one side leading: two
 * basis points. When perps run ahead of spot in the direction of the move the premium widens
 * that way; when spot drags the perps behind it, the premium moves against the move.
 */
export const LEAD_PREMIUM_CHANGE = 0.0002
/** A move must reach this share of the big-move threshold before a leader is named. */
export const LEAD_MOVE_SHARE = 0.5
/** The minimum five-minute move for naming a leader while the thresholds are uncalibrated. */
export const LEAD_MIN_MOVE = 0.0015

/** `spot`: Coinbase moved and the perps followed. `perps`: leverage moved and spot followed. */
export type FlowLeader = 'spot' | 'perps' | 'together'

export interface SpotVsPerps {
  /** Coinbase spot taker buys over the window, USD. */
  boughtUsd: number
  /** Coinbase spot taker sells over the window, USD. */
  soldUsd: number
  /** Coinbase spot price change over the window. Null until two samples five minutes apart. */
  priceChange: number | null
  /** Median USD-quoted perp last price over Coinbase spot, minus one. */
  premium: number | null
  /** Premium now minus premium five minutes ago. */
  premiumChange: number | null
  /** Null while price has not moved enough to say, or either side is missing. */
  leader: FlowLeader | null
  /** Perps inside the premium. */
  perpVenues: DerivativesVenue[]
}

/** Who led a move, from the premium's change across it. */
export function classifyLeader(
  priceChange: number | null,
  premiumChange: number | null,
  minMove: number,
): FlowLeader | null {
  if (priceChange === null || premiumChange === null || Math.abs(priceChange) < minMove) return null
  const push = Math.sign(priceChange) * premiumChange
  if (push >= LEAD_PREMIUM_CHANGE) return 'perps'
  if (push <= -LEAD_PREMIUM_CHANGE) return 'spot'
  return 'together'
}

/* ------------------------------------------------------------------------------------------ */
/* Options positioning                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** Expiries and strikes inside this many days are summarized. */
export const OPTIONS_HORIZON_DAYS = 7
export const MAX_OPTION_EXPIRIES = 8
export const MAX_OPTION_STRIKES = 6

export interface OptionsExpiry {
  /** Deribit's code, e.g. `9OCT26`. */
  code: string
  /** Settlement time, seconds (08:00 UTC). */
  time: number
  /** Open interest in the base coin, calls plus puts. */
  openInterest: number
  /** Put open interest over call open interest. */
  putCall: number | null
  /** The strike where option holders' total payout would be smallest at settlement. */
  maxPain: number | null
}

export interface OptionsStrike {
  strike: number
  /** Base-coin open interest across the horizon's expiries. */
  callOi: number
  putOi: number
}

export interface OptionsPositioning {
  venue: 'deribit'
  asOf: number
  underlying: number | null
  horizonDays: number
  /** Soonest first. */
  expiries: OptionsExpiry[]
  /** The largest strikes by open interest inside the horizon, ascending by strike. */
  strikes: OptionsStrike[]
}

/* ------------------------------------------------------------------------------------------ */
/* Squeeze history                                                                              */
/* ------------------------------------------------------------------------------------------ */

/** How far back the Kraken replay marks squeezes, in seconds. */
export const HISTORY_SECONDS = 3 * 86400
/** Extra history fetched ahead of `HISTORY_SECONDS` so the thresholds start calibrated. */
export const HISTORY_WARMUP_SECONDS = 86400

/** One five-minute bar of a perpetual's price and open interest. */
export interface HistoryBar {
  time: number
  close: number
  oiOpen: number
  oiClose: number
}

/**
 * Replay five-minute bars through `classifyForcedFlow` with the same trailing thresholds the live
 * tracker keeps, and return the squeezes that began at or after `since`. Consecutive forced bars
 * of the same kind are one event. The burst rule cannot run (no side on the liquidation volume),
 * so this is the OI rule alone.
 */
export function historicalForcedEvents(
  product: string,
  bars: readonly HistoryBar[],
  since: number,
): ForcedEvent[] {
  const sorted = [...bars]
    .filter((b) => [b.time, b.close, b.oiOpen, b.oiClose].every((v) => Number.isFinite(v) && v > 0))
    .sort((a, b) => a.time - b.time)
  const moves = new RollingDistribution()
  const oiChanges = new RollingDistribution()
  const events: ForcedEvent[] = []
  let open: ForcedEvent | null = null
  for (let i = 1; i < sorted.length; i++) {
    const bar = sorted[i]
    const previous = sorted[i - 1]
    if (bar.time - previous.time !== FORCED_WINDOW_SECONDS) {
      open = null
      continue
    }
    const priceChange = bar.close / previous.close - 1
    const oiChange = bar.oiClose / bar.oiOpen - 1
    const ready = moves.size >= DISTRIBUTION_MINIMUM && oiChanges.size >= DISTRIBUTION_MINIMUM
    const state = classifyForcedFlow({
      priceChange,
      oiChange,
      move: ready ? moves.percentile(MOVE_PERCENTILE) : null,
      oiDrop: ready ? oiChanges.percentile(OI_DROP_PERCENTILE) : null,
      oiRise: ready ? oiChanges.percentile(OI_RISE_PERCENTILE) : null,
      longUsd: 0,
      shortUsd: 0,
    })
    moves.push(Math.abs(priceChange))
    oiChanges.push(oiChange)
    if ((state !== 'longs-liquidating' && state !== 'shorts-liquidating') || bar.time < since) {
      open = null
      continue
    }
    if (open && open.state === state && open.end === bar.time) {
      open.end = bar.time + FORCED_WINDOW_SECONDS
      open.priceChange = open.price > 0 ? bar.close / open.price - 1 : open.priceChange
      if (open.oiChange === null || oiChange < open.oiChange) open.oiChange = oiChange
      continue
    }
    open = {
      id: `${product}:history:${state}:${bar.time}`,
      state,
      start: bar.time,
      end: bar.time + FORCED_WINDOW_SECONDS,
      price: previous.close,
      priceChange,
      oiChange,
      liquidatedUsd: 0,
      history: true,
    }
    events.push(open)
  }
  return events
}

/** Classification inputs: one five-minute window and the thresholds to compare it against. */
export interface ForcedInput {
  priceChange: number | null
  oiChange: number | null
  move: number | null
  oiDrop: number | null
  oiRise: number | null
  longUsd: number
  shortUsd: number
}

/**
 * The rule, kept in one place so the live box and the backtest classify identically.
 *
 * A one-sided liquidation burst is forced flow whatever OI shows (OI polls lag a cascade). Without
 * one, a window must first be a big move, then OI decides who drove it.
 */
export function classifyForcedFlow(input: ForcedInput): ForcedState {
  const { priceChange, oiChange, move, oiDrop, oiRise, longUsd, shortUsd } = input
  if (longUsd >= LIQUIDATION_BURST_USD && longUsd >= 2 * shortUsd) return 'longs-liquidating'
  if (shortUsd >= LIQUIDATION_BURST_USD && shortUsd >= 2 * longUsd) return 'shorts-liquidating'
  if (
    priceChange === null ||
    oiChange === null ||
    move === null ||
    oiDrop === null ||
    oiRise === null
  )
    return 'warming-up'
  if (Math.abs(priceChange) < move || priceChange === 0) return 'calm'
  const down = priceChange < 0
  if (oiChange <= oiDrop) return down ? 'longs-liquidating' : 'shorts-liquidating'
  if (oiChange >= oiRise) return down ? 'new-shorts' : 'new-longs'
  return 'big-move'
}

/** A bounded FIFO of window values with percentile reads. */
export class RollingDistribution {
  private values: number[] = []
  private sorted: number[] | null = null
  readonly capacity: number
  // No parameter properties in shared/: the production server loads it under Node's
  // strip-only TypeScript mode, which rejects them.
  constructor(capacity = DISTRIBUTION_CAPACITY) {
    this.capacity = capacity
  }
  get size() {
    return this.values.length
  }
  push(value: number) {
    if (!Number.isFinite(value)) return
    this.values.push(value)
    if (this.values.length > this.capacity) this.values.shift()
    this.sorted = null
  }
  percentile(p: number): number | null {
    if (!this.values.length) return null
    this.sorted ??= [...this.values].sort((a, b) => a - b)
    const rank = Math.min(this.sorted.length - 1, Math.max(0, Math.floor(this.sorted.length * p)))
    return this.sorted[rank]
  }
}

/** Five-minute log-free fractional changes between consecutive points, for seeding. */
export function windowChanges(points: readonly { time: number; value: number }[]): number[] {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value) && p.value > 0)
    .sort((a, b) => a.time - b.time)
  const changes: number[] = []
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].time - sorted[i - 1].time === FORCED_WINDOW_SECONDS)
      changes.push(sorted[i].value / sorted[i - 1].value - 1)
  return changes
}

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** Samples older than this cannot stand for "now". */
const FRESH_SECONDS = 60
/** How far from exactly five minutes ago the "then" sample may be. */
const WINDOW_SLACK_SECONDS = 60
/** How far apart a perp poll and the spot print it is paired with may be. */
const SPOT_FRESH_SECONDS = 10

/**
 * Live forced-flow state for one product.
 *
 * Fed OI samples, funding samples and liquidations by the server; `snapshot(now)` classifies the
 * trailing five minutes. Pure apart from the clock values it is handed, so tests drive it directly.
 */
export class ForcedFlowTracker {
  private oi = new Map<DerivativesVenue, OpenInterestSample[]>()
  private funding = new Map<DerivativesVenue, FundingSample>()
  private liquidations: Liquidation[] = []
  /** Identity of every print inside the memory window: live feeds and REST backfills overlap. */
  private seenLiquidations = new Map<string, number>()
  private lastLiquidation: { venue: LiquidationVenue; time: number } | null = null
  private moves = new RollingDistribution()
  private oiChanges = new RollingDistribution()
  private lastWindow = 0
  private events: ForcedEvent[] = []
  private open: ForcedEvent | null = null
  /** Coinbase spot taker flow, one bucket per second. */
  private spotFlow: { second: number; bought: number; sold: number }[] = []
  private spotLast: { time: number; price: number } | null = null
  /** Perp last price against Coinbase spot, sampled at each poll. */
  private premiums: { time: number; perp: number; spot: number; venues: DerivativesVenue[] }[] = []
  private options: OptionsPositioning | null | undefined = undefined
  private history: ForcedEvent[] = []
  feeds: ForcedFlow['feeds'] = {}

  readonly product: string

  constructor(product: string) {
    this.product = product
  }

  /** Seed the percentile distributions with venue history (non-overlapping five-minute changes). */
  seed(priceChanges: readonly number[], oiChanges: readonly number[]) {
    for (const change of priceChanges) this.moves.push(Math.abs(change))
    for (const change of oiChanges) this.oiChanges.push(change)
  }

  addOpenInterest(sample: OpenInterestSample) {
    if (
      !Number.isFinite(sample.openInterest) ||
      sample.openInterest <= 0 ||
      !Number.isFinite(sample.mark) ||
      sample.mark <= 0
    )
      return
    const list = this.oi.get(sample.venue) ?? []
    list.push(sample)
    const cutoff = sample.time - FORCED_WINDOW_SECONDS - 2 * WINDOW_SLACK_SECONDS
    while (list.length && list[0].time < cutoff) list.shift()
    this.oi.set(sample.venue, list)
  }

  addFunding(sample: FundingSample) {
    if (Number.isFinite(sample.rate8h) && Math.abs(sample.rate8h) < 0.05)
      this.funding.set(sample.venue, sample)
  }

  addLiquidation(liquidation: Liquidation, now: number) {
    if (
      ![liquidation.price, liquidation.size, liquidation.notional, liquidation.time].every(
        Number.isFinite,
      ) ||
      liquidation.notional <= 0
    )
      return
    if (!this.lastLiquidation || liquidation.time > this.lastLiquidation.time)
      this.lastLiquidation = { venue: liquidation.venue, time: liquidation.time }
    // Venues replay and batch, so prints arrive out of order; one already past the memory
    // window must not be counted as current.
    if (liquidation.time < now - LIQUIDATION_MEMORY_SECONDS) return
    // The same print reaches us twice when a REST backfill or a reconnect snapshot overlaps the
    // live feed; venues send identical fields both ways.
    const key = `${liquidation.venue}|${liquidation.time}|${liquidation.price}|${liquidation.size}|${liquidation.side}`
    if (this.seenLiquidations.has(key)) return
    this.seenLiquidations.set(key, liquidation.time)
    this.liquidations.push(liquidation)
    this.pruneLiquidations(now)
  }

  /** One Coinbase spot match. `takerSide` null still moves the price but not the flow. */
  addSpotTrade(
    trade: { time: number; price: number; size: number; takerSide?: 'buy' | 'sell' | null },
    now: number,
  ) {
    if (
      ![trade.time, trade.price, trade.size].every(Number.isFinite) ||
      trade.price <= 0 ||
      trade.size <= 0
    )
      return
    if (!this.spotLast || trade.time >= this.spotLast.time)
      this.spotLast = { time: trade.time, price: trade.price }
    if (!trade.takerSide || trade.time < now - FORCED_WINDOW_SECONDS) return
    const second = Math.floor(trade.time)
    let bucket = this.spotFlow[this.spotFlow.length - 1]
    if (!bucket || bucket.second !== second) {
      bucket = { second, bought: 0, sold: 0 }
      this.spotFlow.push(bucket)
    }
    if (trade.takerSide === 'buy') bucket.bought += trade.size * trade.price
    else bucket.sold += trade.size * trade.price
    const cutoff = now - FORCED_WINDOW_SECONDS
    while (this.spotFlow.length && this.spotFlow[0].second < cutoff) this.spotFlow.shift()
  }

  /**
   * Pair the perps' last prices with the latest Coinbase spot print. Only USD-quoted perps: a
   * USDT or USDC book would fold the stablecoin's own drift into the premium.
   */
  samplePremium(time: number, lasts: readonly { venue: DerivativesVenue; price: number }[]) {
    const valid = lasts.filter((l) => Number.isFinite(l.price) && l.price > 0)
    const perp = median(valid.map((l) => l.price))
    const spot = this.spotLast
    if (perp === null || !spot || Math.abs(time - spot.time) > SPOT_FRESH_SECONDS) return
    this.premiums.push({ time, perp, spot: spot.price, venues: valid.map((l) => l.venue) })
    const cutoff = time - FORCED_WINDOW_SECONDS - 2 * WINDOW_SLACK_SECONDS
    while (this.premiums.length && this.premiums[0].time < cutoff) this.premiums.shift()
  }

  setOptions(options: OptionsPositioning | null) {
    this.options = options
  }

  setHistory(events: ForcedEvent[]) {
    this.history = events
  }

  private spotVsPerps(now: number, move: number | null): SpotVsPerps {
    let boughtUsd = 0,
      soldUsd = 0
    for (const bucket of this.spotFlow)
      if (bucket.second >= now - FORCED_WINDOW_SECONDS) {
        boughtUsd += bucket.bought
        soldUsd += bucket.sold
      }
    const latest = this.premiums[this.premiums.length - 1]
    const fresh = latest && now - latest.time <= FRESH_SECONDS ? latest : null
    let then: (typeof this.premiums)[number] | null = null
    if (fresh) {
      const target = fresh.time - FORCED_WINDOW_SECONDS
      for (const sample of this.premiums)
        if (
          Math.abs(sample.time - target) <= WINDOW_SLACK_SECONDS &&
          (!then || Math.abs(sample.time - target) < Math.abs(then.time - target))
        )
          then = sample
    }
    const premiumOf = (s: { perp: number; spot: number }) => s.perp / s.spot - 1
    const premium = fresh ? premiumOf(fresh) : null
    const premiumChange = fresh && then ? premiumOf(fresh) - premiumOf(then) : null
    const priceChange = fresh && then ? fresh.spot / then.spot - 1 : null
    return {
      boughtUsd,
      soldUsd,
      priceChange,
      premium,
      premiumChange,
      leader: classifyLeader(
        priceChange,
        premiumChange,
        move !== null ? move * LEAD_MOVE_SHARE : LEAD_MIN_MOVE,
      ),
      perpVenues: fresh ? fresh.venues : [],
    }
  }

  private pruneLiquidations(now: number) {
    const cutoff = now - LIQUIDATION_MEMORY_SECONDS
    if (this.liquidations.some((l) => l.time < cutoff))
      this.liquidations = this.liquidations.filter((l) => l.time >= cutoff)
    if (this.liquidations.length > 4000) this.liquidations = this.liquidations.slice(-4000)
    // A forgotten key cannot let its print back in: past the cutoff it is refused anyway. Keys go
    // in roughly in time order, so stop at the first fresh one; a late straggler goes next round.
    for (const [key, time] of this.seenLiquidations) {
      if (time >= cutoff) break
      this.seenLiquidations.delete(key)
    }
  }

  /** The OI and mark change over the last five minutes, venue by venue, then summed. */
  private window(now: number) {
    let before = 0,
      after = 0
    const venues: DerivativesVenue[] = []
    const priceChanges: number[] = []
    const marks: number[] = []
    let total = 0
    for (const [venue, list] of this.oi) {
      const latest = list[list.length - 1]
      if (!latest || now - latest.time > FRESH_SECONDS) continue
      total += latest.openInterest
      marks.push(latest.mark)
      const target = latest.time - FORCED_WINDOW_SECONDS
      let then: OpenInterestSample | null = null
      for (const sample of list)
        if (
          Math.abs(sample.time - target) <= WINDOW_SLACK_SECONDS &&
          (!then || Math.abs(sample.time - target) < Math.abs(then.time - target))
        )
          then = sample
      if (!then) continue
      before += then.openInterest
      after += latest.openInterest
      venues.push(venue)
      priceChanges.push(latest.mark / then.mark - 1)
    }
    return {
      oiChange: before > 0 ? after / before - 1 : null,
      priceChange: median(priceChanges),
      venues,
      openInterest: total > 0 ? total : null,
      mark: median(marks),
    }
  }

  snapshot(now: number): ForcedFlow {
    this.pruneLiquidations(now)
    const window = this.window(now)
    // One non-overlapping five-minute window per bucket joins the distributions, so live windows
    // weigh the same as the seeded history.
    const bucket = Math.floor(now / FORCED_WINDOW_SECONDS)
    if (bucket !== this.lastWindow && window.oiChange !== null && window.priceChange !== null) {
      if (this.lastWindow) {
        this.moves.push(Math.abs(window.priceChange))
        this.oiChanges.push(window.oiChange)
      }
      this.lastWindow = bucket
    }
    let longUsd = 0,
      shortUsd = 0,
      longUsd5m = 0,
      shortUsd5m = 0
    for (const l of this.liquidations) {
      const burst = now - l.time <= LIQUIDATION_BURST_SECONDS
      if (l.side === 'long') {
        longUsd5m += l.notional
        if (burst) longUsd += l.notional
      } else {
        shortUsd5m += l.notional
        if (burst) shortUsd += l.notional
      }
    }
    const calibrated =
      this.moves.size >= DISTRIBUTION_MINIMUM && this.oiChanges.size >= DISTRIBUTION_MINIMUM
    const thresholds = {
      move: calibrated ? this.moves.percentile(MOVE_PERCENTILE) : null,
      oiDrop: calibrated ? this.oiChanges.percentile(OI_DROP_PERCENTILE) : null,
      oiRise: calibrated ? this.oiChanges.percentile(OI_RISE_PERCENTILE) : null,
      samples: Math.min(this.moves.size, this.oiChanges.size),
      calibrated,
    }
    const state = classifyForcedFlow({
      priceChange: window.priceChange,
      oiChange: window.oiChange,
      move: thresholds.move,
      oiDrop: thresholds.oiDrop,
      oiRise: thresholds.oiRise,
      longUsd,
      shortUsd,
    })
    this.track(state, now, window, longUsd5m, shortUsd5m)
    const fundingSamples = [...this.funding.values()].filter((f) => now - f.time <= 3600)
    const rate8h = fundingSamples.length
      ? fundingSamples.reduce((sum, f) => sum + f.rate8h, 0) / fundingSamples.length
      : null
    return {
      product: this.product,
      asOf: now,
      state,
      windowSeconds: FORCED_WINDOW_SECONDS,
      priceChange: window.priceChange,
      oiChange: window.oiChange,
      openInterest: window.openInterest,
      mark: window.mark,
      oiVenues: window.venues,
      thresholds,
      liquidations: {
        longUsd,
        shortUsd,
        longUsd5m,
        shortUsd5m,
        burstSeconds: LIQUIDATION_BURST_SECONDS,
        recent: [...this.liquidations]
          .sort((a, b) => b.time - a.time)
          .slice(0, MAX_RECENT_LIQUIDATIONS),
        last: this.lastLiquidation ? { ...this.lastLiquidation } : null,
      },
      funding: {
        rate8h,
        venues: fundingSamples.map((f) => f.venue),
        crowded:
          rate8h === null
            ? null
            : rate8h >= CROWDED_LONG_FUNDING
              ? 'longs'
              : rate8h <= CROWDED_SHORT_FUNDING
                ? 'shorts'
                : null,
      },
      feeds: { ...this.feeds },
      events: this.events.map((event) => ({ ...event })),
      spot: this.spotVsPerps(now, thresholds.move),
      ...(this.options !== undefined ? { options: this.options } : {}),
      // A live event already marks its own squeeze; the replayed one would sit on the same bar.
      history: this.history
        .filter(
          (h) =>
            h.start >= now - HISTORY_SECONDS &&
            !this.events.some(
              (e) =>
                e.state === h.state && e.start < h.end + FORCED_WINDOW_SECONDS && e.end >= h.start,
            ),
        )
        .map((event) => ({ ...event })),
    }
  }

  /** Open an event on entering a forced state, widen it while it lasts, close it on leaving. */
  private track(
    state: ForcedState,
    now: number,
    window: { priceChange: number | null; oiChange: number | null; mark: number | null },
    longUsd5m: number,
    shortUsd5m: number,
  ) {
    const forced = state === 'longs-liquidating' || state === 'shorts-liquidating'
    if (this.open && (!forced || this.open.state !== state)) this.open = null
    if (forced) {
      const squeezed = state === 'longs-liquidating' ? longUsd5m : shortUsd5m
      if (!this.open) {
        if (window.mark !== null) {
          this.open = {
            id: `${this.product}:${state}:${Math.round(now)}`,
            state,
            start: now,
            end: now,
            price: window.mark,
            priceChange: window.priceChange ?? 0,
            oiChange: window.oiChange,
            liquidatedUsd: squeezed,
          }
          this.events.push(this.open)
        }
      } else {
        const open = this.open
        open.end = now
        if (
          window.priceChange !== null &&
          Math.abs(window.priceChange) > Math.abs(open.priceChange)
        )
          open.priceChange = window.priceChange
        if (window.oiChange !== null && (open.oiChange === null || window.oiChange < open.oiChange))
          open.oiChange = window.oiChange
        open.liquidatedUsd = Math.max(open.liquidatedUsd, squeezed)
      }
    }
    const cutoff = now - EVENT_MEMORY_SECONDS
    this.events = this.events.filter((e) => e.end >= cutoff).slice(-MAX_EVENTS)
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Venue instruments                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** The perpetual each venue lists for a Coinbase product's base asset. */
export function perpetualsFor(product: string) {
  const base = product.replace(/-USD$/, '')
  if (!/^[A-Z0-9]{1,12}$/.test(base)) return null
  return {
    base,
    okx: [`${base}-USDT-SWAP`, `${base}-USD-SWAP`],
    kraken: `PF_${base === 'BTC' ? 'XBT' : base}USD`,
    // Deribit's inverse USD perpetuals exist only for BTC and ETH.
    deribit: base === 'BTC' || base === 'ETH' ? `${base}-PERPETUAL` : null,
    // Its linear USDC perpetuals cover BTC, ETH and a long list of alts; whether this one is
    // listed is learned from the USDC summary before it is subscribed.
    deribitLinear: `${base}_USDC-PERPETUAL`,
    hyperliquid: base,
    coinbaseIntl: `${base}-PERP`,
    gate: `${base}_USDT`,
    bitget: `${base}USDT`,
  }
}

/** Deribit's linear (USDC-margined) instruments quote size in the base coin, not USD. */
const isDeribitLinear = (instrument: string) => instrument.includes('_USDC-')

/* ------------------------------------------------------------------------------------------ */
/* Parsers: every upstream payload is untrusted and validated field by field                    */
/* ------------------------------------------------------------------------------------------ */

const num = (value: unknown): number | null => {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN
  return Number.isFinite(n) ? n : null
}
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** OKX contract specs: base units (linear) or USD (inverse) per contract. */
export interface OkxContract {
  instId: string
  ctVal: number
  /** `base` when ctVal is in the base coin (USDT-margined), `usd` when in USD (coin-margined). */
  unit: 'base' | 'usd'
}

export function parseOkxInstruments(payload: unknown): Map<string, OkxContract> {
  const out = new Map<string, OkxContract>()
  for (const raw of list(record(payload)?.data)) {
    const r = record(raw)
    const instId = r?.instId
    const ctVal = num(r?.ctVal)
    if (typeof instId !== 'string' || ctVal === null || ctVal <= 0) continue
    const unit = r?.ctValCcy === 'USD' ? 'usd' : 'base'
    out.set(instId, { instId, ctVal, unit })
  }
  return out
}

/**
 * OKX `liquidation-orders` push or REST page. Each detail is a contract count; `posSide` names
 * the liquidated position, falling back to the order side (a sell closes a long) in net mode.
 */
export function parseOkxLiquidations(
  payload: unknown,
  contracts: ReadonlyMap<string, OkxContract>,
): { instId: string; liquidation: Liquidation }[] {
  const out: { instId: string; liquidation: Liquidation }[] = []
  for (const raw of list(record(payload)?.data)) {
    const r = record(raw)
    const instId = r?.instId
    if (typeof instId !== 'string') continue
    const contract = contracts.get(instId)
    if (!contract) continue
    for (const d of list(r?.details)) {
      const detail = record(d)
      const price = num(detail?.bkPx)
      const sz = num(detail?.sz)
      const ts = num(detail?.ts ?? detail?.time)
      if (price === null || price <= 0 || sz === null || sz <= 0 || ts === null) continue
      const posSide = detail?.posSide
      const side =
        posSide === 'long' || posSide === 'short'
          ? posSide
          : detail?.side === 'sell'
            ? 'long'
            : detail?.side === 'buy'
              ? 'short'
              : null
      if (!side) continue
      const size = contract.unit === 'base' ? sz * contract.ctVal : (sz * contract.ctVal) / price
      out.push({
        instId,
        liquidation: { venue: 'okx', time: ts / 1000, price, size, notional: size * price, side },
      })
    }
  }
  return out
}

/**
 * Kraken Futures `trade` feed. Liquidations arrive as `type: "liquidation"`; `side` is the taker,
 * and the liquidated position is the taker (a sell closes a long). `trade_snapshot` is the recent
 * history replayed on (re)subscribe: it fills a reconnect's gap, and the tracker drops the prints
 * it has already counted.
 */
export function parseKrakenLiquidations(
  message: unknown,
): { productId: string; liquidation: Liquidation }[] {
  const r = record(message)
  const trades = r?.feed === 'trade' ? [r] : r?.feed === 'trade_snapshot' ? list(r.trades) : []
  const out: { productId: string; liquidation: Liquidation }[] = []
  for (const raw of trades) {
    const t = record(raw)
    if (t?.type !== 'liquidation') continue
    const productId = t.product_id ?? r?.product_id
    const price = num(t.price)
    const qty = num(t.qty)
    const time = num(t.time)
    const side = t.side === 'sell' ? 'long' : t.side === 'buy' ? 'short' : null
    if (
      typeof productId !== 'string' ||
      price === null ||
      price <= 0 ||
      qty === null ||
      qty <= 0 ||
      time === null ||
      !side
    )
      continue
    out.push({
      productId,
      liquidation: {
        venue: 'kraken',
        time: time / 1000,
        price,
        size: qty,
        notional: qty * price,
        side,
      },
    })
  }
  return out
}

/**
 * Deribit `trades.<instrument>` notifications. `amount` is USD for the inverse perpetuals and the
 * base coin for the linear USDC ones; `direction` is the taker's. `liquidation` marks who was
 * liquidated: `T` the taker, `M` the maker (the other side of the taker), `MT` both.
 */
export function parseDeribitLiquidations(
  message: unknown,
): { instrument: string; liquidation: Liquidation }[] {
  const params = record(record(message)?.params)
  const channel = params?.channel
  if (typeof channel !== 'string' || !channel.startsWith('trades.')) return []
  const out: { instrument: string; liquidation: Liquidation }[] = []
  for (const raw of list(params?.data)) {
    const t = record(raw)
    const flag = t?.liquidation
    if (flag !== 'T' && flag !== 'M' && flag !== 'MT') continue
    const instrument = t?.instrument_name
    const price = num(t?.price)
    const amount = num(t?.amount)
    const time = num(t?.timestamp)
    const direction = t?.direction
    if (
      typeof instrument !== 'string' ||
      price === null ||
      price <= 0 ||
      amount === null ||
      amount <= 0 ||
      time === null ||
      (direction !== 'buy' && direction !== 'sell')
    )
      continue
    const takerSide = direction === 'sell' ? 'long' : 'short'
    const makerSide = takerSide === 'long' ? 'short' : 'long'
    const sides = flag === 'T' ? [takerSide] : flag === 'M' ? [makerSide] : [takerSide, makerSide]
    const linear = isDeribitLinear(instrument)
    for (const side of sides)
      out.push({
        instrument,
        liquidation: {
          venue: 'deribit',
          time: time / 1000,
          price,
          size: linear ? amount : amount / price,
          notional: linear ? amount * price : amount,
          side: side as 'long' | 'short',
        },
      })
  }
  return out
}

/** Gate.io `futures/usdt/contracts/<contract>`: base coins per contract. */
export function parseGateContract(
  payload: unknown,
): { contract: string; multiplier: number } | null {
  const r = record(payload)
  const multiplier = num(r?.quanto_multiplier)
  if (typeof r?.name !== 'string' || multiplier === null || multiplier <= 0) return null
  return { contract: r.name, multiplier }
}

/**
 * Gate.io `futures.public_liquidates` updates. `size` is signed contracts: negative is a long closed
 * out (seen live 2026-10-07: those print below the market, at the bankruptcy price), positive a
 * short. `time` is milliseconds. A contract whose multiplier is not loaded yet is skipped.
 */
export function parseGateLiquidations(
  message: unknown,
  multipliers: ReadonlyMap<string, number>,
): { contract: string; liquidation: Liquidation }[] {
  const r = record(message)
  if (r?.channel !== 'futures.public_liquidates' || r.event !== 'update') return []
  const out: { contract: string; liquidation: Liquidation }[] = []
  for (const raw of list(r.result)) {
    const x = record(raw)
    const contract = x?.contract
    const price = num(x?.price)
    const contracts = num(x?.size)
    const stamp = num(x?.time_ms ?? x?.time)
    if (typeof contract !== 'string' || price === null || price <= 0 || !contracts || !stamp)
      continue
    const multiplier = multipliers.get(contract)
    if (!multiplier) continue
    const size = Math.abs(contracts) * multiplier
    out.push({
      contract,
      liquidation: {
        venue: 'gate',
        time: stamp > 1e12 ? stamp / 1000 : stamp,
        price,
        size,
        notional: size * price,
        side: contracts < 0 ? 'long' : 'short',
      },
    })
  }
  return out
}

/**
 * Bitget v3 public `liquidation` topic: every USDT perpetual in one stream. `side` is the
 * liquidated position: `buy` a long (seen live: those print below the market). `amount` is the
 * USDT notional, not coins — an NMRUSDT print came with amount 16.329 at price 16.329, one coin.
 */
export function parseBitgetLiquidations(
  message: unknown,
): { symbol: string; liquidation: Liquidation }[] {
  const r = record(message)
  if (record(r?.arg)?.topic !== 'liquidation') return []
  const out: { symbol: string; liquidation: Liquidation }[] = []
  for (const raw of list(r?.data)) {
    const x = record(raw)
    const symbol = x?.symbol
    const price = num(x?.price)
    const notional = num(x?.amount)
    const stamp = num(x?.ts)
    const side =
      x?.side === 'buy' || x?.side === 'long'
        ? 'long'
        : x?.side === 'sell' || x?.side === 'short'
          ? 'short'
          : null
    if (
      typeof symbol !== 'string' ||
      price === null ||
      price <= 0 ||
      notional === null ||
      notional <= 0 ||
      stamp === null ||
      !side
    )
      continue
    out.push({
      symbol,
      liquidation: {
        venue: 'bitget',
        time: stamp / 1000,
        price,
        size: notional / price,
        notional,
        side,
      },
    })
  }
  return out
}

/** OKX `public/open-interest?instType=SWAP`: base-currency OI per instrument. */
export function parseOkxOpenInterest(payload: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of list(record(payload)?.data)) {
    const r = record(raw)
    const oi = num(r?.oiCcy)
    if (typeof r?.instId === 'string' && oi !== null && oi > 0) out.set(r.instId, oi)
  }
  return out
}

/** OKX `public/mark-price?instType=SWAP`. */
export function parseOkxMarks(payload: unknown): Map<string, number> {
  const out = new Map<string, number>()
  for (const raw of list(record(payload)?.data)) {
    const r = record(raw)
    const mark = num(r?.markPx)
    if (typeof r?.instId === 'string' && mark !== null && mark > 0) out.set(r.instId, mark)
  }
  return out
}

/** OKX `public/funding-rate`: the current period's rate, already per 8 hours for BTC/ETH. */
export function parseOkxFunding(payload: unknown): { rate8h: number } | null {
  const r = record(list(record(payload)?.data)[0])
  const rate = num(r?.fundingRate)
  const now = num(r?.fundingTime)
  const prev = num(r?.prevFundingTime)
  if (rate === null) return null
  // OKX moves some instruments to 4h or 1h settlement; scale those to an 8h equivalent.
  const hours = now !== null && prev !== null && now > prev ? (now - prev) / 3_600_000 : 8
  return { rate8h: (rate * 8) / Math.min(8, Math.max(1, hours)) }
}

/** OKX rubik `open-interest-history`: rows of [ts, oi, oiCcy, oiUsd], newest first. */
export function parseOkxOpenInterestHistory(payload: unknown): { time: number; value: number }[] {
  return list(record(payload)?.data).flatMap((row) => {
    const r = list(row)
    const time = num(r[0])
    const value = num(r[2])
    return time !== null && value !== null && value > 0 ? [{ time: time / 1000, value }] : []
  })
}

/** OKX `market/candles`: rows of [ts, o, h, l, c, ...], newest first. Closes only. */
export function parseOkxCandleCloses(payload: unknown): { time: number; value: number }[] {
  return list(record(payload)?.data).flatMap((row) => {
    const r = list(row)
    const time = num(r[0])
    const close = num(r[4])
    return time !== null && close !== null && close > 0 ? [{ time: time / 1000, value: close }] : []
  })
}

/**
 * Kraken Futures `tickers`: OI is in base units; `fundingRate` is absolute USD per hour. `last`
 * is the last trade and `lastTime` when it printed, seconds; a quiet book's last can be stale.
 */
export function parseKrakenTickers(payload: unknown) {
  const out = new Map<
    string,
    {
      openInterest: number
      mark: number
      rate8h: number | null
      last: number | null
      lastTime: number | null
    }
  >()
  for (const raw of list(record(payload)?.tickers)) {
    const r = record(raw)
    const symbol = r?.symbol
    const oi = num(r?.openInterest)
    const mark = num(r?.markPrice)
    const absolute = num(r?.fundingRate)
    const last = num(r?.last)
    const lastTime = typeof r?.lastTime === 'string' ? Date.parse(r.lastTime) / 1000 : NaN
    if (typeof symbol !== 'string' || oi === null || oi <= 0 || mark === null || mark <= 0) continue
    out.set(symbol, {
      openInterest: oi,
      mark,
      rate8h: absolute === null ? null : (absolute / mark) * 8,
      last: last !== null && last > 0 ? last : null,
      lastTime: Number.isFinite(lastTime) ? lastTime : null,
    })
  }
  return out
}

/**
 * Deribit `get_book_summary_by_currency`: inverse perpetual OI is in USD, linear USDC perpetual OI
 * in the base coin. `last` is the book's mid, falling back to the last trade: the mark is an
 * index-smoothed fair price that lags a fast move, which would read as spot leading every time.
 */
export function parseDeribitSummary(payload: unknown, instrument: string) {
  for (const raw of list(record(payload)?.result)) {
    const r = record(raw)
    if (r?.instrument_name !== instrument) continue
    const oi = num(r.open_interest)
    const mark = num(r.mark_price)
    const funding = num(r.funding_8h)
    const traded = num(r.mid_price) ?? num(r.last)
    if (oi === null || oi <= 0 || mark === null || mark <= 0) return null
    return {
      openInterest: isDeribitLinear(instrument) ? oi : oi / mark,
      mark,
      rate8h: funding,
      last: traded !== null && traded > 0 ? traded : null,
    }
  }
  return null
}

/** Every perpetual named in a Deribit book summary. */
export function parseDeribitPerpetuals(payload: unknown): Set<string> {
  const out = new Set<string>()
  for (const raw of list(record(payload)?.result)) {
    const name = record(raw)?.instrument_name
    if (typeof name === 'string' && name.endsWith('-PERPETUAL')) out.add(name)
  }
  return out
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Deribit expiry code (`9OCT26`) to its 08:00 UTC settlement, seconds. */
export function deribitExpiryTime(code: string): number | null {
  const match = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(code)
  if (!match) return null
  const month = MONTHS.indexOf(match[2])
  if (month < 0) return null
  return Date.UTC(2000 + Number(match[3]), month, Number(match[1]), 8) / 1000
}

/** The strike that minimizes what option holders are owed at settlement. */
function maxPain(rows: readonly { strike: number; call: boolean; oi: number }[]): number | null {
  const strikes = [...new Set(rows.map((r) => r.strike))]
  let best: number | null = null
  let bestPayout = Infinity
  for (const settle of strikes) {
    let payout = 0
    for (const r of rows)
      payout += r.oi * Math.max(0, r.call ? settle - r.strike : r.strike - settle)
    if (payout < bestPayout) {
      bestPayout = payout
      best = settle
    }
  }
  return best
}

/**
 * Deribit `get_book_summary_by_currency?kind=option`, one payload or several. Coin options are
 * `BTC-9OCT26-85000-C`; USDC options are `SOL_USDC-9OCT26-150-C`, with a `d` for the decimal point
 * in small strikes (`XRP_USDC-9OCT26-1d35-C`). `open_interest` is in the base coin for both, so a
 * coin's two books add up. Summarizes the expiries inside the horizon: open interest, put/call
 * ratio and max pain each, plus the largest strikes across them.
 */
export function parseDeribitOptions(
  payload: unknown,
  base: string,
  now: number,
  horizonDays = OPTIONS_HORIZON_DAYS,
): OptionsPositioning | null {
  const until = now + horizonDays * 86400
  const byExpiry = new Map<
    string,
    { time: number; rows: { strike: number; call: boolean; oi: number }[] }
  >()
  let underlying: number | null = null
  let soonest = Infinity
  const rows = (Array.isArray(payload) ? payload : [payload]).flatMap((p) =>
    list(record(p)?.result),
  )
  for (const raw of rows) {
    const r = record(raw)
    const name = r?.instrument_name
    if (typeof name !== 'string') continue
    const parts = name.split('-')
    if (parts.length !== 4 || (parts[0] !== base && parts[0] !== `${base}_USDC`)) continue
    const time = deribitExpiryTime(parts[1])
    const strike = num(parts[2].replace('d', '.'))
    const call = parts[3] === 'C'
    const oi = num(r?.open_interest)
    if (time === null || time <= now || time > until) continue
    if (strike === null || strike <= 0 || (!call && parts[3] !== 'P') || oi === null || oi < 0)
      continue
    const spot = num(r?.estimated_delivery_price) ?? num(r?.underlying_price)
    if (spot !== null && spot > 0 && time < soonest) {
      soonest = time
      underlying = spot
    }
    const expiry = byExpiry.get(parts[1]) ?? { time, rows: [] }
    expiry.rows.push({ strike, call, oi })
    byExpiry.set(parts[1], expiry)
  }
  if (!byExpiry.size) return null
  const strikes = new Map<number, OptionsStrike>()
  const expiries: OptionsExpiry[] = [...byExpiry.entries()]
    .sort((a, b) => a[1].time - b[1].time)
    .map(([code, { time, rows }]) => {
      let calls = 0,
        puts = 0
      for (const row of rows) {
        if (row.call) calls += row.oi
        else puts += row.oi
        const strike = strikes.get(row.strike) ?? { strike: row.strike, callOi: 0, putOi: 0 }
        if (row.call) strike.callOi += row.oi
        else strike.putOi += row.oi
        strikes.set(row.strike, strike)
      }
      return {
        code,
        time,
        openInterest: calls + puts,
        putCall: calls > 0 ? puts / calls : null,
        maxPain: calls + puts > 0 ? maxPain(rows) : null,
      }
    })
  return {
    venue: 'deribit',
    asOf: now,
    underlying,
    horizonDays,
    expiries: expiries.slice(0, MAX_OPTION_EXPIRIES),
    strikes: [...strikes.values()]
      .filter((s) => s.callOi + s.putOi > 0)
      .sort((a, b) => b.callOi + b.putOi - (a.callOi + a.putOi))
      .slice(0, MAX_OPTION_STRIKES)
      .sort((a, b) => a.strike - b.strike),
  }
}

/** Kraken `charts/v1/analytics/<symbol>/open-interest`: [open, high, low, close] per bar. */
export function parseKrakenOpenInterestHistory(
  payload: unknown,
): { time: number; open: number; close: number }[] {
  const result = record(record(payload)?.result)
  const times = list(result?.timestamp)
  const data = list(result?.data)
  return times.flatMap((t, i) => {
    const time = num(t)
    const row = list(data[i])
    const open = num(row[0])
    const close = num(row[3])
    return time !== null && open !== null && open > 0 && close !== null && close > 0
      ? [{ time, open, close }]
      : []
  })
}

/** Kraken `charts/v1/trade/<symbol>/5m`: candles with millisecond times. Closes only. */
export function parseKrakenCandleCloses(payload: unknown): { time: number; value: number }[] {
  return list(record(payload)?.candles).flatMap((raw) => {
    const r = record(raw)
    const time = num(r?.time)
    const close = num(r?.close)
    return time !== null && close !== null && close > 0 ? [{ time: time / 1000, value: close }] : []
  })
}

/** Hyperliquid `metaAndAssetCtxs`: [meta, ctxs]; OI in base units, funding hourly. */
export function parseHyperliquidContexts(payload: unknown) {
  const out = new Map<string, { openInterest: number; mark: number; rate8h: number | null }>()
  const [meta, ctxs] = list(payload)
  const universe = list(record(meta)?.universe)
  const contexts = list(ctxs)
  universe.forEach((asset, i) => {
    const name = record(asset)?.name
    const ctx = record(contexts[i])
    const oi = num(ctx?.openInterest)
    const mark = num(ctx?.markPx)
    const funding = num(ctx?.funding)
    if (typeof name !== 'string' || oi === null || oi <= 0 || mark === null || mark <= 0) return
    out.set(name, { openInterest: oi, mark, rate8h: funding === null ? null : funding * 8 })
  })
  return out
}

/** Coinbase International `instruments/<symbol>`: OI in base units. */
export function parseCoinbaseIntlInstrument(payload: unknown) {
  const r = record(payload)
  const oi = num(r?.open_interest)
  const mark = num(record(r?.quote)?.mark_price)
  if (oi === null || oi <= 0 || mark === null || mark <= 0) return null
  return { openInterest: oi, mark }
}

/* ------------------------------------------------------------------------------------------ */
/* Transport guard                                                                              */
/* ------------------------------------------------------------------------------------------ */

const finiteOrNull = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v))
const finiteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

const isLiquidation = (value: unknown): value is Liquidation => {
  const l = record(value)
  return (
    !!l &&
    LIQUIDATION_VENUES.includes(l.venue as LiquidationVenue) &&
    (l.side === 'long' || l.side === 'short') &&
    [l.time, l.price, l.size, l.notional].every(finiteNumber) &&
    (l.price as number) > 0 &&
    (l.notional as number) > 0
  )
}

const isForcedEvent = (value: unknown): value is ForcedEvent => {
  const e = record(value)
  return (
    !!e &&
    typeof e.id === 'string' &&
    (e.state === 'longs-liquidating' || e.state === 'shorts-liquidating') &&
    [e.start, e.end, e.price, e.priceChange, e.liquidatedUsd].every(finiteNumber) &&
    finiteOrNull(e.oiChange) &&
    (e.price as number) > 0 &&
    (e.history === undefined || typeof e.history === 'boolean')
  )
}

const isSpotVsPerps = (value: unknown): value is SpotVsPerps => {
  const s = record(value)
  return (
    !!s &&
    [s.boughtUsd, s.soldUsd].every(finiteNumber) &&
    [s.priceChange, s.premium, s.premiumChange].every(finiteOrNull) &&
    (s.leader === null || s.leader === 'spot' || s.leader === 'perps' || s.leader === 'together') &&
    Array.isArray(s.perpVenues) &&
    s.perpVenues.every((v) => DERIVATIVES_VENUES.includes(v))
  )
}

const isOptionsPositioning = (value: unknown): value is OptionsPositioning => {
  const o = record(value)
  return (
    !!o &&
    o.venue === 'deribit' &&
    finiteNumber(o.asOf) &&
    finiteNumber(o.horizonDays) &&
    finiteOrNull(o.underlying) &&
    Array.isArray(o.expiries) &&
    o.expiries.length <= 20 &&
    o.expiries.every((raw) => {
      const e = record(raw)
      return (
        !!e &&
        typeof e.code === 'string' &&
        [e.time, e.openInterest].every(finiteNumber) &&
        [e.putCall, e.maxPain].every(finiteOrNull)
      )
    }) &&
    Array.isArray(o.strikes) &&
    o.strikes.length <= 50 &&
    o.strikes.every((raw) => {
      const s = record(raw)
      return !!s && [s.strike, s.callOi, s.putOi].every(finiteNumber)
    })
  )
}

export const isForcedFlow = (value: unknown): value is ForcedFlow => {
  const f = record(value)
  if (!f) return false
  const t = record(f.thresholds)
  const l = record(f.liquidations)
  const funding = record(f.funding)
  const feeds = record(f.feeds)
  return (
    typeof f.product === 'string' &&
    FORCED_STATES.includes(f.state as ForcedState) &&
    finiteNumber(f.asOf) &&
    finiteNumber(f.windowSeconds) &&
    [f.priceChange, f.oiChange, f.openInterest, f.mark].every(finiteOrNull) &&
    Array.isArray(f.oiVenues) &&
    f.oiVenues.every((v) => DERIVATIVES_VENUES.includes(v)) &&
    !!t &&
    [t.move, t.oiDrop, t.oiRise].every(finiteOrNull) &&
    finiteNumber(t.samples) &&
    typeof t.calibrated === 'boolean' &&
    !!l &&
    [l.longUsd, l.shortUsd, l.longUsd5m, l.shortUsd5m, l.burstSeconds].every(finiteNumber) &&
    Array.isArray(l.recent) &&
    l.recent.length <= 50 &&
    l.recent.every(isLiquidation) &&
    (l.last === undefined ||
      l.last === null ||
      (LIQUIDATION_VENUES.includes(record(l.last)?.venue as LiquidationVenue) &&
        finiteNumber(record(l.last)?.time))) &&
    !!funding &&
    finiteOrNull(funding.rate8h) &&
    Array.isArray(funding.venues) &&
    (funding.crowded === null || funding.crowded === 'longs' || funding.crowded === 'shorts') &&
    !!feeds &&
    Object.entries(feeds).every(
      ([venue, state]) =>
        LIQUIDATION_VENUES.includes(venue as LiquidationVenue) &&
        (state === 'live' || state === 'connecting' || state === 'down'),
    ) &&
    Array.isArray(f.events) &&
    f.events.length <= 100 &&
    f.events.every(isForcedEvent) &&
    (f.spot === undefined || isSpotVsPerps(f.spot)) &&
    (f.options === undefined || f.options === null || isOptionsPositioning(f.options)) &&
    (f.history === undefined ||
      (Array.isArray(f.history) && f.history.length <= 500 && f.history.every(isForcedEvent)))
  )
}

/** "+0.42%" / "-1.10%" for a fraction. */
export const formatChange = (fraction: number | null, digits = 2): string =>
  fraction === null || !Number.isFinite(fraction)
    ? '—'
    : `${fraction > 0 ? '+' : fraction < 0 ? '-' : ''}${Math.abs(fraction * 100).toFixed(digits)}%`
