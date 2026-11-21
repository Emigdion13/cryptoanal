import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CoinbaseSpotFeed, ForcedFlowLeases } from './forcedFlow'
import type { DerivativesFeed } from './derivatives'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function fakeFeed() {
  const watches: string[] = []
  const releases: string[] = []
  const feed: DerivativesFeed = {
    watch: (product) => {
      watches.push(product)
      return () => releases.push(product)
    },
    snapshot: () => undefined,
    spotTrade: () => undefined,
    close: () => undefined,
  }
  const spot = { watch: vi.fn(), unwatch: vi.fn(), close: vi.fn() }
  return { feed, spot, watches, releases }
}

it('holds one watch while the window keeps asking, and lets go after it stops', () => {
  const { feed, spot, watches, releases } = fakeFeed()
  const leases = new ForcedFlowLeases(feed, spot, 20_000)
  leases.read('BTC-USD')
  vi.advanceTimersByTime(15_000)
  leases.read('BTC-USD')
  vi.advanceTimersByTime(15_000)
  expect(watches).toEqual(['BTC-USD'])
  expect(releases).toEqual([])
  expect(spot.watch).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(6_000)
  expect(releases).toEqual(['BTC-USD'])
  expect(spot.unwatch).toHaveBeenCalledWith('BTC-USD')
})

it('watches nothing for a product without perpetuals', () => {
  const { feed, spot, watches } = fakeFeed()
  const leases = new ForcedFlowLeases(feed, spot)
  expect(leases.read('BTC-EUR')).toBe(null)
  expect(leases.read('../etc')).toBe(null)
  expect(watches).toEqual([])
})

class FakeSocket extends EventTarget {
  readyState = 0
  sent: string[] = []
  send(data: string) {
    this.sent.push(data)
  }
  close() {}
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  message(data: unknown) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(data) }))
  }
}

it('reads Coinbase matches as taker flow: a resting sell taken is a buy', () => {
  const sockets: FakeSocket[] = []
  const trades: [string, unknown][] = []
  const spot = new CoinbaseSpotFeed(
    (product, trade) => trades.push([product, trade]),
    () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s as unknown as WebSocket
    },
  )
  spot.watch('BTC-USD')
  sockets[0].open()
  expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['matches', 'heartbeat'] })
  sockets[0].message({ type: 'last_match', product_id: 'BTC-USD', side: 'sell', price: '1', size: '1', time: '2026-11-21T10:00:00Z' })
  sockets[0].message({ type: 'match', product_id: 'BTC-USD', side: 'sell', price: '91000.5', size: '0.2', time: '2026-11-21T10:00:01Z' })
  sockets[0].message({ type: 'match', product_id: 'ETH-USD', side: 'buy', price: '3000', size: '1', time: '2026-11-21T10:00:01Z' })
  expect(trades).toEqual([['BTC-USD', { time: Date.parse('2026-11-21T10:00:01Z') / 1000, price: 91000.5, size: 0.2, takerSide: 'buy' }]])
  spot.close()
})
