import {
  ForcedFlowTracker,
  HISTORY_SECONDS,
  HISTORY_WARMUP_SECONDS,
  historicalForcedEvents,
  parseBitgetLiquidations,
  parseCoinbaseIntlInstrument,
  parseDeribitLiquidations,
  parseDeribitOptions,
  parseDeribitPerpetuals,
  parseDeribitSummary,
  parseGateContract,
  parseGateLiquidations,
  parseHyperliquidContexts,
  parseKrakenCandleCloses,
  parseKrakenLiquidations,
  parseKrakenOpenInterestHistory,
  parseKrakenTickers,
  parseOkxCandleCloses,
  parseOkxFunding,
  parseOkxInstruments,
  parseOkxLiquidations,
  parseOkxMarks,
  parseOkxOpenInterest,
  parseOkxOpenInterestHistory,
  perpetualsFor,
  windowChanges,
  type DerivativesVenue,
  type ForcedFlow,
  type HistoryBar,
  type LiquidationVenue,
  type OkxContract,
} from '../src/data/forcedFlow'

/**
 * Perpetual-futures positioning for the charted product: open interest, marks and funding polled
 * from five venues, and liquidations streamed from five (OKX, Kraken, Deribit, Gate.io, Bitget),
 * with OKX's unthrottled REST list re-read every 30 seconds to fill in what its live feed drops.
 * Also the perps' last prices against Coinbase spot (spot trades come from Coinbase's match feed,
 * server/forcedFlow.ts), Deribit's options open interest, and squeezes replayed from Kraken's five-minute
 * history. Feeds `ForcedFlowTracker`, whose snapshot `/api/forced-flow` serves.
 *
 * Every upstream is a fixed public market-data endpoint — no keys, no accounts, no order entry.
 * Binance and Bybit are deliberately absent: both refuse connections from this region (HTTP 451
 * and a CloudFront 403), so adding them would only add a permanently-down row.
 *
 * Nothing runs until a chart `watch`es a product, and everything stops a few seconds after the
 * last chart lets go.
 */
export const POLL_MS = 15_000
export const FUNDING_POLL_MS = 60_000
/** Options open interest changes slowly; Deribit's summary is a few hundred kilobytes. */
export const OPTIONS_POLL_MS = 5 * 60_000
/** The Kraken replay is re-run this often, so new squeezes join the history. */
export const HISTORY_POLL_MS = 15 * 60_000
/**
 * OKX's live liquidation feed sends at most one order per instrument per second; its REST list
 * keeps them all (most seconds of a burst hold several). Its last 100 cover well over 30 seconds.
 */
export const OKX_BACKFILL_MS = 30_000
/**
 * A socket silent this long is dead even if it still reads open (a sleeping laptop, a changed
 * network). Every feed answers its keepalive or sends a heartbeat well inside this.
 */
export const SILENCE_MS = 75_000
/** A Gate.io contract that failed to load is asked for again after this. */
const GATE_RETRY_MS = 10 * 60_000
/** A Kraken last trade older than this cannot stand for the perp's price now. */
const PERP_LAST_FRESH_SECONDS = 30
const REQUEST_TIMEOUT_MS = 8_000
const IDLE_MS = 5_000
/**
 * How long a released product's tracker is kept. A chart pauses its stream whenever its tab is
 * hidden; without this, every tab switch would throw away the calibration, the OI samples and the
 * event list, and the box would sit in "warming up" for five minutes after each return.
 */
export const RETAIN_MS = 15 * 60_000

const OKX = 'https://www.okx.com'
const KRAKEN = 'https://futures.kraken.com'
const DERIBIT = 'https://www.deribit.com'
const HYPERLIQUID = 'https://api.hyperliquid.xyz/info'
const COINBASE_INTL = 'https://api.international.coinbase.com'
const GATE = 'https://api.gateio.ws'

const SOCKETS: Record<LiquidationVenue, string> = {
  okx: 'wss://ws.okx.com:8443/ws/v5/public',
  kraken: 'wss://futures.kraken.com/ws/v1',
  deribit: 'wss://www.deribit.com/ws/api/v2',
  gate: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
  bitget: 'wss://ws.bitget.com/v3/ws/public',
}

/** What each socket sends every 20 seconds to keep itself, and the silence check, alive. */
const KEEPALIVE: Record<LiquidationVenue, string | (() => string) | null> = {
  okx: 'ping',
  deribit: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'public/test', params: {} }),
  gate: () => JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.ping' }),
  bitget: 'ping',
  // Kraken has no ping; its heartbeat feed, subscribed on open, keeps the socket talking.
  kraken: null,
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

interface Watched {
  product: string
  refs: number
  tracker: ForcedFlowTracker
  lastFunding: number
  lastOptions: number
  lastHistory: number
  lastBackfill: number
}

export interface DerivativesFeed {
  watch(product: string): () => void
  snapshot(product: string, now: number): ForcedFlow | undefined
  /** One Coinbase spot match for a watched product; ignored for any other. */
  spotTrade(
    product: string,
    trade: { time: number; price: number; size: number; takerSide?: 'buy' | 'sell' | null },
  ): void
  close(): void
}

export class DerivativesService implements DerivativesFeed {
  private watched = new Map<string, Watched>()
  /** Released products, kept for `RETAIN_MS` so a returning chart resumes where it left off. */
  private dormant = new Map<string, { entry: Watched; until: number }>()
  private fetcher: Fetcher
  private socketFactory: (url: string) => WebSocket
  private sockets = new Map<LiquidationVenue, LiveSocket>()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private okxContracts: Map<string, OkxContract> | null = null
  private okxContractsLoading: Promise<void> | null = null
  /** Gate.io base coins per contract; a contract is subscribed only once this knows it. */
  private gateMultipliers = new Map<string, number>()
  /** Gate.io contracts being loaded, or failed: when they may be asked for again. */
  private gatePending = new Map<string, number>()
  /**
   * Deribit's listed perpetuals, from the last book summaries. A linear USDC perpetual is
   * subscribed, and counted in Deribit's open interest, only once it is known to exist.
   */
  private deribitListed = new Set<string>()
  private closed = false
  private polling = false

  constructor(options: { fetcher?: Fetcher; socketFactory?: (url: string) => WebSocket } = {}) {
    this.fetcher = options.fetcher ?? fetch
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url))
  }

  watch(product: string): () => void {
    if (this.closed || !perpetualsFor(product)) return () => {}
    for (const [key, kept] of this.dormant) if (kept.until < Date.now()) this.dormant.delete(key)
    let entry = this.watched.get(product)
    if (!entry) {
      const kept = this.dormant.get(product)?.entry
      this.dormant.delete(product)
      entry = kept ?? {
        product,
        refs: 0,
        tracker: new ForcedFlowTracker(product),
        lastFunding: 0,
        lastOptions: 0,
        lastHistory: 0,
        lastBackfill: 0,
      }
      this.watched.set(product, entry)
      if (!kept) void this.seed(entry)
    }
    entry.refs++
    clearTimeout(this.idleTimer)
    this.start()
    this.resubscribe()
    let released = false
    return () => {
      if (released) return
      released = true
      const current = this.watched.get(product)
      if (!current) return
      current.refs--
      if (current.refs > 0) return
      this.watched.delete(product)
      this.dormant.set(product, { entry: current, until: Date.now() + RETAIN_MS })
      this.resubscribe()
      if (!this.watched.size)
        this.idleTimer = setTimeout(() => {
          if (!this.watched.size) this.stop()
        }, IDLE_MS)
    }
  }

  snapshot(product: string, now: number): ForcedFlow | undefined {
    const entry = this.watched.get(product)
    if (!entry) return undefined
    for (const [venue, socket] of this.sockets) entry.tracker.feeds[venue] = socket.state
    return entry.tracker.snapshot(now)
  }

  spotTrade(product: string, trade: Parameters<DerivativesFeed['spotTrade']>[1]) {
    this.watched.get(product)?.tracker.addSpotTrade(trade, Date.now() / 1000)
  }

  close() {
    this.closed = true
    this.watched.clear()
    this.dormant.clear()
    clearTimeout(this.idleTimer)
    this.stop()
  }

  private start() {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
    void this.poll()
    for (const venue of Object.keys(SOCKETS) as LiquidationVenue[]) {
      if (this.sockets.has(venue)) continue
      const socket = new LiveSocket(venue, SOCKETS[venue], this.socketFactory, {
        onOpen: () => this.subscribeVenue(venue),
        onMessage: (data) => this.onSocketMessage(venue, data),
        keepalive: KEEPALIVE[venue],
      })
      this.sockets.set(venue, socket)
      socket.connect()
    }
  }

  private stop() {
    clearInterval(this.pollTimer)
    this.pollTimer = undefined
    for (const socket of this.sockets.values()) socket.close()
    this.sockets.clear()
  }

  private async getJson(url: string, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetcher(url, {
        ...init,
        signal: controller.signal,
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > 4_000_000) throw new Error('Upstream payload too large')
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Five days of OKX five-minute OI and price windows, so the thresholds start calibrated. */
  private async seed(entry: Watched) {
    const okx = perpetualsFor(entry.product)?.okx[0]
    if (!okx) return
    try {
      const oiPoints: { time: number; value: number }[] = []
      const closes: { time: number; value: number }[] = []
      let oiEnd = ''
      let candleAfter = ''
      for (let page = 0; page < 15 && this.watched.get(entry.product) === entry; page++) {
        const [oi, candles] = await Promise.all([
          this.getJson(
            `${OKX}/api/v5/rubik/stat/contracts/open-interest-history?instId=${okx}&period=5m&limit=100${oiEnd ? `&end=${oiEnd}` : ''}`,
          ),
          this.getJson(
            `${OKX}/api/v5/market/history-candles?instId=${okx}&bar=5m&limit=100${candleAfter ? `&after=${candleAfter}` : ''}`,
          ),
        ])
        const oiRows = parseOkxOpenInterestHistory(oi)
        const candleRows = parseOkxCandleCloses(candles)
        if (!oiRows.length && !candleRows.length) break
        oiPoints.push(...oiRows)
        closes.push(...candleRows)
        const oldestOi = oiRows[oiRows.length - 1]?.time
        const oldestCandle = candleRows[candleRows.length - 1]?.time
        if (oldestOi) oiEnd = String(Math.round(oldestOi * 1000))
        if (oldestCandle) candleAfter = String(Math.round(oldestCandle * 1000))
        await delay(150)
      }
      entry.tracker.seed(windowChanges(closes), windowChanges(oiPoints))
    } catch {
      // Unseeded, the tracker calibrates from live windows instead; it says so until it has.
    }
  }

  private async loadOkxContracts() {
    if (this.okxContracts) return
    this.okxContractsLoading ??= this.getJson(`${OKX}/api/v5/public/instruments?instType=SWAP`)
      .then((payload) => {
        const contracts = parseOkxInstruments(payload)
        if (contracts.size) this.okxContracts = contracts
      })
      .catch(() => undefined)
      .finally(() => {
        this.okxContractsLoading = null
      })
    await this.okxContractsLoading
  }

  /** One round of OI, marks and (once a minute) funding for every watched product. */
  private async poll() {
    if (this.polling || !this.watched.size) return
    this.polling = true
    const now = () => Date.now() / 1000
    try {
      const entries = [...this.watched.values()]
      const pairs = entries.map((e) => ({ entry: e, perps: perpetualsFor(e.product)! }))
      // The inverse books of the BTC and ETH perpetuals, and one USDC book for every linear one.
      const deribitCurrencies = [
        ...new Set(pairs.flatMap((p) => (p.perps.deribit ? [p.perps.base] : []))),
        'USDC',
      ]
      const [okxOi, okxMarks, kraken, hyperliquid, ...rest] = await Promise.allSettled([
        this.getJson(`${OKX}/api/v5/public/open-interest?instType=SWAP`),
        this.getJson(`${OKX}/api/v5/public/mark-price?instType=SWAP`),
        this.getJson(`${KRAKEN}/derivatives/api/v3/tickers`),
        this.getJson(HYPERLIQUID, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
        }),
        ...deribitCurrencies.map((currency) =>
          this.getJson(
            `${DERIBIT}/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=future`,
          ),
        ),
        ...pairs.map((p) =>
          this.getJson(`${COINBASE_INTL}/api/v1/instruments/${p.perps.coinbaseIntl}`),
        ),
      ])
      const deribit = new Map(deribitCurrencies.map((c, i) => [c, rest[i]]))
      const coinbaseIntl = rest.slice(deribitCurrencies.length)
      const okxOiMap = okxOi.status === 'fulfilled' ? parseOkxOpenInterest(okxOi.value) : null
      const okxMarkMap = okxMarks.status === 'fulfilled' ? parseOkxMarks(okxMarks.value) : null
      const krakenMap = kraken.status === 'fulfilled' ? parseKrakenTickers(kraken.value) : null
      const hlMap =
        hyperliquid.status === 'fulfilled' ? parseHyperliquidContexts(hyperliquid.value) : null
      const usdc = deribit.get('USDC')
      if (usdc?.status === 'fulfilled') {
        const listed = parseDeribitPerpetuals(usdc.value)
        const changed = pairs.some(
          (p) =>
            listed.has(p.perps.deribitLinear) !== this.deribitListed.has(p.perps.deribitLinear),
        )
        this.deribitListed = listed
        if (changed) this.subscribeVenue('deribit')
      }
      const at = now()
      pairs.forEach(({ entry, perps }, i) => {
        const tracker = entry.tracker
        // USD-quoted perps only (Kraken, Deribit), paired with Coinbase spot below.
        const lasts: { venue: DerivativesVenue; price: number }[] = []
        if (okxOiMap && okxMarkMap) {
          // Both OKX books (USDT- and coin-margined) count as one venue's open interest.
          let oi = 0
          let mark: number | null = null
          for (const instId of perps.okx) {
            const value = okxOiMap.get(instId)
            if (value) oi += value
            mark ??= okxMarkMap.get(instId) ?? null
          }
          if (oi > 0 && mark)
            tracker.addOpenInterest({ venue: 'okx', time: at, openInterest: oi, mark })
        }
        const k = krakenMap?.get(perps.kraken)
        if (k) {
          tracker.addOpenInterest({
            venue: 'kraken',
            time: at,
            openInterest: k.openInterest,
            mark: k.mark,
          })
          if (k.rate8h !== null) tracker.addFunding({ venue: 'kraken', time: at, rate8h: k.rate8h })
          if (k.last !== null && k.lastTime !== null && at - k.lastTime <= PERP_LAST_FRESH_SECONDS)
            lasts.push({ venue: 'kraken', price: k.last })
        }
        const h = hlMap?.get(perps.hyperliquid)
        if (h) {
          tracker.addOpenInterest({
            venue: 'hyperliquid',
            time: at,
            openInterest: h.openInterest,
            mark: h.mark,
          })
          if (h.rate8h !== null)
            tracker.addFunding({ venue: 'hyperliquid', time: at, rate8h: h.rate8h })
        }
        // Deribit's inverse and linear books count as one venue's open interest, like OKX's two.
        // Both arrive in separate requests, so a sample is taken only when every book that should
        // be there is: one failed request must not read as Deribit's OI falling by that book.
        const inverseBook = perps.deribit ? deribit.get(perps.base) : undefined
        const inverse =
          perps.deribit && inverseBook?.status === 'fulfilled'
            ? parseDeribitSummary(inverseBook.value, perps.deribit)
            : null
        const linear =
          usdc?.status === 'fulfilled' ? parseDeribitSummary(usdc.value, perps.deribitLinear) : null
        const wantLinear = this.deribitListed.has(perps.deribitLinear)
        if ((inverse || linear) && (!perps.deribit || inverse) && (!wantLinear || linear)) {
          tracker.addOpenInterest({
            venue: 'deribit',
            time: at,
            openInterest: (inverse?.openInterest ?? 0) + (linear?.openInterest ?? 0),
            mark: inverse?.mark ?? linear!.mark,
          })
          const rate8h = inverse?.rate8h ?? linear?.rate8h ?? null
          if (rate8h !== null) tracker.addFunding({ venue: 'deribit', time: at, rate8h })
        }
        // Only the inverse book is quoted in USD; a USDC price would fold in the stablecoin's drift.
        if (inverse?.last != null) lasts.push({ venue: 'deribit', price: inverse.last })
        const c = coinbaseIntl[i]
        if (c?.status === 'fulfilled') {
          const intl = parseCoinbaseIntlInstrument(c.value)
          if (intl) tracker.addOpenInterest({ venue: 'coinbase-intl', time: at, ...intl })
        }
        tracker.samplePremium(at, lasts)
      })
      // Funding moves slowly; once a minute per product is plenty.
      await Promise.allSettled(
        pairs
          .filter((p) => Date.now() - p.entry.lastFunding >= FUNDING_POLL_MS)
          .map(async ({ entry, perps }) => {
            entry.lastFunding = Date.now()
            const funding = parseOkxFunding(
              await this.getJson(`${OKX}/api/v5/public/funding-rate?instId=${perps.okx[0]}`),
            )
            if (funding)
              entry.tracker.addFunding({ venue: 'okx', time: now(), rate8h: funding.rate8h })
          }),
      )
      await Promise.allSettled([
        this.pollOptions(pairs, now),
        this.backfillOkx(pairs, now),
        ...pairs
          .filter((p) => Date.now() - p.entry.lastHistory >= HISTORY_POLL_MS)
          .map(({ entry, perps }) => this.loadHistory(entry, perps.kraken)),
      ])
    } finally {
      this.polling = false
    }
  }

  /**
   * Re-read OKX's REST liquidation list: the live feed keeps one order per instrument per second,
   * the list keeps every one. The tracker drops the prints it already has.
   */
  private async backfillOkx(
    pairs: { entry: Watched; perps: NonNullable<ReturnType<typeof perpetualsFor>> }[],
    now: () => number,
  ) {
    const due = pairs.filter((p) => Date.now() - p.entry.lastBackfill >= OKX_BACKFILL_MS)
    if (!due.length) return
    await this.loadOkxContracts()
    const contracts = this.okxContracts
    if (!contracts) return
    for (const { entry, perps } of due) {
      entry.lastBackfill = Date.now()
      for (const instId of perps.okx) {
        if (!contracts.has(instId)) continue
        const family = instId.replace(/-SWAP$/, '')
        const payload = await this.getJson(
          `${OKX}/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${family}&state=filled&limit=100`,
        ).catch(() => null)
        for (const parsed of parseOkxLiquidations(payload, contracts))
          if (parsed.instId === instId) entry.tracker.addLiquidation(parsed.liquidation, now())
      }
    }
  }

  /**
   * Deribit options open interest every few minutes: the coin book where Deribit has one (BTC,
   * ETH) plus the USDC book, which also lists SOL, XRP, HYPE, AVAX and TRX options.
   */
  private async pollOptions(
    pairs: { entry: Watched; perps: NonNullable<ReturnType<typeof perpetualsFor>> }[],
    now: () => number,
  ) {
    const due = pairs.filter((p) => Date.now() - p.entry.lastOptions >= OPTIONS_POLL_MS)
    if (!due.length) return
    for (const { entry } of due) entry.lastOptions = Date.now()
    // Deribit's coin options exist only where its inverse perpetual does: BTC and ETH.
    const currencies = [
      ...new Set(due.flatMap((p) => (p.perps.deribit ? [p.perps.base] : []))),
      'USDC',
    ]
    const results = await Promise.allSettled(
      currencies.map((currency) =>
        this.getJson(
          `${DERIBIT}/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`,
        ),
      ),
    )
    const books = new Map(currencies.map((c, i) => [c, results[i]]))
    for (const { entry, perps } of due) {
      const wanted = [perps.deribit ? books.get(perps.base) : undefined, books.get('USDC')]
      // A failed book keeps the last summary up: half of BTC's options would read as a collapse.
      if (wanted.some((r) => r?.status === 'rejected')) continue
      const payloads = wanted.flatMap((r) => (r?.status === 'fulfilled' ? [r.value] : []))
      entry.tracker.setOptions(parseDeribitOptions(payloads, perps.base, now()))
    }
  }

  /**
   * Replay Kraken Futures' published five-minute OI and trade history through the forced-flow
   * rule, so the chart shows the last few days' squeezes and not only those seen since it opened.
   */
  private async loadHistory(entry: Watched, symbol: string) {
    entry.lastHistory = Date.now()
    const to = Math.floor(Date.now() / 1000)
    const from = to - HISTORY_SECONDS - HISTORY_WARMUP_SECONDS
    const [oi, candles] = await Promise.all([
      this.getJson(
        `${KRAKEN}/api/charts/v1/analytics/${symbol}/open-interest?since=${from}&to=${to}&interval=300`,
      ),
      this.getJson(`${KRAKEN}/api/charts/v1/trade/${symbol}/5m?from=${from}&to=${to}`),
    ])
    const closes = new Map(parseKrakenCandleCloses(candles).map((c) => [c.time, c.value]))
    const bars: HistoryBar[] = parseKrakenOpenInterestHistory(oi).flatMap((row) => {
      const close = closes.get(row.time)
      return close ? [{ time: row.time, close, oiOpen: row.open, oiClose: row.close }] : []
    })
    if (bars.length)
      entry.tracker.setHistory(historicalForcedEvents(entry.product, bars, to - HISTORY_SECONDS))
  }

  private resubscribe() {
    for (const venue of this.sockets.keys()) this.subscribeVenue(venue)
  }

  /**
   * OKX and Bitget take every swap in one subscription; Kraken, Deribit and Gate.io are per
   * instrument, and Deribit and Gate.io only for instruments known to exist (an unknown one can
   * fail the whole request).
   */
  private subscribeVenue(venue: LiquidationVenue) {
    const socket = this.sockets.get(venue)
    if (!socket?.isOpen) return
    const perps = [...this.watched.keys()].flatMap((p) => {
      const value = perpetualsFor(p)
      return value ? [value] : []
    })
    if (venue === 'okx') {
      void this.loadOkxContracts()
      socket.sendOnce('okx', {
        op: 'subscribe',
        args: [{ channel: 'liquidation-orders', instType: 'SWAP' }],
      })
    } else if (venue === 'bitget') {
      socket.sendOnce('bitget', {
        op: 'subscribe',
        args: [{ instType: 'usdt-futures', topic: 'liquidation' }],
      })
    } else if (venue === 'kraken') {
      const ids = [...new Set(perps.map((p) => p.kraken))]
      socket.reconcile(ids, (add, remove) => [
        ...(add.length ? [{ event: 'subscribe', feed: 'trade', product_ids: add }] : []),
        ...(remove.length ? [{ event: 'unsubscribe', feed: 'trade', product_ids: remove }] : []),
      ])
      socket.sendOnce('heartbeat', { event: 'subscribe', feed: 'heartbeat' })
    } else if (venue === 'gate') {
      const contracts = [...new Set(perps.map((p) => p.gate))]
      this.loadGateContracts(contracts)
      const time = Math.floor(Date.now() / 1000)
      socket.reconcile(
        contracts.filter((c) => this.gateMultipliers.has(c)),
        (add, remove) => [
          ...(add.length
            ? [{ time, channel: 'futures.public_liquidates', event: 'subscribe', payload: add }]
            : []),
          ...(remove.length
            ? [
                {
                  time,
                  channel: 'futures.public_liquidates',
                  event: 'unsubscribe',
                  payload: remove,
                },
              ]
            : []),
        ],
      )
    } else {
      const channels = [
        ...new Set(
          perps.flatMap((p) => [
            ...(p.deribit ? [`trades.${p.deribit}.100ms`] : []),
            ...(this.deribitListed.has(p.deribitLinear) ? [`trades.${p.deribitLinear}.100ms`] : []),
          ]),
        ),
      ]
      socket.reconcile(channels, (add, remove) => [
        ...(add.length
          ? [{ jsonrpc: '2.0', id: 1, method: 'public/subscribe', params: { channels: add } }]
          : []),
        ...(remove.length
          ? [{ jsonrpc: '2.0', id: 2, method: 'public/unsubscribe', params: { channels: remove } }]
          : []),
      ])
    }
  }

  /**
   * Gate.io sizes are contracts; each contract's coin multiplier is read once. A contract Gate.io
   * does not list (or a failed request) is asked for again only after a while.
   */
  private loadGateContracts(contracts: string[]) {
    const missing = contracts.filter(
      (c) => !this.gateMultipliers.has(c) && (this.gatePending.get(c) ?? 0) <= Date.now(),
    )
    for (const contract of missing) {
      this.gatePending.set(contract, Date.now() + GATE_RETRY_MS)
      void this.getJson(`${GATE}/api/v4/futures/usdt/contracts/${contract}`)
        .then((payload) => {
          const parsed = parseGateContract(payload)
          if (parsed?.contract !== contract) return
          this.gateMultipliers.set(contract, parsed.multiplier)
          this.gatePending.delete(contract)
          this.subscribeVenue('gate')
        })
        .catch(() => undefined)
    }
  }

  private trackerFor(match: (perps: NonNullable<ReturnType<typeof perpetualsFor>>) => boolean) {
    for (const entry of this.watched.values()) {
      const perps = perpetualsFor(entry.product)
      if (perps && match(perps)) return entry.tracker
    }
    return null
  }

  private onSocketMessage(venue: LiquidationVenue, data: string) {
    if (data === 'pong' || data.length > 1_000_000) return
    let message: unknown
    try {
      message = JSON.parse(data)
    } catch {
      return
    }
    const now = Date.now() / 1000
    if (venue === 'okx') {
      if (!this.okxContracts) return
      for (const { instId, liquidation } of parseOkxLiquidations(message, this.okxContracts))
        this.trackerFor((p) => p.okx.includes(instId))?.addLiquidation(liquidation, now)
    } else if (venue === 'kraken') {
      for (const { productId, liquidation } of parseKrakenLiquidations(message))
        this.trackerFor((p) => p.kraken === productId)?.addLiquidation(liquidation, now)
    } else if (venue === 'gate') {
      for (const { contract, liquidation } of parseGateLiquidations(message, this.gateMultipliers))
        this.trackerFor((p) => p.gate === contract)?.addLiquidation(liquidation, now)
    } else if (venue === 'bitget') {
      // One stream for every USDT perpetual on Bitget; all but the watched ones fall through.
      for (const { symbol, liquidation } of parseBitgetLiquidations(message))
        this.trackerFor((p) => p.bitget === symbol)?.addLiquidation(liquidation, now)
    } else {
      for (const { instrument, liquidation } of parseDeribitLiquidations(message))
        this.trackerFor(
          (p) => p.deribit === instrument || p.deribitLinear === instrument,
        )?.addLiquidation(liquidation, now)
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One reconnecting public websocket. Tracks what it has subscribed so a reconnect replays exactly
 * the current set, reports `live` only once a message has arrived, and dials again when an open
 * socket goes quiet for `SILENCE_MS`.
 */
interface LiveSocketHandlers {
  onOpen: () => void
  onMessage: (data: string) => void
  keepalive: string | (() => string) | null
}

class LiveSocket {
  private socket: WebSocket | null = null
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined
  private silenceTimer: ReturnType<typeof setInterval> | undefined
  private lastMessage = 0
  private subscribed = new Set<string>()
  private sent = new Set<string>()
  private closed = false
  state: 'live' | 'connecting' | 'down' = 'connecting'
  readonly venue: LiquidationVenue
  private url: string
  private factory: (url: string) => WebSocket
  private handlers: LiveSocketHandlers

  // Plain fields, not parameter properties: `npm start` runs this file under Node's
  // strip-only TypeScript mode, which rejects syntax that emits code.
  constructor(
    venue: LiquidationVenue,
    url: string,
    factory: (url: string) => WebSocket,
    handlers: LiveSocketHandlers,
  ) {
    this.venue = venue
    this.url = url
    this.factory = factory
    this.handlers = handlers
  }

  get isOpen() {
    return this.socket?.readyState === 1
  }

  connect() {
    if (this.closed || this.socket) return
    let socket: WebSocket
    try {
      socket = this.factory(this.url)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = socket
    this.state = 'connecting'
    const timeout = setTimeout(() => {
      if (this.socket === socket && socket.readyState !== 1) socket.close()
    }, 10_000)
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      clearTimeout(timeout)
      this.subscribed.clear()
      this.sent.clear()
      this.lastMessage = Date.now()
      if (this.handlers.keepalive) {
        const ping = this.handlers.keepalive
        this.keepaliveTimer = setInterval(() => {
          if (socket.readyState === 1) socket.send(typeof ping === 'function' ? ping() : ping)
        }, 20_000)
      }
      // After a sleep or a network change a socket can stay "open" with nothing behind it, and
      // closing it may never complete; let it go and dial a fresh one.
      this.silenceTimer = setInterval(() => {
        if (this.socket === socket && Date.now() - this.lastMessage > SILENCE_MS) {
          this.release()
          socket.close()
          this.scheduleReconnect()
        }
      }, 15_000)
      this.handlers.onOpen()
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      this.lastMessage = Date.now()
      this.state = 'live'
      this.attempt = 0
      this.handlers.onMessage(event.data)
    })
    socket.addEventListener('close', () => {
      clearTimeout(timeout)
      if (this.socket !== socket) return
      this.release()
      this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.state = 'down'
    })
  }

  /** Send a fixed subscription once per connection. */
  sendOnce(key: string, message: unknown) {
    if (!this.isOpen || this.sent.has(key)) return
    this.sent.add(key)
    this.socket!.send(JSON.stringify(message))
  }

  /** Bring the connection's subscriptions to exactly `desired`. */
  reconcile(desired: string[], build: (add: string[], remove: string[]) => unknown[]) {
    if (!this.isOpen) return
    const want = new Set(desired)
    const add = desired.filter((id) => !this.subscribed.has(id))
    const remove = [...this.subscribed].filter((id) => !want.has(id))
    for (const message of build(add, remove)) this.socket!.send(JSON.stringify(message))
    this.subscribed = want
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return
    this.state = 'down'
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.attempt++, 6))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, wait)
  }

  /** Forget the current socket and its timers; its later events are ignored. */
  private release() {
    this.socket = null
    clearInterval(this.keepaliveTimer)
    clearInterval(this.silenceTimer)
  }

  close() {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    const socket = this.socket
    this.release()
    socket?.close()
  }
}
