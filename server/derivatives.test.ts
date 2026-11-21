import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DerivativesService, OKX_BACKFILL_MS, POLL_MS, SILENCE_MS } from './derivatives'

/** A venue socket that answers keepalives the way the real ones do, until told to play dead. */
class FakeSocket extends EventTarget {
  readyState = 0
  sent: string[] = []
  /** A dead connection: still "open", answering nothing. */
  dead = false
  private heartbeat: ReturnType<typeof setInterval> | undefined
  constructor(readonly url: string) {
    super()
    queueMicrotask(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    })
  }
  send(value: string) {
    this.sent.push(value)
    if (value === 'ping') return this.reply('pong')
    const message = JSON.parse(value)
    if (message.op === 'subscribe' || message.event === 'subscribe')
      this.reply({ event: 'subscribe' })
    if (message.method) this.reply({ jsonrpc: '2.0', id: message.id, result: {} })
    if (message.channel === 'futures.ping') this.reply({ channel: 'futures.pong' })
    if (message.feed === 'heartbeat')
      this.heartbeat = setInterval(() => !this.dead && this.emit({ feed: 'heartbeat' }), 5_000)
  }
  close() {
    clearInterval(this.heartbeat)
    if (this.readyState === 3) return
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
  emit(value: unknown) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: typeof value === 'string' ? value : JSON.stringify(value),
      }),
    )
  }
  private reply(value: unknown) {
    queueMicrotask(() => !this.dead && this.emit(value))
  }
  /** Every subscribe message sent, parsed. */
  get subscriptions() {
    return this.sent.flatMap((m) => (m.startsWith('{') ? [JSON.parse(m)] : []))
  }
}

/** Every venue, answering with whatever `market` holds at the moment of the request. */
function venues() {
  const market = {
    oiScale: 1,
    price: 84_000,
    /** OKX's REST liquidation list: details for BTC-USDT-SWAP. */
    okxLiquidations: [] as Record<string, string>[],
  }
  const calls: string[] = []
  const quietHistory = (now: number, value: (i: number) => number) =>
    Array.from({ length: 120 }, (_, i) => {
      const ts = String((Math.floor(now / 300_000) - i) * 300_000)
      return [ts, String(value(i)), String(value(i)), String(value(i)), String(value(i))]
    })
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`)
    const { oiScale, price } = market
    const json = (value: unknown) => Response.json(value)
    if (url.pathname === '/api/v5/public/instruments')
      return json({ data: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC' }] })
    if (url.pathname.endsWith('/open-interest-history'))
      return json({
        data: url.searchParams.get('end')
          ? []
          : quietHistory(Date.now(), (i) => 28_000 + ((i * 7) % 5)),
      })
    if (url.pathname.endsWith('/history-candles'))
      return json({
        data: url.searchParams.get('after')
          ? []
          : quietHistory(Date.now(), (i) => 84_000 + ((i * 3) % 7)),
      })
    if (url.pathname === '/api/v5/public/open-interest')
      return json({ data: [{ instId: 'BTC-USDT-SWAP', oiCcy: String(28_000 * oiScale) }] })
    if (url.pathname === '/api/v5/public/mark-price')
      return json({ data: [{ instId: 'BTC-USDT-SWAP', markPx: String(price) }] })
    if (url.pathname === '/api/v5/public/funding-rate')
      return json({ data: [{ fundingRate: '0.0001' }] })
    if (url.host === 'futures.kraken.com')
      return json({
        tickers: [
          {
            symbol: 'PF_XBTUSD',
            openInterest: 2_400 * oiScale,
            markPrice: price,
            fundingRate: 0.5,
          },
        ],
      })
    if (url.host === 'api.hyperliquid.xyz')
      return json([
        { universe: [{ name: 'BTC' }] },
        [{ openInterest: String(34_000 * oiScale), markPx: String(price), funding: '0.00001' }],
      ])
    if (url.pathname === '/api/v5/public/liquidation-orders')
      return json({
        data:
          url.searchParams.get('instFamily') === 'BTC-USDT'
            ? [{ instId: 'BTC-USDT-SWAP', details: market.okxLiquidations }]
            : [],
      })
    if (url.host === 'www.deribit.com') {
      if (url.searchParams.get('kind') === 'option') return json({ result: [] })
      // The inverse book, and the USDC book with BTC's linear perpetual (OI in coins).
      return json({
        result:
          url.searchParams.get('currency') === 'USDC'
            ? [
                {
                  instrument_name: 'BTC_USDC-PERPETUAL',
                  open_interest: 1_600 * oiScale,
                  mark_price: price,
                  funding_8h: 0.00004,
                },
              ]
            : [
                {
                  instrument_name: 'BTC-PERPETUAL',
                  open_interest: 9_500 * oiScale * price,
                  mark_price: price,
                  funding_8h: 0.00005,
                },
              ],
      })
    }
    if (url.host === 'api.international.coinbase.com')
      return json({ open_interest: String(1_000 * oiScale), quote: { mark_price: String(price) } })
    if (url.pathname === '/api/v4/futures/usdt/contracts/BTC_USDT')
      return json({ name: 'BTC_USDT', quanto_multiplier: '0.0001' })
    return new Response('not found', { status: 404 })
  }
  return { market, calls, fetcher }
}

let service: DerivativesService | undefined
beforeEach(() => {
  vi.useFakeTimers({ now: Date.UTC(2026, 8, 30, 12, 0, 0) })
})
afterEach(() => {
  service?.close()
  service = undefined
  vi.useRealTimers()
})

it('subscribes each liquidation feed and reads a long squeeze from five venues', async () => {
  const { market, fetcher } = venues()
  const sockets: FakeSocket[] = []
  service = new DerivativesService({
    fetcher,
    socketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
  const release = service.watch('BTC-USD')
  await vi.advanceTimersByTimeAsync(3_000)

  const byHost = (host: string) => [...sockets].reverse().find((s) => s.url.includes(host))!
  expect(sockets.map((s) => new URL(s.url).host).sort()).toEqual([
    'futures.kraken.com',
    'fx-ws.gateio.ws',
    'ws.bitget.com',
    'ws.okx.com:8443',
    'www.deribit.com',
  ])
  expect(byHost('okx').subscriptions).toContainEqual({
    op: 'subscribe',
    args: [{ channel: 'liquidation-orders', instType: 'SWAP' }],
  })
  expect(byHost('kraken').subscriptions).toEqual([
    { event: 'subscribe', feed: 'trade', product_ids: ['PF_XBTUSD'] },
    { event: 'subscribe', feed: 'heartbeat' },
  ])
  // The linear perpetual joins once the USDC summary shows Deribit lists it.
  expect(
    byHost('deribit')
      .subscriptions.filter((m) => m.method === 'public/subscribe')
      .flatMap((m) => m.params.channels),
  ).toEqual(['trades.BTC-PERPETUAL.100ms', 'trades.BTC_USDC-PERPETUAL.100ms'])
  // Gate.io waits for the contract's multiplier, then subscribes just that contract.
  expect(byHost('gateio').subscriptions).toContainEqual(
    expect.objectContaining({
      channel: 'futures.public_liquidates',
      event: 'subscribe',
      payload: ['BTC_USDT'],
    }),
  )
  expect(byHost('bitget').subscriptions).toContainEqual({
    op: 'subscribe',
    args: [{ instType: 'usdt-futures', topic: 'liquidation' }],
  })

  // Five minutes later every venue's OI is 2% lower and price 1.2% lower: longs are being closed.
  await vi.advanceTimersByTimeAsync(300_000 - 3_000 - POLL_MS)
  market.oiScale = 0.98
  market.price = 83_000
  await vi.advanceTimersByTimeAsync(POLL_MS)
  const flow = service.snapshot('BTC-USD', Date.now() / 1000)!
  expect(flow.thresholds.calibrated).toBe(true)
  expect(flow.oiVenues.sort()).toEqual(['coinbase-intl', 'deribit', 'hyperliquid', 'kraken', 'okx'])
  expect(flow.oiChange).toBeCloseTo(-0.02, 6)
  expect(flow.priceChange).toBeCloseTo(83_000 / 84_000 - 1, 6)
  expect(flow.state).toBe('longs-liquidating')
  expect(flow.funding.venues).toEqual(
    expect.arrayContaining(['okx', 'kraken', 'deribit', 'hyperliquid']),
  )

  // A live Kraken liquidation of a long lands on the BTC tracker.
  byHost('kraken').emit({
    feed: 'trade',
    type: 'liquidation',
    product_id: 'PF_XBTUSD',
    side: 'sell',
    qty: 2,
    price: 83_000,
    time: Date.now(),
  })
  const after = service.snapshot('BTC-USD', Date.now() / 1000)!
  expect(after.liquidations.longUsd).toBe(166_000)
  expect(after.feeds.kraken).toBe('live')

  // Letting go of the last chart closes every socket shortly after.
  release()
  await vi.advanceTimersByTimeAsync(6_000)
  expect(sockets.every((s) => s.readyState === 3)).toBe(true)
  expect(service.snapshot('BTC-USD', Date.now() / 1000)).toBeUndefined()

  // A chart that comes back (a tab shown again) resumes the same tracker: the squeeze it saw is
  // still listed and the thresholds are still calibrated.
  service.watch('BTC-USD')
  const resumed = service.snapshot('BTC-USD', Date.now() / 1000)!
  expect(resumed.events.map((e) => e.state)).toEqual(['longs-liquidating'])
  expect(resumed.thresholds.calibrated).toBe(true)
})

function watchedService() {
  const v = venues()
  const sockets: FakeSocket[] = []
  service = new DerivativesService({
    fetcher: v.fetcher,
    socketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket as unknown as WebSocket
    },
  })
  service.watch('BTC-USD')
  const byHost = (host: string) => [...sockets].reverse().find((s) => s.url.includes(host))!
  return { ...v, sockets, byHost, flow: () => service!.snapshot('BTC-USD', Date.now() / 1000)! }
}

it('fills in OKX prints its live feed dropped, counting each print once', async () => {
  const { market, byHost, flow } = watchedService()
  await vi.advanceTimersByTimeAsync(3_000)
  const ts = String(Date.now() - 2_000)
  // Same second, two orders: the live feed carried only the first.
  const carried = { bkPx: '83000', posSide: 'long', side: 'sell', sz: '100', ts }
  const dropped = { bkPx: '82990', posSide: 'long', side: 'sell', sz: '50', ts }
  byHost('okx').emit({
    arg: { channel: 'liquidation-orders', instType: 'SWAP' },
    data: [{ instId: 'BTC-USDT-SWAP', details: [carried] }],
  })
  expect(flow().liquidations.longUsd).toBe(83_000)

  market.okxLiquidations = [carried, dropped]
  await vi.advanceTimersByTimeAsync(OKX_BACKFILL_MS)
  // 1 BTC from the live feed plus the 0.5 BTC only the REST list had; the first is not doubled.
  expect(flow().liquidations.longUsd).toBe(83_000 + 41_495)
  expect(flow().liquidations.recent.map((l) => l.venue)).toEqual(['okx', 'okx'])
})

it('routes Gate.io, Bitget and Deribit linear prints to the watched product only', async () => {
  const { byHost, flow } = watchedService()
  await vi.advanceTimersByTimeAsync(3_000)
  const now = Date.now()
  byHost('gateio').emit({
    channel: 'futures.public_liquidates',
    event: 'update',
    result: [{ contract: 'BTC_USDT', price: '83000', time: now, size: -10_000 }],
  })
  byHost('bitget').emit({
    action: 'update',
    arg: { instType: 'usdt-futures', topic: 'liquidation' },
    data: [
      { symbol: 'BTCUSDT', side: 'sell', price: '84500', amount: '20000', ts: String(now) },
      { symbol: 'ETHUSDT', side: 'buy', price: '2500', amount: '999999', ts: String(now) },
    ],
  })
  byHost('deribit').emit({
    params: {
      channel: 'trades.BTC_USDC-PERPETUAL.100ms',
      data: [
        {
          instrument_name: 'BTC_USDC-PERPETUAL',
          price: 83_000,
          amount: 0.25,
          timestamp: now,
          direction: 'sell',
          liquidation: 'T',
        },
      ],
    },
  })
  const { liquidations, feeds } = flow()
  expect(liquidations.longUsd).toBe(83_000 + 20_750) // 1 BTC on Gate.io, 0.25 on Deribit USDC
  expect(liquidations.shortUsd).toBe(20_000) // Bitget's BTC short; its ETH print is not ours
  expect(feeds).toMatchObject({ gate: 'live', bitget: 'live', deribit: 'live' })
})

it('dials again when an open socket goes silent', async () => {
  const { sockets, byHost, flow } = watchedService()
  await vi.advanceTimersByTimeAsync(3_000)
  // Keepalives and Kraken's heartbeat keep every socket inside the silence limit.
  await vi.advanceTimersByTimeAsync(SILENCE_MS * 2)
  expect(sockets).toHaveLength(5)

  const stale = byHost('bitget')
  stale.dead = true
  await vi.advanceTimersByTimeAsync(SILENCE_MS + 20_000)
  expect(stale.readyState).toBe(3)
  const fresh = byHost('bitget')
  expect(fresh).not.toBe(stale)
  expect(fresh.subscriptions).toContainEqual({
    op: 'subscribe',
    args: [{ instType: 'usdt-futures', topic: 'liquidation' }],
  })
  expect(flow().feeds.bitget).toBe('live')
})

it('stays quiet until something is watched, and ignores products it cannot map', async () => {
  const { calls, fetcher } = venues()
  const sockets: string[] = []
  service = new DerivativesService({
    fetcher,
    socketFactory: (url) => {
      sockets.push(url)
      return new FakeSocket(url) as unknown as WebSocket
    },
  })
  await vi.advanceTimersByTimeAsync(POLL_MS * 2)
  expect(calls).toEqual([])
  expect(sockets).toEqual([])
  service.watch('not a product')
  expect(service.snapshot('not a product', 0)).toBeUndefined()
})
