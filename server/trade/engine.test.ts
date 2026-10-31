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
