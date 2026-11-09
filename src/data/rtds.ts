/**
 * Reading Polymarket's Real-Time Data Socket, shared by the dev server's recorder
 * (server/chainlink.ts) and the browser's live feed (src/data/chainlink.ts).
 */

export const RTDS_URL = 'wss://ws-live-data.polymarket.com'

/** One price out of a socket message. */
export interface ChainlinkTick {
  symbol: string
  /** Milliseconds since the epoch. */
  ms: number
  value: number
}

const finite = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * The prices in one socket message: an update carries one, the first message of a subscription a
 * minute of them (under topic `crypto_prices`, oddly). Anything else (PONG, blanks) gives none.
 */
export function parseRtds(text: string): ChainlinkTick[] {
  if (!text || text[0] !== '{') return []
  let msg: { topic?: unknown; payload?: { symbol?: unknown; value?: unknown; timestamp?: unknown; data?: unknown } }
  try {
    msg = JSON.parse(text)
  } catch {
    return []
  }
  const p = msg.payload
  const symbol = typeof p?.symbol === 'string' ? p.symbol.toLowerCase() : null
  if (!p || !symbol || !symbol.includes('/')) return []
  if (Array.isArray(p.data)) {
    const out: ChainlinkTick[] = []
    for (const row of p.data as { timestamp?: unknown; value?: unknown }[]) {
      const ms = finite(row?.timestamp)
      const value = finite(row?.value)
      if (ms !== null && value !== null && value > 0) out.push({ symbol, ms, value })
    }
    return out
  }
  if (msg.topic !== 'crypto_prices_chainlink') return []
  const ms = finite(p.timestamp)
  const value = finite(p.value)
  return ms !== null && value !== null && value > 0 ? [{ symbol, ms, value }] : []
}
