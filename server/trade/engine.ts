/**
 * cryptoanal's Kalshi trading engine, for the phone's quick-trade circles.
 *
 * Built on btcAnalyzerV2's rules (fees, the price grid, cash per exchange, never selling under the
 * floor) but run on push instead of polls:
 *
 * - Kalshi's WebSocket keeps each watched round's order book here, live. A buy needs no reads
 *   first: its price comes from the book already in memory, and the cash on the market's exchange
 *   from the last balance, so the tap costs one round trip to Kalshi. (A key without the stream
 *   falls back to reading the book every second.)
 * - Fills, positions and orders arrive on the same stream and refresh the holding at once.
 * - A target is checked on every change of the book, not on a timer: the moment buyers pay it,
 *   everything sells to them, never under the target.
 * - Every buy starts a trailing sell, checked the same way: it follows the highest bid since, and
 *   once buyers pay 5% under it, everything sells to them, never at a loss after fees.
 * - Every change is pushed to the phone (server-sent events), so its circles show what Kalshi shows.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import {
  LiveBook,
  NOW_SLIPPAGE_MILLS,
  TAKER_FEE,
  breakEvenMills,
  buyCostDollars,
  contractsFor,
  formatCents,
  isOutcome,
  millsToDollars,
  newClientOrderId,
  onGrid,
  parseBalance,
  parseBalanceBreakdown,
  parseFeeMultiplier,
  parseFeeType,
  parseOrders,
  parsePosition,
  pickRunningMarket,
  priceTicks,
  reducesPosition,
  seriesChargesMakers,
  snapDown,
  snapUp,
  toTradeMarket,
  toV2Order,
  trailFires,
  type OrderIntent,
  type TradeEnv,
  type TradeMarket,
  type TradeOrder,
  type TradeOutcome,
  type TradePosition,
  type TradeResult,
  type TradeState,
  type TradeTarget,
} from '../../src/trade/kalshiTrade'
import { historyRounds, historyTotals, parseFills, parseSettlements, type TradeHistory } from '../../src/trade/history'
import { QUICK_TRAIL_PCT } from '../../src/trade/quick'
import { KALSHI_SERIES } from '../kalshi'
import { KalshiRest, KalshiStream, TradeError } from './kalshi'
import type { KalshiKeyStore, ResolvedKeys } from './keys'

/** History read again after this long, ms (a fill on the account reads it at once). */
const HISTORY_TTL_MS = 30_000
/** Pages of 1000 fills read at most for one history. */
const HISTORY_MAX_PAGES = 10
/** A coin nobody has looked at for this long stops being watched. */
const FEED_IDLE_MS = 60_000
/** Without the stream, the book is read this often. */
const POLL_BOOK_MS = 1_000
/** The holding is read again this often even with no news (the stream's events are the fast path). */
const PORTFOLIO_SAFETY_MS = { stream: 5_000, poll: 2_000 }
/** Kalshi allows one balance read a second per account. */
const BALANCE_GAP_MS = 1_100
const BALANCE_REFRESH_MS = 10_000
const SERIES_TTL_MS = 3_600_000
const FUNDS_WAIT_MS = 8_000
const FUNDS_POLL_MS = 400
const MAX_DOLLARS = 5_000
const TICK_MS = 500

interface Feed {
  product: string
  series: string
  /** The running round (prices are read from `book`). */
  market: TradeMarket | null
  book: LiveBook
  /** When the book last changed, ms; 0 before it was read. */
  bookAt: number
  /** The stream has sent this round's snapshot, so the book is live. */
  streamed: boolean
  wantedAt: number
  loading: Promise<void> | null
  reload: ReturnType<typeof setTimeout> | null
  polling: boolean
  problem: string
}

interface Portfolio {
  position: TradePosition | null
  orders: TradeOrder[]
  /** When the read was sent, ms: a read sent before a buy may answer after it, without it. */
  at: number
}

interface Balance {
  total: number | null
  breakdown: Map<number, number>
  /** When the read started, ms. */
  at: number
}

interface Account {
  env: TradeEnv
  rest: KalshiRest
  stream: KalshiStream | null
  feeds: Map<string, Feed>
  portfolios: Map<string, Portfolio>
  portfolioLoads: Map<string, Promise<Portfolio>>
  portfolioAgain: Set<string>
  balance: Balance | null
  balanceLoad: { at: number; promise: Promise<Balance> } | null
  balanceLast: number
  /** Rounds with a sale in flight: one at a time, so a target and Sell now never both sell. */
  selling: Set<string>
  accountNews: ReturnType<typeof setTimeout> | null
  /** Histories read, by period start; dropped when the account trades. */
  histories: Map<number, { at: number; promise: Promise<TradeHistory> }>
}

interface WorkingTarget extends TradeTarget {
  product: string
  /** Not before this time again, after a sale that failed or left some. */
  retryAt?: number
  /** When it started, ms: only holdings read after it count (before, a buy may not show yet). */
  startedAt?: number
}

/** What the phone and the file see of a working target: no server bookkeeping. */
const shown = ({ product: _product, retryAt: _retryAt, startedAt: _startedAt, ...target }: WorkingTarget): TradeTarget => target

const word = (outcome: TradeOutcome) => (outcome === 'up' ? 'Up' : 'Down')
const count$ = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const productOfTicker = (ticker: string) => Object.entries(KALSHI_SERIES).find(([, s]) => ticker.startsWith(`${s.series}-`))?.[0] ?? null

/** What an order did, in words: "Bought 10 Up at 52¢ avg", "Nothing filled: no sellers at 54¢ or better". */
function fillMessage(intent: OrderIntent, filled: number, remaining: number, avg: number | null): string {
  const what = word(intent.outcome)
  if (filled > 0)
    return `${intent.action === 'buy' ? 'Bought' : 'Sold'} ${count$(filled)} ${what}${avg !== null ? ` at ${formatCents(avg)} avg` : ''}${remaining > 0 ? ` · ${count$(remaining)} not filled` : ''}`
  return `Nothing filled: no ${intent.action === 'buy' ? 'sellers' : 'buyers'} at ${formatCents(intent.mills)} or better`
}

export class TradeEngine {
  private keys: ResolvedKeys
  private accounts: Record<TradeEnv, Account>
  private series = new Map<string, { multiplier: number; makerFees: boolean; at: number }>()
  private targets = new Map<string, WorkingTarget>()
  private targetsDone: TradeTarget[] = []
  /** A trailing sell's high moved since the file was written (saved on the next tick). */
  private highsMoved = false
  private listeners = new Set<(env: TradeEnv) => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private saving: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: KalshiKeyStore,
    private readonly targetsFile: string | null,
    private readonly log: (line: string) => void = (line) => console.log(line),
    fetcher: typeof fetch = fetch,
  ) {
    this.keys = store.resolve()
    const account = (env: TradeEnv): Account => ({
      env,
      rest: new KalshiRest(env, this.keys[env], fetcher, log),
      stream: null,
      feeds: new Map(),
      portfolios: new Map(),
      portfolioLoads: new Map(),
      portfolioAgain: new Set(),
      balance: null,
      balanceLoad: null,
      balanceLast: 0,
      selling: new Set(),
      accountNews: null,
      histories: new Map(),
    })
    this.accounts = { demo: account('demo'), live: account('live') }
    this.loadTargets()
  }

  // ── Keys ────────────────────────────────────────────────────────────────────────────────────

  get keysView() {
    return this.keys.view
  }

  /** Read the key settings again (after ⚙ changed them): new keys reconnect the stream. */
  reloadKeys(): void {
    this.keys = this.store.resolve()
    for (const acc of Object.values(this.accounts)) {
      const creds = this.keys[acc.env]
      if (acc.rest.creds?.keyId === creds?.keyId && !!acc.rest.creds === !!creds) continue
      acc.rest.creds = creds
      acc.stream?.close()
      acc.stream = null
      acc.balance = null
      acc.portfolios.clear()
      this.syncStream(acc)
    }
    this.notify('demo')
    this.notify('live')
  }

  private setup(env: TradeEnv): string | null {
    const status = this.keys.view[env]
    if (status.error) return `The ${env} key does not work: ${status.error}`
    if (!this.keys[env])
      return env === 'demo' ? 'Demo is not connected: add your demo key on the computer, in ⚙ → Kalshi trading.' : 'Live is not connected: add your Kalshi key on the computer, in ⚙ → Kalshi trading.'
    if (env === 'live' && !this.keys.liveEnabled) return 'Real-money orders are off. Turn them on on the computer, in ⚙ → Kalshi trading.'
    return null
  }

  private requireTrading(env: TradeEnv): void {
    const setup = this.setup(env)
    if (setup) throw new TradeError(403, setup, 'NO_TRADING')
  }

  // ── Listeners and the housekeeping tick ─────────────────────────────────────────────────────

  /** Called with the environment whenever something there changed. */
  subscribe(listener: (env: TradeEnv) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(env: TradeEnv): void {
    for (const listener of this.listeners) listener(env)
  }

  private ensureTick(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
  }

  private tick(): void {
    const now = Date.now()
    for (const target of [...this.targets.values()]) {
      if (now >= target.closesAt)
        this.finishTarget(
          target,
          'ended',
          target.kind === 'trail'
            ? 'The round ended without the trailing sell going off: what is held settles at $1 or $0.'
            : `The round ended with the target at ${formatCents(target.topMills)} not reached: what is held settles at $1 or $0.`,
        )
      else this.feed(this.accounts[target.env], target.product).wantedAt = now
    }
    if (this.highsMoved) {
      this.highsMoved = false
      this.saveTargets()
    }
    let active = false
    for (const acc of Object.values(this.accounts)) {
      for (const feed of [...acc.feeds.values()]) {
        if (now - feed.wantedAt > FEED_IDLE_MS) {
          this.dropFeed(acc, feed)
          continue
        }
        active = true
        const ticker = feed.market?.ticker
        if (!ticker) continue
        if (!feed.streamed && now - feed.bookAt >= POLL_BOOK_MS) void this.pollBook(acc, feed)
        if (acc.rest.creds) {
          const held = acc.portfolios.get(ticker)
          const every = acc.stream?.open ? PORTFOLIO_SAFETY_MS.stream : PORTFOLIO_SAFETY_MS.poll
          if (!held || now - held.at > every) void this.refreshPortfolio(acc, ticker).catch(() => undefined)
          if (!acc.balance || now - acc.balance.at > BALANCE_REFRESH_MS) void this.readBalance(acc, now - BALANCE_REFRESH_MS).then(() => this.notify(acc.env), () => undefined)
          this.checkHeld(acc, ticker)
        }
      }
    }
    if (!active && !this.targets.size && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  // ── Markets and books ───────────────────────────────────────────────────────────────────────

  private feed(acc: Account, product: string): Feed {
    let feed = acc.feeds.get(product)
    if (!feed) {
      const series = KALSHI_SERIES[product]?.series
      if (!series) throw new TradeError(404, 'Kalshi runs no 15-minute market on this coin.', 'NO_SERIES')
      feed = { product, series, market: null, book: new LiveBook(), bookAt: 0, streamed: false, wantedAt: Date.now(), loading: null, reload: null, polling: false, problem: '' }
      acc.feeds.set(product, feed)
      feed.loading = this.loadMarket(acc, feed)
      this.ensureTick()
    }
    return feed
  }

  private dropFeed(acc: Account, feed: Feed): void {
    if (feed.reload) clearTimeout(feed.reload)
    acc.feeds.delete(feed.product)
    if (feed.market) acc.portfolios.delete(feed.market.ticker)
    this.syncStream(acc)
  }

  private async seriesInfo(acc: Account, series: string) {
    const key = `${acc.env}:${series}`
    const hit = this.series.get(key)
    if (hit && Date.now() - hit.at < SERIES_TTL_MS) return hit
    const raw = await acc.rest.call('GET', `/series/${encodeURIComponent(series)}`, { authed: false }).catch(() => null)
    const info = { multiplier: parseFeeMultiplier(raw), makerFees: seriesChargesMakers(parseFeeType(raw)), at: raw ? Date.now() : 0 }
    this.series.set(key, info)
    return info
  }

  /** Find the running round (by close time: Kalshi's `status=open` listing lags a new round). */
  private async loadMarket(acc: Account, feed: Feed): Promise<void> {
    if (feed.reload) clearTimeout(feed.reload)
    feed.reload = null
    let next = 2_000
    try {
      const nowSec = Math.floor(Date.now() / 1000)
      const [list, info] = await Promise.all([
        acc.rest.call(
          'GET',
          `/markets?${new URLSearchParams({ series_ticker: feed.series, min_close_ts: String(nowSec), max_close_ts: String(nowSec + 20 * 60), limit: '20' })}`,
          { authed: false },
        ),
        this.seriesInfo(acc, feed.series),
      ])
      if (acc.feeds.get(feed.product) !== feed) return
      const row = pickRunningMarket(list, nowSec)
      const market = row ? toTradeMarket(row, info.multiplier, info.makerFees) : null
      if (market?.ticker !== feed.market?.ticker) {
        feed.book = new LiveBook()
        feed.bookAt = 0
        feed.streamed = false
      }
      feed.market = market
      feed.problem = market ? '' : 'Waiting for the next round…'
      if (market) next = Math.max(250, market.close * 1000 - Date.now() + 250)
      this.syncStream(acc)
      if (market && !feed.streamed) await this.pollBook(acc, feed)
      if (market && acc.rest.creds) void this.refreshPortfolio(acc, market.ticker).catch(() => undefined)
    } catch (error) {
      feed.problem = error instanceof Error ? error.message : 'Kalshi did not answer.'
      next = 3_000
    } finally {
      feed.loading = null
      if (acc.feeds.get(feed.product) === feed)
        feed.reload = setTimeout(() => {
          feed.loading = this.loadMarket(acc, feed)
        }, next)
      this.notify(acc.env)
    }
  }

  /** Read the book over REST: before the stream's snapshot, without a stream, or when a delta made no sense. */
  private async pollBook(acc: Account, feed: Feed): Promise<void> {
    const ticker = feed.market?.ticker
    if (!ticker || feed.polling) return
    feed.polling = true
    try {
      const raw = await acc.rest.call('GET', `/markets/${encodeURIComponent(ticker)}/orderbook`, { authed: false })
      // The stream may have caught up meanwhile; its book is newer.
      if (feed.market?.ticker !== ticker || feed.streamed) return
      if (feed.book.fromRest(raw)) {
        feed.bookAt = Date.now()
        this.bookChanged(acc, feed)
      }
    } catch {
      // Kept as it was; the next tick tries again.
    } finally {
      feed.polling = false
    }
  }

  private bookChanged(acc: Account, feed: Feed): void {
    this.notify(acc.env)
    this.checkTargets(acc, feed)
  }

  private syncStream(acc: Account): void {
    const tickers = [...acc.feeds.values()].flatMap((f) => (f.market ? [f.market.ticker] : []))
    if (!acc.rest.creds || !tickers.length) {
      acc.stream?.close()
      return
    }
    if (!acc.stream) {
      acc.stream = new KalshiStream(
        acc.env,
        acc.rest.creds,
        {
          book: (ticker, type, msg) => {
            const feed = [...acc.feeds.values()].find((f) => f.market?.ticker === ticker)
            if (!feed) return
            if (type === 'snapshot') {
              feed.book.snapshot(msg)
              feed.streamed = true
            } else if (!feed.streamed) return
            else if (!feed.book.delta(msg)) {
              feed.streamed = false
              return void this.pollBook(acc, feed)
            }
            feed.bookAt = Date.now()
            this.bookChanged(acc, feed)
          },
          account: () => {
            // A burst of fills is one refresh.
            acc.histories.clear()
            if (acc.accountNews) return
            acc.accountNews = setTimeout(() => {
              acc.accountNews = null
              for (const feed of acc.feeds.values()) if (feed.market) void this.refreshPortfolio(acc, feed.market.ticker).catch(() => undefined)
              void this.readBalance(acc, Date.now()).then(() => this.notify(acc.env), () => undefined)
            }, 40)
          },
          status: (open) => {
            if (!open) for (const feed of acc.feeds.values()) feed.streamed = false
            this.log(`[trade] ${acc.env} stream ${open ? 'connected: prices and fills are pushed' : 'closed'}`)
            this.notify(acc.env)
          },
        },
        this.log,
      )
    }
    acc.stream.watch(tickers)
  }

  // ── The account ─────────────────────────────────────────────────────────────────────────────

  /** The holding and resting orders in a round; concurrent reads share one, and news during it reads again. */
  private refreshPortfolio(acc: Account, ticker: string): Promise<Portfolio> {
    const running = acc.portfolioLoads.get(ticker)
    if (running) {
      acc.portfolioAgain.add(ticker)
      return running
    }
    const load = (async () => {
      const at = Date.now()
      const [positions, orders] = await Promise.all([
        acc.rest.call('GET', `/portfolio/positions?${new URLSearchParams({ ticker })}`),
        acc.rest.call('GET', `/portfolio/orders?${new URLSearchParams({ ticker, status: 'resting' })}`),
      ])
      const portfolio = { position: parsePosition(positions, ticker), orders: parseOrders(orders), at }
      acc.portfolios.set(ticker, portfolio)
      return portfolio
    })().finally(() => {
      acc.portfolioLoads.delete(ticker)
      this.notify(acc.env)
      if (acc.portfolioAgain.delete(ticker)) void this.refreshPortfolio(acc, ticker).catch(() => undefined)
    })
    acc.portfolioLoads.set(ticker, load)
    return load
  }

  /** The cash, read no earlier than `minAt` (ms); one read a second at most, as Kalshi allows. */
  private async readBalance(acc: Account, minAt: number): Promise<Balance> {
    if (acc.balance && acc.balance.at >= minAt) return acc.balance
    if (acc.balanceLoad) {
      if (acc.balanceLoad.at >= minAt) return acc.balanceLoad.promise
      await acc.balanceLoad.promise.catch(() => undefined)
      return this.readBalance(acc, minAt)
    }
    const wait = acc.balanceLast + BALANCE_GAP_MS - Date.now()
    const at = Date.now() + Math.max(0, wait)
    const promise = (async () => {
      if (wait > 0) await sleep(wait)
      acc.balanceLast = Date.now()
      const raw = await acc.rest.call('GET', '/portfolio/balance')
      return (acc.balance = { total: parseBalance(raw), breakdown: parseBalanceBreakdown(raw), at })
    })().finally(() => {
      acc.balanceLoad = null
    })
    acc.balanceLoad = { at, promise }
    return promise
  }

  /**
   * Kalshi keeps cash per exchange, and an order only spends cash already on its market's exchange
   * (crypto is #2). Moves the shortfall over from the exchanges holding the most, then waits for it
   * to land. Answers the dollars moved (0 when it was already there).
   */
  private async ensureFunds(acc: Account, index: number, needed: number): Promise<number> {
    const before = (await this.readBalance(acc, Date.now())).breakdown
    if (!before.size) return 0
    const have = before.get(index) ?? 0
    if (have >= needed - 1e-9) return 0
    const shortfall = Math.ceil((needed - have) * 100 - 1e-6) / 100
    const sources = [...before.entries()].filter(([source, dollars]) => source !== index && dollars > 0).sort((a, b) => b[1] - a[1])
    const spare = sources.reduce((sum, [, dollars]) => sum + dollars, 0)
    if (have + spare < needed - 1e-9) throw new TradeError(409, `Not enough cash: this needs $${needed.toFixed(2)} and the account has $${(have + spare).toFixed(2)}.`, 'NO_CASH')
    let left = shortfall
    for (const [source, dollars] of sources) {
      if (left <= 0) break
      const amount = Math.min(left, Math.floor(dollars * 100) / 100)
      if (amount <= 0) continue
      await acc.rest.call('POST', '/portfolio/intra_exchange_instance_transfer', {
        body: {
          source: 'event_contract',
          destination: 'event_contract',
          // Centicents: $1.00 = 10,000.
          amount: Math.round(amount * 10_000),
          source_exchange_shard: source,
          destination_exchange_shard: index,
          client_transfer_id: randomUUID(),
        },
      })
      this.log(`[trade] ${acc.env} moved $${amount.toFixed(2)} from exchange #${source} to #${index}`)
      left = Math.round((left - amount) * 100) / 100
    }
    const deadline = Date.now() + FUNDS_WAIT_MS
    for (;;) {
      if (((await this.readBalance(acc, Date.now())).breakdown.get(index) ?? 0) >= needed - 1e-9) return shortfall
      if (Date.now() >= deadline) throw new TradeError(504, `Moved $${shortfall.toFixed(2)} to the crypto exchange, but it has not arrived yet. Try again in a moment.`, 'FUNDS_PENDING')
      await sleep(FUNDS_POLL_MS)
    }
  }

  private async submit(acc: Account, intent: OrderIntent): Promise<TradeResult> {
    const result = (await acc.rest.call('POST', '/portfolio/events/orders', { body: toV2Order(intent) })) as Record<string, unknown> | null
    const filled = Number(result?.fill_count ?? 0) || 0
    const remaining = Number(result?.remaining_count ?? 0) || 0
    const avgYes = Number(result?.average_fill_price)
    const avgFillMills = filled > 0 && Number.isFinite(avgYes) && avgYes > 0 ? (intent.outcome === 'up' ? avgYes * 1000 : 1000 - avgYes * 1000) : null
    const message = fillMessage(intent, filled, remaining, avgFillMills)
    this.log(`[trade] ${acc.env} ${intent.action} ${count$(intent.count)} ${word(intent.outcome)} @ ${formatCents(intent.mills)} ${intent.ticker} → ${message}`)
    return { ok: true, message, filled, avgFillMills }
  }

  private cancelOrder(acc: Account, ticker: string, orderId: string): Promise<unknown> {
    return acc.rest.call('DELETE', `/portfolio/events/orders/${encodeURIComponent(orderId)}?${new URLSearchParams({ market_ticker: ticker })}`)
  }

  /** After an order: the holding and the cash read again (the stream usually says so first). */
  private afterOrder(acc: Account, ticker: string): void {
    acc.histories.clear()
    void this.refreshPortfolio(acc, ticker).catch(() => undefined)
    void this.readBalance(acc, Date.now()).then(() => this.notify(acc.env), () => undefined)
  }

  /** The round an order names: the one running now on a watched coin. */
  private async running(env: TradeEnv, ticker: unknown): Promise<{ acc: Account; feed: Feed; market: TradeMarket }> {
    if (typeof ticker !== 'string' || !ticker) throw new TradeError(400, 'The order has no market.', 'BAD_ORDER')
    const product = productOfTicker(ticker)
    if (!product) throw new TradeError(400, 'That is not a 15-minute crypto market.', 'BAD_ORDER')
    const acc = this.accounts[env]
    const feed = this.feed(acc, product)
    feed.wantedAt = Date.now()
    if (feed.loading) await feed.loading
    if (!feed.market || feed.market.ticker !== ticker) throw new TradeError(409, 'That round has ended. The circles have moved on to the next one.', 'ROUND_OVER')
    return { acc, feed, market: feed.market }
  }

  // ── Orders ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Buy `dollars` of Up or Down now: immediate or cancel, up to 2¢ over the ask but never over the
   * price the phone showed (`maxMills`), fee included in the amount.
   */
  async buy(env: TradeEnv, raw: Record<string, unknown>): Promise<TradeResult> {
    const started = Date.now()
    this.requireTrading(env)
    const { outcome, dollars, maxMills } = raw
    if (!isOutcome(outcome)) throw new TradeError(400, 'Choose Up or Down.', 'BAD_ORDER')
    if (typeof dollars !== 'number' || !(dollars >= 1) || dollars > MAX_DOLLARS) throw new TradeError(400, `Buy between $1 and $${MAX_DOLLARS.toLocaleString('en-US')}.`, 'BAD_ORDER')
    const { acc, feed, market } = await this.running(env, raw.ticker)
    const ticks = priceTicks(market.bands)
    if (!feed.bookAt || (!feed.streamed && Date.now() - feed.bookAt > 1_500)) await this.pollBook(acc, feed)
    const prices = feed.book.prices()
    const ask = outcome === 'up' ? prices.upAsk : prices.downAsk
    if (ask === null) throw new TradeError(409, `Nobody is selling ${word(outcome)} right now.`, 'NO_ASK')
    const cap = Math.max(ask, snapDown(Math.min(999, ask + NOW_SLIPPAGE_MILLS), ticks) ?? ask)
    const shown = typeof maxMills === 'number' && onGrid(outcome, maxMills, ticks) ? maxMills : null
    const mills = shown !== null ? Math.min(shown, cap) : cap
    if (!onGrid(outcome, mills, ticks)) throw new TradeError(400, `${formatCents(mills)} is not a price this market takes.`, 'BAD_PRICE')
    const coefficient = TAKER_FEE * market.feeMultiplier
    const count = contractsFor(dollars, mills, coefficient)
    if (count < 1) throw new TradeError(400, `$${dollars.toFixed(2)} does not buy one contract at ${formatCents(mills)}.`, 'BAD_ORDER')
    const cost = buyCostDollars(count, mills, coefficient)
    // The cash on the crypto exchange, as last read: short, move it first; unknown, just send.
    const fresh = acc.balance && acc.balance.breakdown.size && Date.now() - acc.balance.at < 30_000 ? acc.balance : null
    let moved = fresh && (fresh.breakdown.get(market.exchangeIndex) ?? 0) < cost - 1e-9 ? await this.ensureFunds(acc, market.exchangeIndex, cost) : 0
    const intent: OrderIntent = { ticker: market.ticker, outcome, action: 'buy', mills, count, timeInForce: 'immediate_or_cancel', clientOrderId: newClientOrderId('buy') }
    let result: TradeResult
    try {
      result = await this.submit(acc, intent)
    } catch (error) {
      // The cash was elsewhere after all: move it and go once more.
      if (moved || !(error instanceof TradeError) || !/shard balance|exchange user not found|insufficient/i.test(error.message)) throw error
      moved = await this.ensureFunds(acc, market.exchangeIndex, cost)
      if (!moved) throw error
      result = await this.submit(acc, { ...intent, clientOrderId: newClientOrderId('buy') })
    }
    if ((result.filled ?? 0) > 0) this.startTrail(acc, feed, market, outcome)
    this.afterOrder(acc, market.ticker)
    return { ...result, message: moved ? `Moved $${moved.toFixed(2)} to the crypto exchange · ${result.message}` : result.message, ms: Date.now() - started }
  }

  /**
   * Sell the whole holding now, to the best buyers, no lower than the floor the phone showed
   * (`minMills`; else 2¢ under the bid). Resting sells against the holding go first so they cannot
   * fill later; if nothing sells, they are put back.
   */
  async sellNow(env: TradeEnv, raw: Record<string, unknown>): Promise<TradeResult> {
    const started = Date.now()
    this.requireTrading(env)
    const { acc, feed, market } = await this.running(env, raw.ticker)
    if (acc.selling.has(market.ticker)) throw new TradeError(409, 'A sale is already going out. One moment.', 'BUSY')
    acc.selling.add(market.ticker)
    try {
      const held = acc.portfolios.get(market.ticker)
      const portfolio = held?.position && Date.now() - held.at < (acc.stream?.open ? 10_000 : 1_500) ? held : await this.refreshPortfolio(acc, market.ticker)
      const position = portfolio.position
      if (!position) throw new TradeError(409, 'You hold nothing in this round.', 'NO_POSITION')
      const ticks = priceTicks(market.bands)
      const prices = feed.book.prices()
      const bid = position.outcome === 'up' ? prices.upBid : prices.downBid
      const shown = raw.minMills
      const floor =
        typeof shown === 'number' && onGrid(position.outcome, shown, ticks) ? shown : bid !== null ? (snapDown(Math.max(1, bid - NOW_SLIPPAGE_MILLS), ticks) ?? ticks[0]) : null
      if (floor === null) throw new TradeError(409, `No buyers for ${word(position.outcome)} right now.`, 'NO_BID')
      const canceled: TradeOrder[] = []
      for (const order of portfolio.orders)
        if (reducesPosition(order, position)) {
          await this.cancelOrder(acc, market.ticker, order.orderId)
          canceled.push(order)
        }
      const result = await this.submit(acc, {
        ticker: market.ticker,
        outcome: position.outcome,
        action: 'sell',
        mills: floor,
        count: position.contracts,
        timeInForce: 'immediate_or_cancel',
        reduceOnly: true,
        clientOrderId: newClientOrderId('out'),
      })
      if ((result.filled ?? 0) >= position.contracts - 1e-9)
        for (const target of [...this.targets.values()]) if (target.env === env && target.ticker === market.ticker) this.finishTarget(target, 'canceled', 'Sold everything with Sell now')
      if (!(result.filled ?? 0) && canceled.length) {
        for (const order of canceled)
          await acc.rest.call('POST', '/portfolio/events/orders', {
            body: {
              ticker: market.ticker,
              side: order.side,
              count: Number.isInteger(order.remaining) ? String(order.remaining) : order.remaining.toFixed(2),
              price: millsToDollars(order.yesMills),
              time_in_force: 'good_till_canceled',
              self_trade_prevention_type: 'taker_at_cross',
              client_order_id: newClientOrderId('back'),
            },
          })
        result.message = `${result.message}; your resting sells are back in place`
      }
      this.afterOrder(acc, market.ticker)
      return { ...result, ms: Date.now() - started }
    } finally {
      acc.selling.delete(market.ticker)
    }
  }

  // ── Targets ─────────────────────────────────────────────────────────────────────────────────

  /** Sell the whole holding once buyers pay `topMills`; one per round, so a new one moves it. */
  async setTarget(env: TradeEnv, raw: Record<string, unknown>): Promise<TradeResult> {
    const started = Date.now()
    this.requireTrading(env)
    const { acc, feed, market } = await this.running(env, raw.ticker)
    const { position } = await this.refreshPortfolio(acc, market.ticker)
    if (!position) throw new TradeError(409, 'You hold nothing in this round.', 'NO_POSITION')
    const top = raw.topMills
    if (typeof top !== 'number' || !onGrid(position.outcome, top, priceTicks(market.bands))) throw new TradeError(400, `${formatCents(Number(top))} is not a price this market takes.`, 'BAD_PRICE')
    if (position.avgMills !== null && top <= position.avgMills) throw new TradeError(400, `A target sells above the ${formatCents(position.avgMills)} you paid.`, 'BAD_PRICE')
    for (const old of [...this.targets.values()])
      if (old.env === env && old.ticker === market.ticker && old.kind !== 'trail') {
        if (old.state === 'selling') throw new TradeError(409, 'The target is selling right now.', 'BUSY')
        this.finishTarget(old, 'canceled', `Moved to ${formatCents(top)}`)
      }
    const target: WorkingTarget = {
      id: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      env,
      ticker: market.ticker,
      product: feed.product,
      outcome: position.outcome,
      topMills: top,
      state: 'watching',
      message: `Sells all ${count$(position.contracts)} ${word(position.outcome)} once buyers pay ${formatCents(top)}`,
      soldContracts: 0,
      closesAt: market.close * 1000,
      startedAt: Date.now(),
    }
    this.targets.set(target.id, target)
    this.log(`[trade] ${env} target ${formatCents(top)} on ${count$(position.contracts)} ${word(position.outcome)} ${market.ticker}`)
    this.saveTargets()
    this.ensureTick()
    // Buyers may already pay it: then it sells now.
    await this.checkTargets(acc, feed)
    const now = this.targets.get(target.id)
    const done = this.targetsDone.find((t) => t.id === target.id)
    return { ok: true, message: now ? `Target set: sells all at ${formatCents(top)} or more` : (done?.message ?? 'Target set'), ms: Date.now() - started }
  }

  async cancelTarget(env: TradeEnv, raw: Record<string, unknown>): Promise<TradeResult> {
    const target = typeof raw.id === 'string' ? this.targets.get(raw.id) : undefined
    if (!target || target.env !== env) throw new TradeError(404, 'That target is already over.', 'NO_TARGET')
    if (target.state === 'selling') throw new TradeError(409, 'It is selling right now.', 'BUSY')
    const message = target.kind === 'trail' ? 'Trailing sell off for this round' : 'Target canceled'
    this.finishTarget(target, 'canceled', message)
    return { ok: true, message }
  }

  /** Turn the trailing sell back on for what is held in this round (after it was turned off). */
  async setTrail(env: TradeEnv, raw: Record<string, unknown>): Promise<TradeResult> {
    this.requireTrading(env)
    const { acc, feed, market } = await this.running(env, raw.ticker)
    const { position } = await this.refreshPortfolio(acc, market.ticker)
    if (!position) throw new TradeError(409, 'You hold nothing in this round.', 'NO_POSITION')
    this.startTrail(acc, feed, market, position.outcome)
    await this.checkTargets(acc, feed)
    return { ok: true, message: `Trailing sell on: sells everything ${QUICK_TRAIL_PCT}% under the highest bid, never at a loss` }
  }

  /**
   * Every buy starts a trailing sell on its round, from the bid now. One per round: buying more of
   * the same side keeps the one working (its high, and a floor that follows the new average).
   */
  private startTrail(acc: Account, feed: Feed, market: TradeMarket, outcome: TradeOutcome): void {
    for (const old of [...this.targets.values()])
      if (old.env === acc.env && old.ticker === market.ticker && old.kind === 'trail') {
        if (old.outcome === outcome) return
        this.finishTarget(old, 'canceled', `Now holding ${word(outcome)}`)
      }
    const prices = feed.book.prices()
    const trail: WorkingTarget = {
      id: `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      env: acc.env,
      ticker: market.ticker,
      product: feed.product,
      outcome,
      kind: 'trail',
      trailPct: QUICK_TRAIL_PCT,
      highMills: (outcome === 'up' ? prices.upBid : prices.downBid) ?? 0,
      // The floor: read once the holding is.
      topMills: 0,
      state: 'watching',
      message: `Sells everything once buyers pay ${QUICK_TRAIL_PCT}% under the highest bid, never at a loss`,
      soldContracts: 0,
      closesAt: market.close * 1000,
      startedAt: Date.now(),
    }
    this.targets.set(trail.id, trail)
    this.log(`[trade] ${acc.env} trailing sell ${QUICK_TRAIL_PCT}% on ${word(outcome)} ${market.ticker}`)
    this.saveTargets()
    this.ensureTick()
  }

  private checkTargets(acc: Account, feed: Feed): Promise<void> {
    const ticker = feed.market?.ticker
    const sales: Promise<void>[] = []
    if (!ticker || !feed.market) return Promise.resolve()
    const prices = feed.book.prices()
    for (const target of this.targets.values()) {
      if (target.env !== acc.env || target.ticker !== ticker || target.state !== 'watching') continue
      const bid = target.outcome === 'up' ? prices.upBid : prices.downBid
      if (target.kind === 'trail' && bid !== null && bid > (target.highMills ?? 0)) {
        target.highMills = bid
        this.highsMoved = true
      }
      if ((target.retryAt ?? 0) > Date.now() || acc.selling.has(ticker)) continue
      if (target.kind !== 'trail') {
        if (bid !== null && bid >= target.topMills) sales.push(this.fireTarget(acc, feed, target))
        continue
      }
      // The floor follows the holding (a buy of more moves its average), read after the trail began.
      const held = acc.portfolios.get(ticker)
      const position = held && held.at >= (target.startedAt ?? 0) ? held.position : null
      if (!position || position.outcome !== target.outcome || position.avgMills === null) continue
      const floor = breakEvenMills(position.contracts, position.avgMills, priceTicks(feed.market.bands), feed.market.feeMultiplier)
      if ((floor ?? 0) !== target.topMills) {
        target.topMills = floor ?? 0
        this.highsMoved = true
      }
      if (trailFires(bid, target.highMills ?? 0, floor, target.trailPct ?? QUICK_TRAIL_PCT)) sales.push(this.fireTarget(acc, feed, target))
    }
    return Promise.all(sales).then(() => undefined)
  }

  private async fireTarget(acc: Account, feed: Feed, target: WorkingTarget): Promise<void> {
    const trail = target.kind === 'trail'
    const what = trail ? 'Trailing sell' : `Target ${formatCents(target.topMills)}`
    target.state = 'selling'
    target.message = trail
      ? `Buyers came ${target.trailPct ?? QUICK_TRAIL_PCT}% off the ${formatCents(target.highMills)} high: selling everything at ${formatCents(target.topMills)} or more`
      : `Buyers reached ${formatCents(target.topMills)}: selling everything`
    acc.selling.add(target.ticker)
    this.notify(acc.env)
    try {
      const held = acc.portfolios.get(target.ticker)
      const portfolio = held?.position && Date.now() - held.at < 3_000 ? held : await this.refreshPortfolio(acc, target.ticker)
      const position = portfolio.position
      if (!position || position.outcome !== target.outcome) return this.finishTarget(target, 'ended', `Nothing held anymore; the ${trail ? 'trailing sell' : 'target'} stopped`)
      for (const order of portfolio.orders) if (reducesPosition(order, position)) await this.cancelOrder(acc, target.ticker, order.orderId).catch(() => undefined)
      const ticks = priceTicks(feed.market?.bands ?? [])
      const price = onGrid(target.outcome, target.topMills, ticks) ? target.topMills : (snapUp(target.topMills, ticks) ?? target.topMills)
      // Reduce-only: a count the holding no longer has can never open the other side.
      const result = await this.submit(acc, {
        ticker: target.ticker,
        outcome: target.outcome,
        action: 'sell',
        mills: price,
        count: position.contracts,
        timeInForce: 'immediate_or_cancel',
        reduceOnly: true,
        clientOrderId: newClientOrderId('tgt'),
      })
      target.soldContracts += result.filled ?? 0
      const left = Math.max(0, Math.round((position.contracts - (result.filled ?? 0)) * 100) / 100)
      this.afterOrder(acc, target.ticker)
      if (left <= 0) {
        const sold = `sold ${count$(target.soldContracts)} ${word(target.outcome)}${result.avgFillMills != null ? ` at ${formatCents(result.avgFillMills)} avg` : ''}`
        this.finishTarget(target, 'done', trail ? `Trailing sell: ${sold}, ${target.trailPct ?? QUICK_TRAIL_PCT}% off the ${formatCents(target.highMills)} high` : `${what} reached: ${sold}`)
        // Nothing is held: the round's other target or trailing sell has nothing left to do.
        for (const other of [...this.targets.values()])
          if (other.env === target.env && other.ticker === target.ticker) this.finishTarget(other, 'canceled', `Everything sold by the ${trail ? 'trailing sell' : 'target'}`)
        return
      }
      target.state = 'watching'
      target.retryAt = Date.now() + 300
      target.message = `${what}: ${target.soldContracts ? `sold ${count$(target.soldContracts)}, ` : ''}${count$(left)} still held; sells the rest once buyers pay ${trail ? 'enough' : 'it'} again`
      this.saveTargets()
    } catch (error) {
      if (this.targets.get(target.id) !== target) return
      target.state = 'watching'
      target.retryAt = Date.now() + 1_000
      target.message = `${what}: the sale failed (${error instanceof Error ? error.message : 'Kalshi did not answer'}); trying again`
    } finally {
      acc.selling.delete(target.ticker)
      this.notify(acc.env)
    }
  }

  /** A working target whose holding is gone (sold elsewhere, or settled) stops. */
  private checkHeld(acc: Account, ticker: string): void {
    const held = acc.portfolios.get(ticker)
    if (!held || Date.now() - held.at > 6_000) return
    for (const target of [...this.targets.values()])
      if (
        target.env === acc.env &&
        target.ticker === ticker &&
        target.state === 'watching' &&
        held.at >= (target.startedAt ?? 0) &&
        (!held.position || held.position.outcome !== target.outcome)
      )
        this.finishTarget(target, 'ended', `Nothing held anymore (sold elsewhere); the ${target.kind === 'trail' ? 'trailing sell' : 'target'} stopped`)
  }

  private finishTarget(target: WorkingTarget, state: TradeTarget['state'], message: string): void {
    if (this.targets.get(target.id) !== target) return
    this.targets.delete(target.id)
    this.targetsDone.unshift({ ...shown(target), state, message })
    this.targetsDone.length = Math.min(this.targetsDone.length, 10)
    this.log(`[trade] ${target.env} target ${target.ticker} → ${message}`)
    this.saveTargets()
    this.notify(target.env)
  }

  /** The working targets on disk, so a restart keeps watching them. */
  private saveTargets(): void {
    if (!this.targetsFile) return
    const file = this.targetsFile
    const targets = [...this.targets.values()].map((t) => ({ ...shown(t), product: t.product, state: 'watching' as const }))
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        const temporary = `${file}.${process.pid}.tmp`
        await writeFile(temporary, `${JSON.stringify({ version: 1, targets }, null, 1)}\n`, 'utf8')
        await rename(temporary, file)
      })
      .catch(() => undefined)
  }

  private loadTargets(): void {
    if (!this.targetsFile) return
    try {
      const saved = JSON.parse(readFileSync(this.targetsFile, 'utf8')) as { targets?: unknown }
      for (const t of Array.isArray(saved.targets) ? (saved.targets as WorkingTarget[]) : [])
        if (t && typeof t.id === 'string' && (t.env === 'demo' || t.env === 'live') && typeof t.product === 'string' && KALSHI_SERIES[t.product] && t.closesAt > Date.now())
          this.targets.set(t.id, { ...t, state: 'watching' })
    } catch {
      // No saved targets.
    }
    if (this.targets.size) {
      this.log(`[trade] watching ${this.targets.size} saved target(s) again`)
      this.ensureTick()
    }
  }

  /** Resolves once the targets on disk are up to date. */
  flush(): Promise<void> {
    return this.saving
  }

  // ── What the phone sees ─────────────────────────────────────────────────────────────────────

  /**
   * What the account's trades made, per round, since `from` (unix seconds; 0 for everything Kalshi
   * still has): fills and settlements read an hour earlier, so a round that straddles the start has
   * all its fills, then cut at `from`. Reading needs a key, not the real-money switch.
   */
  history(env: TradeEnv, fromRaw: unknown): Promise<TradeHistory> {
    const acc = this.accounts[env]
    if (!acc.rest.creds) throw new TradeError(401, this.setup(env) ?? `No ${env} key.`, 'NO_KEY')
    const from = Math.max(0, Math.floor(Number(fromRaw) || 0))
    const hit = acc.histories.get(from)
    if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return hit.promise
    const promise = (async (): Promise<TradeHistory> => {
      const since = from > 0 ? from - 3600 : 0
      const [fills, settlements] = await Promise.all([this.pages(acc, '/portfolio/fills', 'fills', since), this.pages(acc, '/portfolio/settlements', 'settlements', since)])
      const rounds = historyRounds(parseFills(fills.rows), parseSettlements(settlements.rows)).filter((r) => r.time >= from)
      return { env, from, rounds, totals: historyTotals(rounds), truncated: fills.truncated }
    })()
    acc.histories.set(from, { at: Date.now(), promise })
    promise.catch(() => acc.histories.get(from)?.promise === promise && acc.histories.delete(from))
    return promise
  }

  /** Every page of a cursor-paged list (`key` names the array), from `since`, up to the cap. */
  private async pages(acc: Account, path: string, key: string, since: number): Promise<{ rows: unknown[]; truncated: boolean }> {
    const rows: unknown[] = []
    let cursor = ''
    for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: '1000' })
      if (since > 0) params.set('min_ts', String(since))
      if (cursor) params.set('cursor', cursor)
      const body = (await acc.rest.call('GET', `${path}?${params}`)) as Record<string, unknown> | null
      const list = body?.[key]
      if (Array.isArray(list)) rows.push(...list)
      cursor = typeof body?.cursor === 'string' ? body.cursor : ''
      if (!cursor || !Array.isArray(list) || !list.length) return { rows, truncated: false }
    }
    return { rows, truncated: true }
  }

  /** Keep a coin's round watched (the phone is looking at it); answers once its first read is in. */
  async watch(env: TradeEnv, product: string): Promise<void> {
    if (!KALSHI_SERIES[product]) return
    const feed = this.feed(this.accounts[env], product)
    feed.wantedAt = Date.now()
    if (feed.loading) await Promise.race([feed.loading, sleep(4_000)])
  }

  /**
   * The running round and its whole book, for the paper-trading lab: every YES and NO bid as
   * [mills, contracts], best first. Null until the round and its book are read.
   */
  depth(env: TradeEnv, product: string): { market: TradeMarket; yes: [number, number][]; no: [number, number][]; bookAt: number } | null {
    const feed = this.accounts[env].feeds.get(product)
    if (!feed?.market || !feed.bookAt) return null
    const levels = (side: Map<number, number>) => [...side].sort((a, b) => b[0] - a[0])
    return { market: { ...feed.market, ...feed.book.prices() }, yes: levels(feed.book.yes), no: levels(feed.book.no), bookAt: feed.bookAt }
  }

  snapshot(env: TradeEnv, product: string): TradeState {
    const acc = this.accounts[env]
    const feed = acc.feeds.get(product)
    const setup = this.setup(env)
    const market: TradeMarket | null = feed?.market ? { ...feed.market, ...(feed.bookAt ? feed.book.prices() : {}) } : null
    const held = market ? acc.portfolios.get(market.ticker) : undefined
    const targets = [...[...this.targets.values()].filter((t) => t.env === env).map(shown), ...this.targetsDone.filter((t) => t.env === env).slice(0, 3)]
    return {
      env,
      product,
      series: KALSHI_SERIES[product]?.series ?? null,
      connected: this.keys[env] !== null,
      liveEnabled: this.keys.liveEnabled,
      canTrade: setup === null && market !== null,
      setup,
      market,
      feed: !feed?.bookAt ? 'off' : feed.streamed ? 'stream' : 'poll',
      balance: acc.balance?.total ?? null,
      position: held?.position ?? null,
      targets,
      asOf: Date.now(),
      message: !KALSHI_SERIES[product] ? 'Kalshi runs no 15-minute market on this coin.' : (feed?.problem ?? 'Connecting…'),
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const acc of Object.values(this.accounts)) {
      acc.stream?.close()
      for (const feed of acc.feeds.values()) if (feed.reload) clearTimeout(feed.reload)
      acc.feeds.clear()
    }
  }
}
