import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoSellMills, netProfitDollars, priceTicks, TAPERED_BANDS, type TradeTarget } from '../../src/trade/kalshiTrade'
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
 * orders that fill against the book (a buy of Up at the ask, a sale of Up at the bid); a good-till-
 * canceled sale over the bid rests until `fillResting` or a cancel.
 */
function fakeKalshi() {
  const now = Math.floor(Date.now() / 1000)
  const s = { yesBid: 600, noBid: 380, held: 0, exposure: 0, orders: [] as Record<string, unknown>[], resting: [] as Record<string, unknown>[], canceled: [] as string[] }
  let ids = 0
  const sell = (count: number) => {
    const sold = Math.min(count, s.held)
    s.exposure = s.held ? (s.exposure * (s.held - sold)) / s.held : 0
    s.held -= sold
    return sold
  }
  const fetcher = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/trade-api/v2', '')
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    let out: unknown = {}
    if (path === '/markets') out = { markets: [{ ticker: T, status: 'active', open_time: iso(now - 60), close_time: iso(now + 600), floor_strike: 100_000 }] }
    else if (path.startsWith('/series/')) out = { series: { fee_multiplier: 1 } }
    else if (path === `/markets/${T}/orderbook`) out = { orderbook_fp: { yes_dollars: [[dollars(s.yesBid), '1000']], no_dollars: [[dollars(s.noBid), '1000']] } }
    else if (path === '/portfolio/positions')
      out = { market_positions: s.held ? [{ ticker: T, position_fp: String(s.held), market_exposure_dollars: s.exposure.toFixed(4) }] : [] }
    else if (path === '/portfolio/orders') out = { orders: s.resting }
    else if (path === '/portfolio/balance') out = { balance: 100_000 }
    else if (path.startsWith('/portfolio/events/orders/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop()!)
      s.canceled.push(id)
      s.resting = s.resting.filter((o) => o.order_id !== id)
    } else if (path === '/portfolio/events/orders' && body) {
      s.orders.push(body)
      const order_id = `o${++ids}`
      const price = Math.round(Number(body.price) * 1000)
      const count = Number(body.count)
      if (body.side === 'bid') {
        const ask = 1000 - s.noBid
        out = ask <= price ? { order_id, fill_count: count, remaining_count: 0, average_fill_price: ask / 1000 } : { order_id, fill_count: 0, remaining_count: count }
        if (ask <= price) {
          s.held += count
          s.exposure += (count * ask) / 1000
        }
      } else if (s.yesBid >= price) {
        const sold = sell(count)
        out = { order_id, fill_count: sold, remaining_count: count - sold, average_fill_price: s.yesBid / 1000 }
      } else {
        if (body.time_in_force === 'good_till_canceled')
          s.resting.push({ order_id, client_order_id: body.client_order_id, book_side: 'ask', yes_price_dollars: body.price, remaining_count_fp: body.count, status: 'resting' })
        out = { order_id, fill_count: 0, remaining_count: count }
      }
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  /** Buyers take the resting sales. */
  const fillResting = () => {
    for (const order of s.resting) sell(Number(order.remaining_count_fp))
    s.resting = []
  }
  return { s, fetcher: fetcher as unknown as typeof fetch, fillResting }
}

function demoKeys(): KalshiKeyStore {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const status = { configured: true, error: null }
  return {
    resolve: () => ({ demo: { keyId: 'test', key: privateKey }, live: null, liveEnabled: false, view: { file: '', demo: status, live: status, liveTrading: false } }),
  } as unknown as KalshiKeyStore
}

describe('the auto-sell every buy queues', () => {
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

  const auto = (): TradeTarget | undefined => engine.snapshot('demo', 'BTC-USD').targets.find((t) => t.kind === 'auto-sell')
  const internals = () => engine as unknown as { accounts: { demo: { queuing: Map<string, Promise<void>> } }; refreshPortfolio: (acc: unknown, ticker: string) => Promise<unknown> }
  /** The holding read again (as the stream's news or the tick would), and the auto-sell kept to it. */
  const reads = async () => {
    const acc = internals().accounts.demo
    await acc.queuing.get(T)
    await internals().refreshPortfolio.call(engine, acc, T)
    await acc.queuing.get(T)
  }
  const sells = () => kalshi.s.orders.filter((o) => o.side === 'ask')
  const buyUp = async () => {
    const result = await engine.buy('demo', { ticker: T, outcome: 'up', dollars: 10 })
    expect(result.filled).toBeGreaterThan(0)
    await vi.waitFor(() => expect(kalshi.s.resting.length).toBeGreaterThan(0))
    await reads()
  }

  it('rests a sale of everything at the most the buy can make less 5%, after fees', async () => {
    await buyUp()
    // 15 at 62¢ can make $5.45; 5% less is $5.18, at 98.3¢.
    const price = autoSellMills(15, 620, priceTicks(TAPERED_BANDS))!
    expect(price).toBe(983)
    expect(netProfitDollars(15, 620, price)).toBeGreaterThanOrEqual(netProfitDollars(15, 620, 1000) * 0.95)
    expect(kalshi.s.resting).toHaveLength(1)
    expect(sells()).toHaveLength(1)
    expect(sells()[0]).toMatchObject({ side: 'ask', count: '15', price: dollars(price), time_in_force: 'good_till_canceled' })
    expect(auto()).toMatchObject({ state: 'watching', topMills: price, underPct: 5, orderId: kalshi.s.resting[0].order_id })
    // More reads leave it be.
    await reads()
    expect(sells()).toHaveLength(1)
  })

  it('is done once buyers take it', async () => {
    await buyUp()
    kalshi.fillResting()
    await reads()
    expect(auto()).toMatchObject({ state: 'done' })
    expect(kalshi.s.held).toBe(0)
  })

  it('buying more moves it to the whole holding, at the new average', async () => {
    await buyUp()
    const first = auto()!
    kalshi.s.noBid = 480 // Up now asks 52¢
    await engine.buy('demo', { ticker: T, outcome: 'up', dollars: 10 })
    await reads()
    expect(kalshi.s.canceled).toEqual([first.orderId])
    expect(kalshi.s.resting).toHaveLength(1)
    expect(kalshi.s.resting[0].remaining_count_fp).toBe(String(kalshi.s.held))
    expect(auto()!.id).toBe(first.id)
    expect(auto()!.topMills).toBeLessThan(first.topMills)
  })

  it('turns off for the round (off Kalshi too), and back on', async () => {
    await buyUp()
    const off = await engine.cancelTarget('demo', { id: auto()!.id })
    expect(off.message).toMatch(/off/)
    expect(kalshi.s.resting).toHaveLength(0)
    await reads()
    expect(kalshi.s.resting).toHaveLength(0)
    expect(auto()?.state).toBe('canceled')

    const on = await engine.setAutoSell('demo', { ticker: T })
    expect(on.message).toMatch(/resting on Kalshi/)
    expect(kalshi.s.resting).toHaveLength(1)
    expect(auto()).toMatchObject({ state: 'watching', topMills: 983 })
  })

  it('comes off when the holding is sold elsewhere, so it never sells what is not held', async () => {
    await buyUp()
    kalshi.s.held = 0
    kalshi.s.exposure = 0
    await reads()
    expect(kalshi.s.resting).toHaveLength(0)
    expect(auto()).toMatchObject({ state: 'ended' })
  })

  it('Sell now takes it down first and ends it', async () => {
    await buyUp()
    const sold = await engine.sellNow('demo', { ticker: T })
    expect(sold.filled).toBe(15)
    expect(kalshi.s.resting).toHaveLength(0)
    expect(auto()?.state).toBe('canceled')
  })

  it('works beside a target', async () => {
    await buyUp()
    await engine.setTarget('demo', { ticker: T, topMills: 900 })
    const working = engine.snapshot('demo', 'BTC-USD').targets.filter((t) => t.state === 'watching')
    expect(working.map((t) => t.kind ?? 'target').sort()).toEqual(['auto-sell', 'target'])
  })
})

/**
 * Kalshi's demo with a round opening in about `openIn` seconds: before then, orders for it are refused
 * as Kalshi refuses them; after, a buy fills when the ask is at or under its price, a good-till-
 * canceled one rests otherwise.
 */
function nextRoundKalshi(openIn = 2) {
  const openSec = Math.floor(Date.now() / 1000) + openIn
  const N = 'KXBTC15M-NEXT'
  const s = { noBid: 450, orders: [] as Record<string, unknown>[], refused: 0, resting: [] as Record<string, unknown>[], canceled: [] as string[], sentAt: [] as number[] }
  let ids = 0
  const fetcher = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace('/trade-api/v2', '')
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    let out: unknown = {}
    if (path === '/markets')
      out = {
        markets: [
          { ticker: T, status: 'active', open_time: iso(openSec - 900), close_time: iso(openSec), floor_strike: 100_000 },
          { ticker: N, status: 'initialized', open_time: iso(openSec), close_time: iso(openSec + 900), floor_strike: 100_000 },
        ],
      }
    else if (path.startsWith('/series/')) out = { series: { fee_multiplier: 1 } }
    else if (path.startsWith('/markets/')) out = { orderbook_fp: { yes_dollars: [], no_dollars: [[dollars(s.noBid), '1000']] } }
    else if (path === '/portfolio/positions') out = { market_positions: [] }
    else if (path === '/portfolio/orders') out = { orders: s.resting }
    else if (path === '/portfolio/balance') out = { balance: 100_000 }
    else if (path.startsWith('/portfolio/events/orders/') && init?.method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop()!)
      s.canceled.push(id)
      s.resting = s.resting.filter((o) => o.order_id !== id)
    } else if (path === '/portfolio/events/orders' && body) {
      if (body.ticker === N && Date.now() < openSec * 1000) {
        s.refused++
        return new Response(JSON.stringify({ error: { code: 'market_closed', message: 'market is not open' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      }
      s.orders.push(body)
      s.sentAt.push(Date.now())
      const order_id = `o${++ids}`
      const price = Math.round(Number(body.price) * 1000)
      const count = Number(body.count)
      const ask = 1000 - s.noBid
      if (body.side === 'bid' && ask <= price) out = { order_id, fill_count: count, remaining_count: 0, average_fill_price: ask / 1000 }
      else {
        if (body.time_in_force === 'good_till_canceled')
          s.resting.push({ order_id, client_order_id: body.client_order_id, book_side: body.side, yes_price_dollars: body.price, remaining_count_fp: body.count, status: 'resting' })
        out = { order_id, fill_count: 0, remaining_count: count }
      }
    }
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { s, N, openMs: openSec * 1000, fetcher: fetcher as unknown as typeof fetch }
}

describe('the next-round buy', () => {
  let engine: TradeEngine
  let kalshi: ReturnType<typeof nextRoundKalshi>
  const keys = demoKeys()

  beforeEach(() => {
    vi.stubGlobal('WebSocket', SilentSocket)
    kalshi = nextRoundKalshi()
    engine = new TradeEngine(keys, null, () => undefined, kalshi.fetcher)
  })
  afterEach(() => {
    engine.close()
    vi.unstubAllGlobals()
  })

  const armed = () => engine.snapshot('demo', 'BTC-USD').armed[0]
  const over = () => vi.waitFor(() => expect(['done', 'missed', 'failed', 'canceled']).toContain(armed()?.state), { timeout: 6_000, interval: 50 })

  it('buys the moment the next round opens, at no more than the cap', async () => {
    const result = await engine.arm('demo', { product: 'BTC-USD', outcome: 'up', maxMills: 590, dollars: 20, waitSeconds: 0 })
    expect(result.armed).toMatchObject({ ticker: kalshi.N, opensAt: kalshi.openMs, state: 'armed', maxMills: 590 })
    // $20 at 59¢ with the taker fee.
    expect(result.armed.count).toBe(32)
    expect(armed().state).toBe('armed')
    expect(kalshi.s.orders).toHaveLength(0)
    await over()
    expect(armed()).toMatchObject({ state: 'done', filled: 32, avgFillMills: 550 })
    const [buy] = kalshi.s.orders
    expect(buy).toMatchObject({ ticker: kalshi.N, side: 'bid', price: dollars(590), count: '32', time_in_force: 'immediate_or_cancel' })
    expect(kalshi.s.sentAt[0]).toBeGreaterThanOrEqual(kalshi.openMs)
    // It knocked before the open, and Kalshi said no until then.
    expect(kalshi.s.refused).toBeGreaterThan(0)
  }, 10_000)

  it('buys nothing when the round opens above the cap', async () => {
    kalshi.s.noBid = 300 // Up asks 70¢
    await engine.arm('demo', { product: 'BTC-USD', outcome: 'up', maxMills: 590, dollars: 20, waitSeconds: 0 })
    await over()
    expect(armed()).toMatchObject({ state: 'missed', filled: 0 })
    expect(armed().message).toMatch(/opened above 59/)
  }, 10_000)

  it('waits at the cap, then cancels what did not fill', async () => {
    kalshi.s.noBid = 300
    await engine.arm('demo', { product: 'BTC-USD', outcome: 'up', maxMills: 590, dollars: 20, waitSeconds: 1 })
    await vi.waitFor(() => expect(armed().state).toBe('waiting'), { timeout: 6_000, interval: 50 })
    expect(kalshi.s.orders[0]).toMatchObject({ time_in_force: 'good_till_canceled', price: dollars(590) })
    await over()
    expect(armed()).toMatchObject({ state: 'missed' })
    expect(kalshi.s.canceled).toEqual(['o1'])
    expect(kalshi.s.resting).toHaveLength(0)
  }, 10_000)

  it('cancels before the open, and nothing is sent', async () => {
    const { armed: entry } = await engine.arm('demo', { product: 'BTC-USD', outcome: 'down', maxMills: 590, dollars: 20 })
    await engine.disarm('demo', { id: entry.id })
    expect(armed()).toMatchObject({ state: 'canceled' })
    await new Promise((done) => setTimeout(done, 2_500))
    expect(kalshi.s.orders).toHaveLength(0)
    expect(kalshi.s.refused).toBe(0)
  }, 10_000)

  it('arming again replaces the armed one', async () => {
    engine.close()
    kalshi = nextRoundKalshi(120)
    engine = new TradeEngine(keys, null, () => undefined, kalshi.fetcher)
    const first = await engine.arm('demo', { product: 'BTC-USD', outcome: 'up', maxMills: 590, dollars: 20 })
    await engine.arm('demo', { product: 'BTC-USD', outcome: 'down', maxMills: 500, dollars: 10 })
    const list = engine.snapshot('demo', 'BTC-USD').armed
    expect(list.map((a) => a.state)).toEqual(['armed', 'canceled'])
    expect(list[1].id).toBe(first.armed.id)
  })

  it('refuses a price off the grid, and a coin with no rounds', async () => {
    await expect(engine.arm('demo', { product: 'BTC-USD', outcome: 'up', maxMills: 5905, dollars: 20 })).rejects.toThrow(/not a price/)
    await expect(engine.arm('demo', { product: 'DOGE-XYZ', outcome: 'up', maxMills: 590, dollars: 20 })).rejects.toThrow(/no 15-minute/)
  })
})
