/**
 * Polymarket's 5-minute up/down market on Bitcoin, for the Polymarket Strike indicator. Read through
 * the dev server, as Kalshi's is.
 *
 * The strike ("Price to Beat") is the window's opening TWAP: Chainlink's 60-second average of BTC/USD
 * ending at the open, and the number the market settles against. Two reads give it:
 *  - `crypto-price` (the one Polymarket's own page uses) for the running window, but only when asked
 *    with the market's TWAP settings. Without them it answers the spot price at the open, which
 *    called 12 of 95 rounds the wrong way in November 2026.
 *  - Gamma's `eventMetadata.priceToBeat` for past windows. It comes a minute or two after the close,
 *    too late for the running window.
 *
 * That average runs some dollars off Coinbase, so `basis` measures it as Kalshi's does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { measureBasis, minuteAverages, type KalshiBasis } from './kalshi'

const GAMMA = 'https://gamma-api.polymarket.com'
const CLOB = 'https://clob.polymarket.com'
const SITE = 'https://polymarket.com'
const COINBASE = 'https://api.exchange.coinbase.com'
export const POLYMARKET_WINDOW_SECONDS = 300
/** The gap is measured over the strikes of this long back (Coinbase answers 300 minutes a read). */
const BASIS_SECONDS = 4 * 3600
/** Nothing is read from the cache older than a minute: older entries are last round's. */
const CACHE_KEEP_MS = 120_000

/** Coinbase product → Polymarket's 5-minute series. */
export const POLYMARKET_SERIES: Record<string, { symbol: string; slug: string; series: string }> = {
  'BTC-USD': { symbol: 'BTC', slug: 'btc-updown-5m', series: 'btc-up-or-down-5m' },
}

export interface PolymarketWindow {
  slug: string
  /** Window open and close, unix seconds. */
  start: number
  end: number
  strike: number
}

export interface PolymarketCurrent extends PolymarketWindow {
  /** The Up side's midpoint on the order book, in dollars per share. */
  upPrice: number | null
}

export interface PolymarketStrikeReply {
  product: string
  series: string
  current: PolymarketCurrent | null
  /** Past windows, oldest first. */
  history: PolymarketWindow[]
  /** Null until measured (or with Coinbase unreachable). */
  basis: KalshiBasis | null
  fetchedAt: number
  message: string
}

/** A window as Gamma lists it: what it takes to read its strike and its Up price. */
export interface PolymarketRound {
  slug: string
  start: number
  end: number
  upToken: string | null
  /** The TWAP's length in seconds; null when the market settles on the spot price. */
  twapSeconds: number | null
}

type Row = Record<string, unknown>

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null
}
const seconds = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? Math.round(t / 1000) : null
}
const iso = (sec: number) => new Date(sec * 1000).toISOString()
const events = (payload: unknown): Row[] => (Array.isArray(payload) ? (payload.filter((e) => e && typeof e === 'object') as Row[]) : [])
const firstMarket = (event: Row | undefined): Row | null => {
  const markets = event?.markets
  return Array.isArray(markets) && markets[0] && typeof markets[0] === 'object' ? (markets[0] as Row) : null
}
/** Gamma sends its lists as JSON inside a string. */
const stringList = (v: unknown): string[] => {
  try {
    const list: unknown = typeof v === 'string' ? JSON.parse(v) : v
    return Array.isArray(list) ? list.map(String) : []
  } catch {
    return []
  }
}

/**
 * The first event of a Gamma page, as a round. Null without the market's price settings: read
 * without them, `crypto-price` would answer a number the market does not settle on.
 */
export function parseRound(payload: unknown): PolymarketRound | null {
  const m = firstMarket(events(payload)[0])
  const start = seconds(m?.eventStartTime)
  const end = seconds(m?.endDate)
  const config = m?.cryptoMarketConfig as { twapEnabled?: unknown; twapLookbackSeconds?: unknown } | undefined
  if (!m || start === null || end === null || end - start !== POLYMARKET_WINDOW_SECONDS || !config) return null
  const twapSeconds = config.twapEnabled === true ? num(config.twapLookbackSeconds) : null
  if (config.twapEnabled === true && twapSeconds === null) return null
  const up = stringList(m.outcomes).indexOf('Up')
  return { slug: String(m.slug ?? ''), start, end, upToken: up >= 0 ? (stringList(m.clobTokenIds)[up] ?? null) : null, twapSeconds }
}

/** Past windows out of a Gamma page, oldest first, one per open time; those without a strike yet are left out. */
export function parseHistory(payload: unknown): PolymarketWindow[] {
  const byStart = new Map<number, PolymarketWindow>()
  for (const event of events(payload)) {
    const m = firstMarket(event)
    const start = seconds(m?.eventStartTime)
    const end = seconds(m?.endDate)
    const strike = num((event.eventMetadata as { priceToBeat?: unknown } | null | undefined)?.priceToBeat)
    if (start === null || end === null || strike === null || end - start !== POLYMARKET_WINDOW_SECONDS) continue
    byStart.set(start, { slug: String(event.slug ?? ''), start, end, strike })
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

/** The `crypto-price` read of a round, with the market's own price settings. */
export function cryptoPriceUrl(symbol: string, round: PolymarketRound): string {
  const params = new URLSearchParams({ symbol, eventStartTime: iso(round.start), variant: 'fiveminute', endDate: iso(round.end) })
  if (round.twapSeconds !== null) {
    params.set('twapEnabled', 'true')
    params.set('twapLookbackSeconds', String(round.twapSeconds))
  }
  return `${SITE}/api/crypto/crypto-price?${params}`
}

export function createPolymarketApi(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: unknown }>()
  const pending = new Map<string, Promise<unknown>>()
  /** A window's strike does not move once published: read once, by slug. */
  const strikes = new Map<string, number>()

  /** One GET, cached for `ttlMs`. */
  const get = async (url: string, ttlMs: number): Promise<unknown> => {
    const hit = cache.get(url)
    if (hit && now() - hit.at < ttlMs) return hit.value
    const inflight = pending.get(url)
    if (inflight) return inflight
    const request = (async () => {
      const res = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`Polymarket answered ${res.status}`)
      const value = await res.json()
      // These URLs name their window, so each round leaves entries behind.
      for (const [key, entry] of cache) if (now() - entry.at > CACHE_KEEP_MS) cache.delete(key)
      cache.set(url, { at: now(), value })
      return value
    })().finally(() => pending.delete(url))
    pending.set(url, request)
    return request
  }

  const strikeOf = async (symbol: string, round: PolymarketRound): Promise<number | null> => {
    const known = strikes.get(round.slug)
    if (known !== undefined) return known
    const strike = num(((await get(cryptoPriceUrl(symbol, round), 1000)) as { openPrice?: unknown } | null)?.openPrice)
    if (strike === null) return null
    // Only the running window's is needed again.
    strikes.clear()
    strikes.set(round.slug, strike)
    return strike
  }

  /** The Up side's midpoint: Gamma's own quotes lag the book by far too much on a 5-minute market. */
  const upPriceOf = async (round: PolymarketRound): Promise<number | null> => {
    if (!round.upToken) return null
    const reply = await get(`${CLOB}/midpoint?token_id=${encodeURIComponent(round.upToken)}`, 2000)
    return num((reply as { mid?: unknown } | null)?.mid)
  }

  const currentOf = async (feed: { symbol: string; slug: string }, nowSec: number): Promise<PolymarketCurrent | null> => {
    const start = nowSec - (nowSec % POLYMARKET_WINDOW_SECONDS)
    const round = parseRound(await get(`${GAMMA}/events?slug=${feed.slug}-${start}`, 15_000))
    if (!round || nowSec < round.start || nowSec >= round.end) return null
    const strike = await strikeOf(feed.symbol, round)
    if (strike === null) return null
    return { slug: round.slug, start: round.start, end: round.end, strike, upPrice: await upPriceOf(round).catch(() => null) }
  }

  const basisCache = new Map<string, { at: number; value: Promise<KalshiBasis | null> }>()
  /** The gap, measured again once a minute (one Coinbase read). */
  const basisFor = (product: string, windows: readonly PolymarketWindow[], nowSec: number): Promise<KalshiBasis | null> => {
    const hit = basisCache.get(product)
    if (hit && now() - hit.at < 60_000) return hit.value
    const since = nowSec - BASIS_SECONDS
    const params = new URLSearchParams({ granularity: '60', start: iso(since - 120), end: iso(nowSec) })
    const value = (async () => {
      const res = await fetcher(`${COINBASE}/products/${encodeURIComponent(product)}/candles?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`Coinbase answered ${res.status}`)
      return measureBasis(windows, minuteAverages(await res.json()), since)
    })()
    // A failed read is tried again on the next poll, not a minute later.
    value.catch(() => basisCache.get(product)?.value === value && basisCache.delete(product))
    basisCache.set(product, { at: now(), value })
    return value
  }

  const strikeFor = async (product: string): Promise<PolymarketStrikeReply> => {
    const feed = POLYMARKET_SERIES[product]
    if (!feed) throw Object.assign(new Error('Polymarket Strike follows Bitcoin only.'), { status: 404 })
    const nowSec = Math.floor(now() / 1000)
    let current: PolymarketCurrent | null = null
    let history: PolymarketWindow[] = []
    const problems: string[] = []
    try {
      current = await currentOf(feed, nowSec)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
    try {
      // Gamma answers 100 windows a read: about 8 hours of strikes, refreshed once a minute.
      history = parseHistory(await get(`${GAMMA}/events?series_slug=${feed.series}&closed=true&order=endDate&ascending=false&limit=100`, 60_000))
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
    if (problems.length && !current && !history.length) throw new Error(problems[0])
    return {
      product,
      series: feed.series,
      current,
      history,
      basis: await basisFor(product, current ? [...history, current] : history, nowSec).catch(() => null),
      fetchedAt: now(),
      message: problems[0] ?? (current ? `Polymarket ${feed.series}` : 'Polymarket has not published this window’s strike yet.'),
    }
  }

  return {
    strikeFor,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/api/polymarket/strike') return false
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        send(200, await strikeFor(url.searchParams.get('product') ?? ''))
      } catch (error) {
        const status = (error as { status?: number }).status ?? 502
        send(status, { error: error instanceof Error ? error.message : String(error) })
      }
      return true
    },
  }
}

/** Serves /api/polymarket/strike from `npm run dev` and `npm run preview`. */
export function polymarketPlugin(): Plugin {
  const api = createPolymarketApi()
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    void api.handle(req, res).then((handled) => !handled && next())
  }
  return {
    name: 'cryptoanal-polymarket',
    configureServer(server) {
      server.middlewares.use(use)
    },
    configurePreviewServer(server) {
      server.middlewares.use(use)
    },
  }
}
