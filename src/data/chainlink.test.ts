import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChainlinkCache } from './cache'
import { chainlinkFeed, chainlinkProduct, rtdsSymbol, underlying } from './chainlink'
import { productFromId } from './coinbase'

describe('Chainlink products', () => {
  it('name the coin and its socket symbol', () => {
    expect(underlying('CL:BTC-USD')).toBe('BTC-USD')
    expect(underlying('BTC-USD')).toBe('BTC-USD')
    expect(rtdsSymbol('CL:ETH-USD')).toBe('eth/usd')
    expect(chainlinkProduct('CL:BTC-USD')).toEqual({ id: 'CL:BTC-USD', base: 'BTC', quote: 'USD', ticker: 'BTCUSD.CL', precision: 2 })
    expect(productFromId('CL:SOL-USD').base).toBe('SOL')
  })
})

describe('chainlinkFeed', () => {
  it('passes each price on once, newest only', () => {
    // No socket in tests: listeners are added straight to the feed's map through subscribe's bookkeeping.
    const seen: number[] = []
    const feed = chainlinkFeed as unknown as { listeners: Map<string, Set<(p: { ms: number }) => void>>; dispatch: (t: string) => void }
    feed.listeners.set('btc/usd', new Set([(p) => seen.push(p.ms)]))
    const up = (ms: number) => JSON.stringify({ topic: 'crypto_prices_chainlink', type: 'update', payload: { symbol: 'btc/usd', timestamp: ms, value: 1 } })
    feed.dispatch(JSON.stringify({ topic: 'crypto_prices', type: 'subscribe', payload: { symbol: 'btc/usd', data: [{ timestamp: 1000, value: 1 }, { timestamp: 2000, value: 1 }] } }))
    feed.dispatch(up(2000))
    feed.dispatch(up(3000))
    feed.dispatch(JSON.stringify({ topic: 'crypto_prices', type: 'subscribe', payload: { symbol: 'btc/usd', data: [{ timestamp: 2000, value: 1 }, { timestamp: 3000, value: 1 }, { timestamp: 4000, value: 1 }] } }))
    feed.dispatch(up(1_000_000).replace('btc/usd', 'eth/usd'))
    expect(seen).toEqual([1000, 2000, 3000, 4000])
    feed.listeners.delete('btc/usd')
  })
})

describe('ChainlinkCache', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** A recording of one price a minute from `earliest` to `now`, with a hole. */
  function serve(earliest: number, hole: [number, number]) {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(url)
      const q = new URL(url, 'http://x').searchParams
      const g = Number(q.get('granularity'))
      const start = Number(q.get('start'))
      const end = Number(q.get('end'))
      const candles = []
      for (let t = Math.ceil(Math.max(start, earliest) / g) * g; t <= end; t += g)
        if (t < hole[0] || t >= hole[1]) candles.push({ time: t, open: 1, high: 1, low: 1, close: 1, volume: 1 })
      return new Response(JSON.stringify({ symbol: 'btc/usd', candles, earliest, lastTick: end * 1000, connected: true }))
    })
    return calls
  }

  it('pages back over holes and stops where the recording starts', async () => {
    const now = Math.floor(Date.now() / 1000 / 60) * 60
    const earliest = now - 2000 * 60
    serve(earliest, [now - 599 * 60, now - 299 * 60])
    const cache = new ChainlinkCache('CL:BTC-USD', 60)
    await cache.loadLatest()
    expect(cache.candles).toHaveLength(300)
    expect(cache.exhausted).toBe(false)
    // The next page lies wholly in the hole: still more history behind it.
    await cache.loadOlder(1)
    expect(cache.candles).toHaveLength(300)
    expect(cache.exhausted).toBe(false)
    await cache.ensureFrom(earliest - 3600)
    expect(cache.exhausted).toBe(true)
    expect(cache.oldest).toBe(earliest)
    expect(cache.candles).toHaveLength(2001 - 300)
  })

  it('skips live prices the page already holds', async () => {
    const now = Math.floor(Date.now() / 1000 / 60) * 60
    serve(now - 3600, [0, 0])
    const cache = new ChainlinkCache('CL:BTC-USD', 60)
    await cache.loadLatest()
    const last = cache.candles.at(-1)!
    expect(cache.applyTrade(2, 1, now + 1, now * 1000)).toBe(true)
    expect(last.close).toBe(1)
    expect(cache.applyTrade(2, 1, now + 1, now * 1000 + 1000)).toBe(true)
    expect(last.close).toBe(2)
  })
})
