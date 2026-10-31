/**
 * Kalshi's 15-minute up/down markets, for the Kalshi Strike indicator. Kalshi refuses browser
 * requests (403 to any request with an Origin), so the dev server asks for the page, as
 * btcAnalyzerV2's server does.
 *
 * The strike is Kalshi's own `floor_strike`: the 60-second average of the CF Benchmarks index
 * (BRTI for BTC) ending at the window's open — the number the market settles against, which no
 * Coinbase candle reproduces. Settled markets give every past window's strike and settlement.
 *
 * The index runs a few dollars off Coinbase (over it, mostly: $2–16 a day in late October 2026),
 * so Coinbase sitting on the strike is not even odds. `basis` measures it: each recent strike
 * against Coinbase's price over the same minute.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'

const ORIGINS = ['https://external-api.kalshi.com', 'https://api.elections.kalshi.com']
const API = '/trade-api/v2'
const COINBASE = 'https://api.exchange.coinbase.com'
export const WINDOW_SECONDS = 900
/** The gap is measured over the strikes of this long back (Coinbase answers 300 minutes a read). */
const BASIS_SECONDS = 4 * 3600

/** Coinbase product → Kalshi 15-minute series (V2's list). */
export const KALSHI_SERIES: Record<string, { series: string; digits: number }> = {
  'BTC-USD': { series: 'KXBTC15M', digits: 2 },
  'ETH-USD': { series: 'KXETH15M', digits: 2 },
  'SOL-USD': { series: 'KXSOL15M', digits: 2 },
  'XRP-USD': { series: 'KXXRP15M', digits: 4 },
  'DOGE-USD': { series: 'KXDOGE15M', digits: 5 },
  'HYPE-USD': { series: 'KXHYPE15M', digits: 4 },
  'BNB-USD': { series: 'KXBNB15M', digits: 2 },
}

export interface KalshiWindow {
  ticker: string
  /** Window open and close, unix seconds. */
  start: number
  end: number
  strike: number
  /** Settlement (60s index average ending at the close), once settled. */
  settle?: number
  result?: 'yes' | 'no'
}

export interface KalshiCurrent extends KalshiWindow {
  /** Best Yes (UP) bid and ask, in dollars per contract. */
  yesBid: number | null
  yesAsk: number | null
  /** A dead-even close resolves UP (`greater_or_equal`). */
  tieGoesUp: boolean
}

/** How far the index runs over Coinbase. */
export interface KalshiBasis {
  /** Index minus Coinbase, in dollars (negative: under): the median over the recent strikes. */
  dollars: number
  samples: number
}

export interface KalshiStrikeReply {
  product: string
  series: string
  current: KalshiCurrent | null
  /** Settled windows, oldest first. */
  history: KalshiWindow[]
  /** Null until measured (or with Coinbase unreachable). */
  basis: KalshiBasis | null
  fetchedAt: number
  message: string
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
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits
const rows = (payload: unknown): Row[] =>
  payload && typeof payload === 'object' && Array.isArray((payload as { markets?: unknown }).markets)
    ? ((payload as { markets: unknown[] }).markets.filter((m) => m && typeof m === 'object') as Row[])
    : []

function toWindow(m: Row, digits: number): KalshiWindow | null {
  const start = seconds(m.open_time)
  const end = seconds(m.close_time)
  const strike = num(m.floor_strike)
  if (start === null || end === null || strike === null || end - start !== WINDOW_SECONDS) return null
  const custom = Number((m.custom_strike as { round_digits?: unknown } | undefined)?.round_digits)
  const d = Number.isInteger(custom) && custom >= 0 && custom <= 8 ? custom : digits
  const settle = num(m.expiration_value)
  return {
    ticker: String(m.ticker ?? ''),
    start,
    end,
    strike: round(strike, d),
    ...(settle !== null && { settle: round(settle, d) }),
    ...((m.result === 'yes' || m.result === 'no') && { result: m.result }),
  }
}

/** The market running at `nowSec` out of an "open" page, with its Yes quotes. */
export function parseCurrent(payload: unknown, digits: number, nowSec: number): KalshiCurrent | null {
  for (const m of rows(payload)) {
    const w = toWindow(m, digits)
    if (!w || nowSec < w.start || nowSec >= w.end) continue
    return {
      ...w,
      yesBid: num(m.yes_bid_dollars),
      yesAsk: num(m.yes_ask_dollars),
      tieGoesUp: m.strike_type !== 'greater',
    }
  }
  return null
}

/** Settled windows, oldest first, one per open time. */
export function parseHistory(payload: unknown, digits: number): KalshiWindow[] {
  const byStart = new Map<number, KalshiWindow>()
  for (const m of rows(payload)) {
    const w = toWindow(m, digits)
    if (w) byStart.set(w.start, w)
  }
  return [...byStart.values()].sort((a, b) => a.start - b.start)
}

/**
 * The index over Coinbase: each strike since `sinceSec` (a 60-second index average ending at its
 * window's open) less Coinbase's average over that minute, `minutes` giving the 1-minute candle
 * averages by start; the median, so one wild minute does not move it.
 */
export function measureBasis(windows: readonly KalshiWindow[], minutes: ReadonlyMap<number, number>, sinceSec: number): KalshiBasis | null {
  const gaps: number[] = []
  for (const w of windows) {
    const coinbase = minutes.get(w.start - 60)
    if (w.start >= sinceSec && coinbase !== undefined) gaps.push(w.strike - coinbase)
  }
  if (gaps.length < 4) return null
  gaps.sort((a, b) => a - b)
  const mid = gaps.length >> 1
  const dollars = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2
  return { dollars: Math.round(dollars * 100) / 100, samples: gaps.length }
}

/** Coinbase's 1-minute candles as [start, low, high, open, close, …] → each minute's average. */
export function minuteAverages(payload: unknown): Map<number, number> {
  const out = new Map<number, number>()
  if (!Array.isArray(payload)) return out
  for (const row of payload) {
    if (!Array.isArray(row) || row.length < 5) continue
    const [time, low, high, open, close] = row.map(Number)
    if ([time, low, high, open, close].every(Number.isFinite)) out.set(time, (low + high + open + close) / 4)
  }
  return out
}

export function createKalshiApi(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: unknown }>()
  const pending = new Map<string, Promise<unknown>>()

  /** One Kalshi GET, cached for `ttlMs`, trying the fallback host when the first fails. */
  const get = async (path: string, ttlMs: number): Promise<unknown> => {
    const hit = cache.get(path)
    if (hit && now() - hit.at < ttlMs) return hit.value
    const inflight = pending.get(path)
    if (inflight) return inflight
    const request = (async () => {
      let last: unknown = null
      for (const origin of ORIGINS) {
        try {
          const res = await fetcher(origin + API + path, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
          if (!res.ok) throw new Error(`Kalshi answered ${res.status}`)
          const value = await res.json()
          cache.set(path, { at: now(), value })
          return value
        } catch (error) {
          last = error
        }
      }
      throw last instanceof Error ? last : new Error('Kalshi is unreachable')
    })().finally(() => pending.delete(path))
    pending.set(path, request)
    return request
  }

  const basisCache = new Map<string, { at: number; value: Promise<KalshiBasis | null> }>()
  /** The gap, measured again once a minute (one Coinbase read). */
  const basisFor = (product: string, strikes: readonly KalshiWindow[], nowSec: number): Promise<KalshiBasis | null> => {
    const hit = basisCache.get(product)
    if (hit && now() - hit.at < 60_000) return hit.value
    const since = nowSec - BASIS_SECONDS
    const params = new URLSearchParams({ granularity: '60', start: new Date((since - 120) * 1000).toISOString(), end: new Date(nowSec * 1000).toISOString() })
    const value = (async () => {
      const res = await fetcher(`${COINBASE}/products/${encodeURIComponent(product)}/candles?${params}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`Coinbase answered ${res.status}`)
      return measureBasis(strikes, minuteAverages(await res.json()), since)
    })()
    // A failed read is tried again on the next poll, not a minute later.
    value.catch(() => basisCache.get(product)?.value === value && basisCache.delete(product))
    basisCache.set(product, { at: now(), value })
    return value
  }

  const strikeFor = async (product: string): Promise<KalshiStrikeReply> => {
    const feed = KALSHI_SERIES[product]
    if (!feed) throw Object.assign(new Error('Kalshi runs no 15-minute market on this pair.'), { status: 404 })
    const nowSec = Math.floor(now() / 1000)
    let current: KalshiCurrent | null = null
    let history: KalshiWindow[] = []
    const problems: string[] = []
    try {
      current = parseCurrent(await get(`/markets?series_ticker=${feed.series}&status=open`, 2000), feed.digits, nowSec)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
    try {
      // 1000 settled windows ≈ 10 days of strikes, refreshed once a minute.
      history = parseHistory(await get(`/markets?series_ticker=${feed.series}&status=settled&limit=1000`, 60_000), feed.digits)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    }
    if (problems.length && !current && !history.length) throw new Error(problems[0])
    const strikes = current ? [...history, current] : history
    return {
      product,
      series: feed.series,
      current,
      history,
      basis: await basisFor(product, strikes, nowSec).catch(() => null),
      fetchedAt: now(),
      message: problems[0] ?? (current ? `Kalshi ${feed.series}` : 'Kalshi has not published this window’s strike yet.'),
    }
  }

  return {
    strikeFor,
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== '/api/kalshi/strike') return false
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

/** Serves /api/kalshi/strike from `npm run dev` and `npm run preview`. */
export function kalshiPlugin(): Plugin {
  const api = createKalshiApi()
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    void api.handle(req, res).then((handled) => !handled && next())
  }
  return {
    name: 'cryptoanal-kalshi',
    configureServer(server) {
      server.middlewares.use(use)
    },
    configurePreviewServer(server) {
      server.middlewares.use(use)
    },
  }
}
