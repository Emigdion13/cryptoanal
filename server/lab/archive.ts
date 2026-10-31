/**
 * Kalshi's past 15-minute rounds, for backtests and replays: every settled round of a coin with its
 * strike, result and Up's best bid and ask minute by minute, and the coin's 1-minute Coinbase
 * candles. A finished UTC day is read once and kept in ~/.cryptoanal/lab/archive/<coin>/<day>.json.
 *
 * Kalshi moves rounds older than a cutoff (a month or two) to its historical endpoints: their list
 * comes whole (kept in historical-markets.json) and their candles one round at a time.
 *
 * Kalshi keeps only the best prices of the past, not the whole book: a replayed order fills at the
 * best price of that minute, as a small order would.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchCandles, PAGE } from '../../src/data/coinbase'
import type { Candle } from '../../src/data/types'
import { KALSHI_SERIES } from '../kalshi'
import { KalshiRest, TradeError } from '../trade/kalshi'

const DAY = 86_400
/** Kalshi's batch candlesticks answer at most 10,000 (markets × minutes asked) at once. */
const BATCH_CANDLES = 9_500

/** One minute of a round. Prices are mills of Up (520 = 52¢); null when that side of the book was empty. */
export interface ArchiveMinute {
  /** When the minute ended, unix seconds. */
  t: number
  upBid: number | null
  upAsk: number | null
  /** The best Up bid and the lowest Up ask seen during the minute (resting targets fill on these). */
  upBidHigh: number | null
  upAskLow: number | null
  /** Contracts traded in the minute. */
  volume: number
}

export interface ArchiveRound {
  ticker: string
  product: string
  /** Unix seconds. */
  open: number
  close: number
  strike: number | null
  result: 'up' | 'down' | null
  /** The index value the round settled on (Kalshi's average, not Coinbase's last trade). */
  settle: number | null
  /** 15 minutes: minute k ends at open + 60(k + 1). */
  minutes: ArchiveMinute[]
}

export interface ArchiveDay {
  version: 1
  product: string
  /** YYYY-MM-DD, UTC. */
  day: string
  rounds: ArchiveRound[]
  candles: Candle[]
}

/** Kalshi's candle; historical ones name their fields without the _dollars / _fp ends. */
interface RawCandle {
  end_period_ts: number
  volume_fp?: string
  volume?: string
  yes_bid?: { close_dollars?: string; high_dollars?: string; close?: string; high?: string }
  yes_ask?: { close_dollars?: string; low_dollars?: string; close?: string; low?: string }
}

interface RawMarket {
  ticker: string
  open_time: string
  close_time: string
  floor_strike?: number
  /** "Target Price: $78,555.98" or "Price to beat: $92,474.75": the strike of historical rounds. */
  yes_sub_title?: string
  result?: string
  expiration_value?: string
}

/** Historical candles asked for at once, and the gap between requests: Kalshi allows 20 reads a second. */
const CONCURRENCY = 4
const SPACING_MS = 70

/** The strike: Kalshi's number, else the one in the round's subtitle. */
export function strikeOf(m: Pick<RawMarket, 'floor_strike' | 'yes_sub_title'>): number | null {
  if (typeof m.floor_strike === 'number') return m.floor_strike
  const found = m.yes_sub_title?.match(/\$([\d,]+(?:\.\d+)?)/)
  const value = found ? Number(found[1].replace(/,/g, '')) : NaN
  return Number.isFinite(value) ? value : null
}

/** A round closing within (start, end]. */
const inDay = (m: RawMarket, start: number, end: number) => {
  const close = Date.parse(m.close_time) / 1000
  return close > start && close <= end
}

export const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000
export const dayOf = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

/** The UTC days from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  for (let t = dayStart(from); t <= dayStart(to); t += DAY) out.push(dayOf(t))
  return out
}

/** Dollars as Kalshi writes them to mills; an empty side (bid 0, ask $1) is null. */
function mills(raw: string | undefined, empty: number): number | null {
  if (raw === undefined) return null
  const value = Math.round(Number(raw) * 1000)
  return Number.isFinite(value) && value !== empty ? value : null
}

/** A round's 15 minutes from Kalshi's candles, each empty minute carrying the last prices on. */
export function roundMinutes(open: number, candles: readonly RawCandle[]): ArchiveMinute[] {
  const byEnd = new Map(candles.map((c) => [c.end_period_ts, c]))
  const minutes: ArchiveMinute[] = []
  let last: ArchiveMinute | null = null
  for (let k = 1; k <= 15; k++) {
    const t = open + 60 * k
    const c = byEnd.get(t)
    const minute: ArchiveMinute = c
      ? {
          t,
          upBid: mills(c.yes_bid?.close_dollars ?? c.yes_bid?.close, 0),
          upAsk: mills(c.yes_ask?.close_dollars ?? c.yes_ask?.close, 1000),
          upBidHigh: mills(c.yes_bid?.high_dollars ?? c.yes_bid?.high, 0),
          upAskLow: mills(c.yes_ask?.low_dollars ?? c.yes_ask?.low, 1000),
          volume: Number(c.volume_fp ?? c.volume) || 0,
        }
      : { t, upBid: last?.upBid ?? null, upAsk: last?.upAsk ?? null, upBidHigh: last?.upBid ?? null, upAskLow: last?.upAsk ?? null, volume: 0 }
    minutes.push(minute)
    last = minute
  }
  return minutes
}

export class Archive {
  private cutoffRead: { at: number; value: Promise<number> } | null = null
  private nextSlot = 0
  private historical = new Map<string, Promise<RawMarket[]>>()

  constructor(
    private readonly dir: string,
    private readonly kalshi = new KalshiRest('live', null),
    private readonly candles: typeof fetchCandles = fetchCandles,
  ) {}

  private file(product: string, day: string) {
    return join(this.dir, product, `${day}.json`)
  }

  /** A coin's day: from the archive when it is there, else from Kalshi and Coinbase (kept once the day is over). */
  async day(product: string, day: string): Promise<ArchiveDay> {
    try {
      const kept = JSON.parse(await readFile(this.file(product, day), 'utf8')) as ArchiveDay
      if (kept.version === 1) return kept
    } catch {
      // Read below.
    }
    const series = KALSHI_SERIES[product]?.series
    if (!series) throw new Error(`Kalshi runs no 15-minute market on ${product}.`)
    const start = dayStart(day)
    const end = Math.min(start + DAY, Math.floor(Date.now() / 1000))
    const cutoff = await this.cutoff()
    // Rounds settled before the cutoff are only in the historical list, which is complete for them.
    const old = start < cutoff ? (await this.historicalMarkets(product, series, cutoff)).filter((m) => inDay(m, start, end)) : []
    const recent = end >= cutoff ? await this.markets(series, Math.max(start, cutoff - 1), end) : []
    const markets = [...old, ...recent.filter((m) => !old.some((o) => o.ticker === m.ticker))].sort((a, b) => Date.parse(a.close_time) - Date.parse(b.close_time))
    const sticks = new Map([...(await this.historicalSticks(old)), ...(await this.sticks(markets.filter((m) => !old.includes(m))))])
    const rounds = markets.map((m): ArchiveRound => {
      const open = Date.parse(m.open_time) / 1000
      return {
        ticker: m.ticker,
        product,
        open,
        close: Date.parse(m.close_time) / 1000,
        strike: strikeOf(m),
        result: m.result === 'yes' ? 'up' : m.result === 'no' ? 'down' : null,
        settle: m.expiration_value ? Number(m.expiration_value) : null,
        minutes: roundMinutes(open, sticks.get(m.ticker) ?? []),
      }
    })
    const candles: Candle[] = []
    for (let t = start; t < end; t += PAGE * 60) candles.push(...(await this.candles(product, 60, t, Math.min(t + (PAGE - 1) * 60, end - 60))))
    const value: ArchiveDay = { version: 1, product, day, rounds, candles }
    // A day is kept once over with every result in; an empty one only when the historical list says so.
    const complete = end <= cutoff || rounds.length > 0
    if (start + DAY + 3_600 <= Date.now() / 1000 && complete && rounds.every((r) => r.result !== null)) {
      const file = this.file(product, day)
      await mkdir(join(this.dir, product), { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify(value))
      await rename(`${file}.tmp`, file)
    }
    return value
  }

  /** Several days, oldest first, reading the missing ones one after another. */
  async days(product: string, days: readonly string[], progress?: (done: number, total: number) => void): Promise<ArchiveDay[]> {
    const out: ArchiveDay[] = []
    for (const day of days) {
      out.push(await this.day(product, day))
      progress?.(out.length, days.length)
    }
    return out
  }

  /** When Kalshi's historical endpoints begin: rounds settled before it are only there (unix seconds). */
  private cutoff(): Promise<number> {
    if (!this.cutoffRead || Date.now() - this.cutoffRead.at > 3_600_000) {
      const value = (this.kalshi.call('GET', '/historical/cutoff', { authed: false }) as Promise<{ market_settled_ts?: string }>).then((body) => {
        const at = Date.parse(body.market_settled_ts ?? '')
        if (!Number.isFinite(at)) throw new Error('Kalshi sent no historical cutoff.')
        return at / 1000
      })
      this.cutoffRead = { at: Date.now(), value }
      value.catch(() => (this.cutoffRead = null))
    }
    return this.cutoffRead.value
  }

  /** Every historical round of a series, read once per cutoff and kept. */
  private historicalMarkets(product: string, series: string, cutoff: number): Promise<RawMarket[]> {
    const key = `${series}@${cutoff}`
    let list = this.historical.get(key)
    if (!list) {
      list = (async () => {
        const file = join(this.dir, product, 'historical-markets.json')
        try {
          const kept = JSON.parse(await readFile(file, 'utf8')) as { cutoff: number; markets: RawMarket[] }
          if (kept.cutoff === cutoff) return kept.markets
        } catch {
          // Read below.
        }
        const markets: RawMarket[] = []
        let cursor = ''
        for (let page = 0; page < 500; page++) {
          const query = new URLSearchParams({ series_ticker: series, limit: '1000' })
          if (cursor) query.set('cursor', cursor)
          const body = (await this.kalshi.call('GET', `/historical/markets?${query}`, { authed: false })) as { markets?: RawMarket[]; cursor?: string }
          for (const m of body.markets ?? [])
            markets.push({ ticker: m.ticker, open_time: m.open_time, close_time: m.close_time, floor_strike: m.floor_strike, yes_sub_title: m.yes_sub_title, result: m.result, expiration_value: m.expiration_value })
          cursor = body.cursor ?? ''
          if (!cursor || !body.markets?.length) break
        }
        await mkdir(join(this.dir, product), { recursive: true })
        await writeFile(`${file}.tmp`, JSON.stringify({ cutoff, markets }))
        await rename(`${file}.tmp`, file)
        return markets
      })()
      list.catch(() => this.historical.delete(key))
      this.historical.set(key, list)
    }
    return list
  }

  /** Historical rounds' candles, one round per request, a few at once. */
  private async historicalSticks(markets: readonly RawMarket[]): Promise<Map<string, RawCandle[]>> {
    const out = new Map<string, RawCandle[]>()
    let next = 0
    const worker = async () => {
      while (next < markets.length) {
        const m = markets[next++]
        const query = new URLSearchParams({ start_ts: String(Date.parse(m.open_time) / 1000), end_ts: String(Date.parse(m.close_time) / 1000), period_interval: '1' })
        const body = (await this.paced(`/historical/markets/${encodeURIComponent(m.ticker)}/candlesticks?${query}`)) as { candlesticks?: RawCandle[] }
        out.set(m.ticker, body.candlesticks ?? [])
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, markets.length) }, worker))
    return out
  }

  /** A public GET spaced from the others, waiting out Kalshi's rate limit when it is hit anyway. */
  private async paced(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const now = Date.now()
      const at = Math.max(now, this.nextSlot)
      this.nextSlot = at + SPACING_MS
      if (at > now) await new Promise((done) => setTimeout(done, at - now))
      try {
        return await this.kalshi.call('GET', path, { authed: false })
      } catch (error) {
        if (!(error instanceof TradeError && error.status === 429) || attempt >= 5) throw error
        await new Promise((done) => setTimeout(done, 2_000 * (attempt + 1)))
      }
    }
  }

  private async markets(series: string, start: number, end: number): Promise<RawMarket[]> {
    const out: RawMarket[] = []
    let cursor = ''
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ series_ticker: series, status: 'settled', limit: '200', min_close_ts: String(start + 1), max_close_ts: String(end) })
      if (cursor) query.set('cursor', cursor)
      const body = (await this.kalshi.call('GET', `/markets?${query}`, { authed: false })) as { markets?: RawMarket[]; cursor?: string }
      out.push(...(body.markets ?? []))
      cursor = body.cursor ?? ''
      if (!cursor || !body.markets?.length) break
    }
    return out
  }

  /** Each market's 1-minute candles; `markets` in time order. */
  private async sticks(markets: readonly RawMarket[]): Promise<Map<string, RawCandle[]>> {
    const out = new Map<string, RawCandle[]>()
    const life = (m: RawMarket) => [Date.parse(m.open_time) / 1000, Date.parse(m.close_time) / 1000] as const
    for (let k = 0; k < markets.length; ) {
      let [start, end] = life(markets[k])
      let n = 1
      while (k + n < markets.length) {
        const [s, e] = life(markets[k + n])
        if ((n + 1) * ((Math.max(end, e) - Math.min(start, s)) / 60 + 1) > BATCH_CANDLES) break
        start = Math.min(start, s)
        end = Math.max(end, e)
        n += 1
      }
      const group = markets.slice(k, k + n)
      k += n
      const query = new URLSearchParams({ market_tickers: group.map((m) => m.ticker).join(','), start_ts: String(start), end_ts: String(end), period_interval: '1' })
      const body = (await this.kalshi.call('GET', `/markets/candlesticks?${query}`, { authed: false })) as {
        markets?: { market_ticker?: string; ticker?: string; candlesticks?: RawCandle[] }[]
      }
      for (const m of body.markets ?? []) {
        const ticker = m.market_ticker ?? m.ticker
        if (ticker) out.set(ticker, m.candlesticks ?? [])
      }
    }
    return out
  }
}
