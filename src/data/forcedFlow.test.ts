import { describe, expect, it } from 'vitest'
import {
  classifyForcedFlow,
  DISTRIBUTION_MINIMUM,
  ForcedFlowTracker,
  FORCED_WINDOW_SECONDS,
  isForcedFlow,
  LIQUIDATION_BURST_USD,
  parseCoinbaseIntlInstrument,
  parseBitgetLiquidations,
  parseDeribitLiquidations,
  parseDeribitPerpetuals,
  parseDeribitSummary,
  parseGateContract,
  parseGateLiquidations,
  parseHyperliquidContexts,
  parseKrakenLiquidations,
  parseKrakenTickers,
  parseOkxFunding,
  parseOkxInstruments,
  parseOkxLiquidations,
  parseOkxOpenInterestHistory,
  perpetualsFor,
  RollingDistribution,
  windowChanges,
  type DerivativesVenue,
} from './forcedFlow'

const thresholds = { move: 0.002, oiDrop: -0.003, oiRise: 0.003 }
const calm = { longUsd: 0, shortUsd: 0 }

describe('classifyForcedFlow', () => {
  it('calls a falling price with collapsing OI a long squeeze, rising a short squeeze', () => {
    expect(
      classifyForcedFlow({ ...thresholds, ...calm, priceChange: -0.004, oiChange: -0.006 }),
    ).toBe('longs-liquidating')
    expect(
      classifyForcedFlow({ ...thresholds, ...calm, priceChange: 0.004, oiChange: -0.006 }),
    ).toBe('shorts-liquidating')
  })

  it('separates new positions and spot-led moves from forced ones', () => {
    expect(
      classifyForcedFlow({ ...thresholds, ...calm, priceChange: -0.004, oiChange: 0.005 }),
    ).toBe('new-shorts')
    expect(
      classifyForcedFlow({ ...thresholds, ...calm, priceChange: 0.004, oiChange: 0.005 }),
    ).toBe('new-longs')
    expect(
      classifyForcedFlow({ ...thresholds, ...calm, priceChange: 0.004, oiChange: 0.001 }),
    ).toBe('big-move')
    // OI collapsing while price barely moves is people closing, not a squeeze.
    expect(
      classifyForcedFlow({ ...thresholds, ...calm, priceChange: 0.0005, oiChange: -0.01 }),
    ).toBe('calm')
  })

  it('treats a one-sided liquidation burst as forced even before OI has history', () => {
    const input = {
      priceChange: null,
      oiChange: null,
      move: null,
      oiDrop: null,
      oiRise: null,
    }
    expect(classifyForcedFlow({ ...input, longUsd: LIQUIDATION_BURST_USD, shortUsd: 0 })).toBe(
      'longs-liquidating',
    )
    expect(classifyForcedFlow({ ...input, longUsd: 0, shortUsd: LIQUIDATION_BURST_USD * 3 })).toBe(
      'shorts-liquidating',
    )
    // Both sides flushing at once is not one-sided.
    expect(
      classifyForcedFlow({
        ...input,
        longUsd: LIQUIDATION_BURST_USD,
        shortUsd: LIQUIDATION_BURST_USD,
      }),
    ).toBe('warming-up')
  })
})

describe('RollingDistribution and windowChanges', () => {
  it('reads percentiles over a bounded window', () => {
    const d = new RollingDistribution(5)
    for (const v of [1, 2, 3, 4, 5, 6, 7]) d.push(v)
    expect(d.size).toBe(5)
    expect(d.percentile(0)).toBe(3)
    expect(d.percentile(0.99)).toBe(7)
  })

  it('only counts exactly five-minute steps', () => {
    expect(
      windowChanges([
        { time: 600, value: 110 },
        { time: 0, value: 100 },
        { time: 300, value: 100 },
        { time: 1200, value: 99 },
      ]),
    ).toEqual([0, expect.closeTo(0.1, 10)])
  })
})

/** A tracker whose thresholds are already calibrated on quiet history. */
function calibratedTracker() {
  const tracker = new ForcedFlowTracker('BTC-USD')
  const quiet = Array.from({ length: DISTRIBUTION_MINIMUM }, (_, i) => ((i % 9) - 4) / 10_000)
  tracker.seed(quiet, quiet)
  return tracker
}

const sample = (venue: DerivativesVenue, time: number, openInterest: number, mark: number) => ({
  venue,
  time,
  openInterest,
  mark,
})

describe('ForcedFlowTracker', () => {
  it('sums OI across venues over five minutes and opens a squeeze event', () => {
    const tracker = calibratedTracker()
    const t0 = 1_000_000
    tracker.addOpenInterest(sample('okx', t0, 28_000, 84_000))
    tracker.addOpenInterest(sample('hyperliquid', t0, 34_000, 84_010))
    const t1 = t0 + FORCED_WINDOW_SECONDS
    tracker.addOpenInterest(sample('okx', t1, 27_500, 83_000))
    tracker.addOpenInterest(sample('hyperliquid', t1, 33_400, 83_020))
    const flow = tracker.snapshot(t1 + 1)
    expect(flow.oiVenues.sort()).toEqual(['hyperliquid', 'okx'])
    expect(flow.oiChange).toBeCloseTo((27_500 + 33_400) / (28_000 + 34_000) - 1, 10)
    expect(flow.priceChange).toBeLessThan(-0.01)
    expect(flow.state).toBe('longs-liquidating')
    expect(flow.events).toHaveLength(1)
    expect(flow.events[0]).toMatchObject({ state: 'longs-liquidating', price: 83_010 })
    // The event persists while the state does, without being duplicated.
    expect(tracker.snapshot(t1 + 2).events).toHaveLength(1)
    expect(isForcedFlow(flow)).toBe(true)
  })

  it('ignores stale venues and reports warming-up without a five-minute pair', () => {
    const tracker = calibratedTracker()
    tracker.addOpenInterest(sample('okx', 100, 28_000, 84_000))
    expect(tracker.snapshot(110).state).toBe('warming-up')
    // Two minutes later the only sample is too old to stand for now.
    expect(tracker.snapshot(300).openInterest).toBeNull()
  })

  it('sums liquidations by squeezed side over one and five minutes', () => {
    const tracker = calibratedTracker()
    const now = 5_000
    const liq = (time: number, side: 'long' | 'short', notional: number) =>
      tracker.addLiquidation(
        { venue: 'okx', time, price: 84_000, size: notional / 84_000, notional, side },
        now,
      )
    liq(now - 200, 'long', 40_000)
    liq(now - 30, 'long', 90_000)
    liq(now - 10, 'long', 20_000)
    liq(now - 5, 'short', 5_000)
    liq(now - 400, 'long', 1_000_000) // older than the five-minute memory
    const flow = tracker.snapshot(now)
    expect(flow.liquidations.longUsd).toBe(110_000)
    expect(flow.liquidations.longUsd5m).toBe(150_000)
    expect(flow.liquidations.shortUsd).toBe(5_000)
    expect(flow.state).toBe('longs-liquidating')
    expect(flow.liquidations.recent[0].time).toBe(now - 5)
  })

  it('counts a print once when a backfill repeats it, and remembers the newest print', () => {
    const tracker = calibratedTracker()
    const now = 5_000
    const print = {
      venue: 'okx' as const,
      time: now - 20,
      price: 84_000,
      size: 1.5,
      notional: 126_000,
      side: 'long' as const,
    }
    tracker.addLiquidation(print, now)
    tracker.addLiquidation({ ...print }, now + 30) // the REST list, 30 s later
    tracker.addLiquidation({ ...print, size: 0.5, notional: 42_000 }, now + 30) // same second, new order
    const flow = tracker.snapshot(now + 30)
    expect(flow.liquidations.longUsd5m).toBe(168_000)
    expect(flow.liquidations.last).toEqual({ venue: 'okx', time: now - 20 })

    // Ten minutes on, nothing is inside the window, but the box can still say when the last was.
    tracker.addLiquidation({ ...print, venue: 'gate', time: now + 100 }, now + 700)
    const later = tracker.snapshot(now + 700)
    expect(later.liquidations.recent).toEqual([])
    expect(later.liquidations.last).toEqual({ venue: 'gate', time: now + 100 })
    expect(isForcedFlow(later)).toBe(true)
  })

  it('averages funding and flags the crowded side', () => {
    const tracker = calibratedTracker()
    tracker.addFunding({ venue: 'okx', time: 10, rate8h: 0.0004 })
    tracker.addFunding({ venue: 'deribit', time: 10, rate8h: 0.0004 })
    const flow = tracker.snapshot(20)
    expect(flow.funding.rate8h).toBeCloseTo(0.0004)
    expect(flow.funding.crowded).toBe('longs')
  })
})

describe('venue parsers', () => {
  const contracts = parseOkxInstruments({
    data: [
      { instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctValCcy: 'BTC' },
      { instId: 'BTC-USD-SWAP', ctVal: '100', ctValCcy: 'USD' },
    ],
  })

  it('maps a product to each venue perpetual', () => {
    expect(perpetualsFor('BTC-USD')).toMatchObject({
      okx: ['BTC-USDT-SWAP', 'BTC-USD-SWAP'],
      kraken: 'PF_XBTUSD',
      deribit: 'BTC-PERPETUAL',
      deribitLinear: 'BTC_USDC-PERPETUAL',
      hyperliquid: 'BTC',
      gate: 'BTC_USDT',
      bitget: 'BTCUSDT',
    })
    expect(perpetualsFor('SOL-USD')).toMatchObject({
      deribit: null,
      deribitLinear: 'SOL_USDC-PERPETUAL',
    })
  })

  it('reads OKX liquidations in contracts, linear and inverse', () => {
    const parsed = parseOkxLiquidations(
      {
        data: [
          {
            instId: 'BTC-USDT-SWAP',
            details: [
              { bkPx: '84000', posSide: 'short', side: 'buy', sz: '130', ts: '1790827882554' },
            ],
          },
          {
            instId: 'BTC-USD-SWAP',
            details: [
              { bkPx: '80000', posSide: 'net', side: 'sell', sz: '50', ts: '1790827882000' },
            ],
          },
          { instId: 'AAVE-USDT-SWAP', details: [{ bkPx: '168', sz: '3', side: 'buy', ts: '1' }] },
        ],
      },
      contracts,
    )
    expect(parsed).toHaveLength(2)
    expect(parsed[0].liquidation).toMatchObject({ side: 'short', size: 1.3, notional: 109_200 })
    expect(parsed[1].liquidation).toMatchObject({ side: 'long', notional: 5000 })
    expect(parsed[1].liquidation.size).toBeCloseTo(5000 / 80_000)
  })

  it('reads Kraken liquidations, live and from the reconnect snapshot, and skips ordinary fills', () => {
    const base = {
      feed: 'trade',
      product_id: 'PF_XBTUSD',
      side: 'sell',
      time: 1790828760095,
      qty: 0.5,
      price: 83_739,
    }
    expect(parseKrakenLiquidations({ ...base, type: 'fill' })).toEqual([])
    expect(parseKrakenLiquidations({ ...base, type: 'liquidation' })[0].liquidation).toMatchObject({
      venue: 'kraken',
      side: 'long',
      size: 0.5,
    })
    const snapshot = parseKrakenLiquidations({
      feed: 'trade_snapshot',
      product_id: 'PF_XBTUSD',
      trades: [
        { ...base, feed: 'trade_snapshot', type: 'fill' },
        { ...base, feed: 'trade_snapshot', type: 'liquidation', side: 'buy', qty: 2 },
      ],
    })
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]).toMatchObject({
      productId: 'PF_XBTUSD',
      liquidation: { side: 'short', size: 2 },
    })
  })

  it('reads Gate.io liquidations in contracts, the sign naming the side', () => {
    // As received 2026-10-07: negative size printed below the market, a long closed out.
    const message = {
      time: 1791371923,
      time_ms: 1791371923239,
      channel: 'futures.public_liquidates',
      event: 'update',
      result: [
        { contract: 'ETH_USDT', price: '2567.98', time: 1791371922413, size: -119 },
        { contract: 'ETH_USDT', price: '2590.10', time: 1791371922900, size: 40 },
        { contract: 'PEPE_USDT', price: '0.00001', time: 1791371922900, size: 5 },
      ],
    }
    const parsed = parseGateLiquidations(message, new Map([['ETH_USDT', 0.01]]))
    expect(parsed).toHaveLength(2) // PEPE's multiplier is not loaded
    expect(parsed[0]).toMatchObject({
      contract: 'ETH_USDT',
      liquidation: { venue: 'gate', side: 'long', size: 1.19, time: 1791371922.413 },
    })
    expect(parsed[0].liquidation.notional).toBeCloseTo(1.19 * 2567.98)
    expect(parsed[1].liquidation).toMatchObject({ side: 'short', size: 0.4 })
    expect(parseGateLiquidations({ ...message, event: 'subscribe' }, new Map())).toEqual([])
    expect(parseGateContract({ name: 'BTC_USDT', quanto_multiplier: '0.0001' })).toEqual({
      contract: 'BTC_USDT',
      multiplier: 0.0001,
    })
    expect(parseGateContract({ label: 'CONTRACT_NOT_FOUND' })).toBeNull()
  })

  it('reads Bitget liquidations with a USDT amount', () => {
    // As received 2026-10-07. NMR's amount equals its price: one coin, so amount is USDT.
    const parsed = parseBitgetLiquidations({
      action: 'update',
      arg: { instType: 'usdt-futures', topic: 'liquidation' },
      data: [
        { symbol: 'NMRUSDT', side: 'buy', price: '16.329', amount: '16.329', ts: '1791371916984' },
        {
          symbol: 'SOLUSDT',
          side: 'sell',
          price: '117.5',
          amount: '2350',
          ts: '1791371872841',
        },
        { symbol: 'BTCUSDT', side: 'sideways', price: '84000', amount: '1', ts: '1' },
      ],
      ts: 1791371874281,
    })
    expect(parsed).toHaveLength(2)
    expect(parsed[0].liquidation).toMatchObject({ venue: 'bitget', side: 'long', size: 1 })
    expect(parsed[1]).toMatchObject({
      symbol: 'SOLUSDT',
      liquidation: { side: 'short', size: 20, notional: 2350, time: 1791371872.841 },
    })
    expect(parseBitgetLiquidations({ event: 'subscribe', arg: { topic: 'liquidation' } })).toEqual(
      [],
    )
  })

  it('reads Deribit liquidation flags for taker, maker and both', () => {
    const trade = (liquidation: string, direction: string) => ({
      instrument_name: 'BTC-PERPETUAL',
      price: 84_000,
      amount: 42_000,
      timestamp: 1790828760000,
      direction,
      liquidation,
    })
    const parsed = parseDeribitLiquidations({
      params: {
        channel: 'trades.BTC-PERPETUAL.100ms',
        data: [
          trade('T', 'sell'),
          trade('M', 'sell'),
          trade('MT', 'buy'),
          { ...trade('T', 'sell'), liquidation: undefined },
        ],
      },
    })
    expect(parsed.map((p) => p.liquidation.side)).toEqual(['long', 'short', 'short', 'long'])
    expect(parsed[0].liquidation).toMatchObject({ notional: 42_000, size: 0.5 })
  })

  it('reads a Deribit linear USDC liquidation in coins, not dollars', () => {
    const [parsed] = parseDeribitLiquidations({
      params: {
        channel: 'trades.SOL_USDC-PERPETUAL.100ms',
        data: [
          {
            instrument_name: 'SOL_USDC-PERPETUAL',
            price: 117.68,
            amount: 22.434,
            timestamp: 1791371872000,
            direction: 'buy',
            liquidation: 'T',
          },
        ],
      },
    })
    expect(parsed.liquidation).toMatchObject({ side: 'short', size: 22.434 })
    expect(parsed.liquidation.notional).toBeCloseTo(22.434 * 117.68)
  })

  it('reads OI, marks and funding from each venue', () => {
    expect(
      parseKrakenTickers({
        tickers: [
          { symbol: 'PF_XBTUSD', openInterest: 2377.4, markPrice: 83_733, fundingRate: 1.097 },
        ],
      }).get('PF_XBTUSD'),
    ).toMatchObject({ openInterest: 2377.4, rate8h: expect.closeTo(0.000105, 6) })
    expect(
      parseDeribitSummary(
        {
          result: [
            {
              instrument_name: 'BTC-PERPETUAL',
              open_interest: 793_616_340,
              mark_price: 83_747.9,
              funding_8h: 6.159e-5,
            },
          ],
        },
        'BTC-PERPETUAL',
      ),
    ).toMatchObject({ openInterest: expect.closeTo(9476.4, 0), rate8h: 6.159e-5 })
    const usdc = {
      result: [
        {
          instrument_name: 'SOL_USDC-PERPETUAL',
          open_interest: 265_055.729,
          mark_price: 117.7304,
          funding_8h: 0.00001606,
        },
        { instrument_name: 'SOL_USDC-30OCT26', open_interest: 10, mark_price: 118 },
      ],
    }
    // Linear OI is already in coins.
    expect(parseDeribitSummary(usdc, 'SOL_USDC-PERPETUAL')).toMatchObject({
      openInterest: 265_055.729,
      rate8h: 0.00001606,
    })
    expect([...parseDeribitPerpetuals(usdc)]).toEqual(['SOL_USDC-PERPETUAL'])
    expect(
      parseHyperliquidContexts([
        { universe: [{ name: 'BTC' }, { name: 'ETH' }] },
        [{ openInterest: '34794.36', markPx: '83773.0', funding: '0.0000125' }, {}],
      ]).get('BTC'),
    ).toMatchObject({ openInterest: 34_794.36, rate8h: expect.closeTo(0.0001, 10) })
    expect(
      parseCoinbaseIntlInstrument({ open_interest: '1031.8551', quote: { mark_price: '83863.3' } }),
    ).toEqual({ openInterest: 1031.8551, mark: 83_863.3 })
    expect(
      parseOkxFunding({
        data: [
          {
            fundingRate: '0.0000709797961474',
            fundingTime: '1790841600000',
            prevFundingTime: '1790812800000',
          },
        ],
      })?.rate8h,
    ).toBeCloseTo(0.000071, 6)
    expect(
      parseOkxOpenInterestHistory({
        data: [['1790828400000', '2833752.69', '28337.52', '2371808495.2']],
      }),
    ).toEqual([{ time: 1790828400, value: 28337.52 }])
  })

  it('rejects malformed payloads without throwing', () => {
    expect(
      parseOkxLiquidations({ data: [{ instId: 'BTC-USDT-SWAP', details: [{}] }] }, contracts),
    ).toEqual([])
    expect(parseDeribitLiquidations(null)).toEqual([])
    expect(parseHyperliquidContexts('nope').size).toBe(0)
    expect(isForcedFlow({ product: 'BTC-USD', state: 'boom' })).toBe(false)
  })
})
