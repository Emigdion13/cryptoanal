import type { Candle, Product } from './types'

const REST = 'https://api.exchange.coinbase.com'
/** Coinbase returns at most 300 candles per request. */
export const PAGE = 300

// Public endpoints allow about 10 requests a second; stay under it so paging never hits 429.
const SPACING_MS = 125
let nextSlot = 0
function throttle(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, nextSlot)
  nextSlot = at + SPACING_MS
  return at > now ? new Promise((r) => setTimeout(r, at - now)) : Promise.resolve()
}

async function getJson<T>(path: string, attempt = 0): Promise<T> {
  await throttle()
  const res = await fetch(REST + path)
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt))
    return getJson(path, attempt + 1)
  }
  if (!res.ok) throw new Error(`Coinbase ${res.status} for ${path}`)
  return res.json() as Promise<T>
}

const iso = (sec: number) => new Date(sec * 1000).toISOString()

/** Candles of `granularity` seconds whose open lies in [start, end], oldest first. */
export async function fetchCandles(
  product: string,
  granularity: number,
  start: number,
  end: number,
): Promise<Candle[]> {
  const rows = await getJson<number[][]>(
    `/products/${product}/candles?granularity=${granularity}&start=${iso(start)}&end=${iso(end)}`,
  )
  // Rows are [time, low, high, open, close, volume], newest first.
  return rows
    .map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume }))
    .filter((c) => c.time >= start && c.time <= end)
    .sort((a, b) => a.time - b.time)
}

/** Coinbase returns at most 1000 trades per request. */
export const TRADE_PAGE = 1000

export interface Trade {
  /** Rising per product. */
  id: number
  /** Seconds since the epoch, with fractions. */
  time: number
  price: number
  size: number
}

/** One page of trades, newest first: the newest of all, or those just before trade `olderThan`. */
export async function fetchTrades(product: string, olderThan?: number): Promise<Trade[]> {
  // Coinbase's `after` cursor pages back in time.
  const cursor = olderThan === undefined ? '' : `&after=${olderThan}`
  const rows = await getJson<{ trade_id: number; time: string; price: string; size: string }[]>(
    `/products/${product}/trades?limit=${TRADE_PAGE}${cursor}`,
  )
  return rows
    .map((r) => ({ id: r.trade_id, time: Date.parse(r.time) / 1000, price: Number(r.price), size: Number(r.size) }))
    .sort((a, b) => b.id - a.id)
}

interface RawProduct {
  id: string
  base_currency: string
  quote_currency: string
  quote_increment: string
  status: string
  trading_disabled: boolean
}

function decimals(increment: string): number {
  const n = Number(increment)
  if (!(n > 0)) return 2
  return Math.max(0, Math.round(-Math.log10(n)))
}

export function productFromId(id: string, increment = '0.01'): Product {
  const [base, quote] = id.split('-')
  return { id, base, quote, ticker: base + quote, precision: decimals(increment) }
}

export async function fetchProducts(): Promise<Product[]> {
  const rows = await getJson<RawProduct[]>('/products')
  return rows
    .filter((p) => p.status === 'online' && !p.trading_disabled)
    .map((p) => productFromId(p.id, p.quote_increment))
    .sort((a, b) => a.ticker.localeCompare(b.ticker))
}

/** TradingView's spelling for the quote currencies people trade most. */
const NAME_OVERRIDES: Record<string, string> = {
  USD: 'U.S. Dollar',
  USDC: 'USD Coin',
  USDT: 'Tether USDt',
  EUR: 'Euro',
  GBP: 'British Pound',
}

export const FALLBACK_NAMES: Record<string, string> = {
  ...NAME_OVERRIDES,
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  SOL: 'Solana',
  XRP: 'XRP',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
}

export async function fetchCurrencyNames(): Promise<Record<string, string>> {
  const rows = await getJson<{ id: string; name: string }[]>('/currencies')
  const names: Record<string, string> = {}
  for (const r of rows) names[r.id] = r.name
  return { ...names, ...NAME_OVERRIDES }
}
