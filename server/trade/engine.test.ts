import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { breakEvenMills, priceTicks, TAPERED_BANDS, type TradeTarget } from '../../src/trade/kalshiTrade'
import { TradeEngine } from './engine'
import type { KalshiKeyStore } from './keys'

const T = 'KXBTC15M-TEST'
const iso = (sec: number) => new Date(sec * 1000).toISOString()
const dollars = (mills: number) => (mills / 1000).toFixed(4)

/** A socket that never opens: the engine then reads the book over REST, as it does without a stream. */
class SilentSocket {
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send() {}
  close() {}
}

/**
 * Kalshi's demo, faked: one running BTC round with one price level a side, a holding of Up, and
 * orders that fill against the book (a buy of Up at the ask, a sale of Up at the bid).
 */
function fakeKalshi() {
  const now = Math.floor(Date.now() / 1000)
  const s = { yesBid: 600, noBid: 380, held: 0, exposure: 0, orders: [] as Record<string, unknown>[] }
  const fetcher = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/trade-api/v2', '')
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    let out: unknown = {}
    if (path === '/markets') out = { markets: [{ ticker: T, status: 'active', open_time: iso(now - 60), close_time: iso(now + 600), floor_strike: 100_000 }] }
    else if (path.startsWith('/series/')) out = { series: { fee_multiplier: 1 } }
    else if (path === `/markets/${T}/orderbook`) out = { orderbook_fp: { yes_dollars: [[dollars(s.yesBid), '1000']], no_dollars: [[dollars(s.noBid), '1000']] } }
    else if (path === '/portfolio/positions')
      out = { market_positions: s.held ? [{ ticker: T, position_fp: String(s.held), market_exposure_dollars: s.exposure.toFixed(4) }] : [] }
    else if (path === '/portfolio/orders') out = { orders: [] }
    else if (path === '/portfolio/balance') out = { balance: 100_000 }
    else if (path === '/portfolio/events/orders' && body) {
      s.orders.push(body)
      const price = Math.round(Number(body.price) * 1000)
      const count = Number(body.count)
      if (body.side === 'bid') {
        const ask = 1000 - s.noBid
        out = ask <= price ? { fill_count: count, remaining_count: 0, average_fill_price: ask / 1000 } : { fill_count: 0, remaining_count: count }
        if (ask <= price) {
          s.held += count
          s.exposure += (count * ask) / 1000
        }
      } else if (s.yesBid >= price) {
        const sold = Math.min(count, s.held)
        s.exposure = s.held ? (s.exposure * (s.held - sold)) / s.held : 0
        s.held -= sold
        out = { fill_count: sold, remaining_count: count - sold, average_fill_price: s.yesBid / 1000 }
      } else out = { fill_count: 0, remaining_count: count }
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { s, fetcher: fetcher as unknown as typeof fetch }
}

function demoKeys(): KalshiKeyStore {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const status = { configured: true, error: null }
  return {
    resolve: () => ({ demo: { keyId: 'test', key: privateKey }, live: null, liveEnabled: false, view: { file: '', demo: status, live: status, liveTrading: false } }),
  } as unknown as KalshiKeyStore
}

describe('the trailing sell every buy starts', () => {
  let engine: TradeEngine
  let kalshi: ReturnType<typeof fakeKalshi>
  const keys = demoKeys()

  beforeEach(() => {
    vi.stubGlobal('WebSocket', SilentSocket)
    kalshi = fakeKalshi()
    engine = new TradeEngine(keys, null, () => undefined, kalshi.fetcher)
  })
  afterEach(() => {
    engine.close()
    vi.unstubAllGlobals()
  })

  const trail = (): TradeTarget | undefined => engine.snapshot('demo', 'BTC-USD').targets.find((t) => t.kind === 'trail')
  /** Buyers now pay `yesBid` for Up: the engine reads the book, as it would every second. */
  const bidMoves = async (yesBid: number) => {
    kalshi.s.yesBid = yesBid
    const internals = engine as unknown as { accounts: { demo: { feeds: Map<string, unknown> } }; pollBook: (acc: unknown, feed: unknown) => Promise<void> }
    const acc = internals.accounts.demo
    await internals.pollBook.call(engine, acc, acc.feeds.get('BTC-USD'))
    await new Promise((done) => setTimeout(done, 20))
  }
  const buyUp = async () => {
    const result = await engine.buy('demo', { ticker: T, outcome: 'up', dollars: 10 })
    expect(result.filled).toBeGreaterThan(0)
    // The holding is read after the buy: the trailing sell takes its floor from it.
    await vi.waitFor(() => expect(kalshi.s.held).toBeGreaterThan(0))
    await bidMoves(kalshi.s.yesBid)
    await vi.waitFor(() => expect(trail()?.topMills).toBeGreaterThan(0))
  }
  const floor = () => breakEvenMills(kalshi.s.held, (kalshi.s.exposure / kalshi.s.held) * 1000, priceTicks(TAPERED_BANDS))!

  it('follows the highest bid and sells everything once buyers pay 5% under it, in profit', async () => {
    await buyUp()
    const least = floor()
    expect(trail()).toMatchObject({ state: 'watching', trailPct: 5, highMills: 600, topMills: least })
    // 15 at 62¢: a 66¢ sale is the first to make money after both fees.
    expect(least).toBe(660)
    const held = kalshi.s.held

    await bidMoves(800)
    expect(trail()?.highMills).toBe(800)
    await bidMoves(770) // 3.75% off the high: holds
    expect(kalshi.s.orders).toHaveLength(1)

    await bidMoves(760) // 5% off
    await vi.waitFor(() => expect(kalshi.s.orders).toHaveLength(2))
    // Everything, reduce-only, never under the price that still makes money.
    expect(kalshi.s.orders[1]).toMatchObject({ side: 'ask', count: String(held), reduce_only: true, price: dollars(least) })
    await vi.waitFor(() => expect(trail()?.state).toBe('done'))
    expect(kalshi.s.held).toBe(0)
  })

  it('does not sell at a loss: a fall from a high under the break-even waits', async () => {
    await buyUp()
    await bidMoves(640)
    await bidMoves(600) // 6% off the high, but under what was paid plus fees
    expect(kalshi.s.orders).toHaveLength(1)
    expect(trail()).toMatchObject({ state: 'watching', highMills: 640 })
  })

  it('turns off for the round, and back on', async () => {
    await buyUp()
    const off = await engine.cancelTarget('demo', { id: trail()!.id })
    expect(off.message).toMatch(/off/)
    expect(trail()?.state).toBe('canceled')
    await bidMoves(800)
    await bidMoves(700)
    expect(kalshi.s.orders).toHaveLength(1)

    await engine.setTrail('demo', { ticker: T })
    expect(trail()).toMatchObject({ state: 'watching', highMills: 700 })
  })

  it('works beside a target, and buying more keeps the same trailing sell', async () => {
    await buyUp()
    const first = trail()!.id
    await engine.setTarget('demo', { ticker: T, topMills: 900 })
    await engine.buy('demo', { ticker: T, outcome: 'up', dollars: 10 })
    const working = engine.snapshot('demo', 'BTC-USD').targets.filter((t) => t.state === 'watching')
    expect(working.map((t) => t.kind ?? 'target').sort()).toEqual(['target', 'trail'])
    expect(trail()!.id).toBe(first)
  })
})
