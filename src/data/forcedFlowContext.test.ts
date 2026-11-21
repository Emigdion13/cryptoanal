import { describe, expect, it } from 'vitest'
import {
  classifyLeader,
  deribitExpiryTime,
  DISTRIBUTION_MINIMUM,
  ForcedFlowTracker,
  FORCED_WINDOW_SECONDS,
  historicalForcedEvents,
  isForcedFlow,
  LEAD_MIN_MOVE,
  parseDeribitOptions,
  parseDeribitSummary,
  parseKrakenCandleCloses,
  parseKrakenOpenInterestHistory,
  parseKrakenTickers,
  type HistoryBar,
} from './forcedFlow'

const NOW = 1_791_340_000

describe('classifyLeader', () => {
  it('names perps when the premium widens with the move, spot when it moves against it', () => {
    expect(classifyLeader(0.004, 0.0005, 0.001)).toBe('perps')
    expect(classifyLeader(-0.004, -0.0005, 0.001)).toBe('perps')
    expect(classifyLeader(0.004, -0.0005, 0.001)).toBe('spot')
    expect(classifyLeader(-0.004, 0.0005, 0.001)).toBe('spot')
    expect(classifyLeader(0.004, 0.00005, 0.001)).toBe('together')
  })

  it('names nobody while price is quiet or a side is missing', () => {
    expect(classifyLeader(0.0005, 0.001, 0.001)).toBeNull()
    expect(classifyLeader(null, 0.001, 0.001)).toBeNull()
    expect(classifyLeader(0.004, null, 0.001)).toBeNull()
  })
})

describe('ForcedFlowTracker spot against perps', () => {
  it('sums spot taker flow and reads the premium change over five minutes', () => {
    const tracker = new ForcedFlowTracker('BTC-USD')
    const start = NOW - FORCED_WINDOW_SECONDS
    // Five minutes ago: spot 84,000 and perps level with it.
    tracker.addSpotTrade({ time: start, price: 84_000, size: 1, takerSide: 'buy' }, start)
    tracker.samplePremium(start, [
      { venue: 'kraken', price: 84_000 },
      { venue: 'deribit', price: 84_000 },
    ])
    // Now: spot fell 0.5% and the perps fell further, a 0.1% discount.
    tracker.addSpotTrade({ time: NOW - 1, price: 83_580, size: 2, takerSide: 'sell' }, NOW)
    tracker.samplePremium(NOW, [
      { venue: 'kraken', price: 83_496 },
      { venue: 'deribit', price: 83_496.5 },
    ])
    const spot = tracker.snapshot(NOW).spot!
    expect(spot.soldUsd).toBeCloseTo(167_160, 0)
    expect(spot.priceChange).toBeCloseTo(-0.005, 6)
    expect(spot.premium).toBeCloseTo(83_496.25 / 83_580 - 1, 8)
    expect(spot.premiumChange).toBeLessThan(-0.0009)
    expect(spot.leader).toBe('perps')
    expect(spot.perpVenues).toEqual(['kraken', 'deribit'])
  })

  it('skips a premium sample whose spot print is stale, and drops flow past the window', () => {
    const tracker = new ForcedFlowTracker('BTC-USD')
    tracker.addSpotTrade({ time: NOW - 400, price: 84_000, size: 1, takerSide: 'buy' }, NOW - 400)
    tracker.samplePremium(NOW, [{ venue: 'kraken', price: 84_010 }])
    const spot = tracker.snapshot(NOW).spot!
    expect(spot.premium).toBeNull()
    expect(spot.leader).toBeNull()
    expect(spot.boughtUsd).toBe(0)
  })

  it('needs at least the minimum move before naming a leader while uncalibrated', () => {
    expect(LEAD_MIN_MOVE).toBeGreaterThan(0)
    const tracker = new ForcedFlowTracker('BTC-USD')
    const start = NOW - FORCED_WINDOW_SECONDS
    tracker.addSpotTrade({ time: start, price: 84_000, size: 1, takerSide: 'buy' }, start)
    tracker.samplePremium(start, [{ venue: 'kraken', price: 84_000 }])
    tracker.addSpotTrade({ time: NOW, price: 84_010, size: 1, takerSide: 'buy' }, NOW)
    tracker.samplePremium(NOW, [{ venue: 'kraken', price: 84_100 }])
    expect(tracker.snapshot(NOW).spot!.leader).toBeNull()
  })
})

describe('Deribit options', () => {
  const option = (name: string, oi: number) => ({
    instrument_name: name,
    open_interest: oi,
    estimated_delivery_price: 84_000,
  })

  it('reads expiry codes as 08:00 UTC', () => {
    expect(deribitExpiryTime('9OCT26')).toBe(Date.UTC(2026, 9, 9, 8) / 1000)
    expect(deribitExpiryTime('25DEC26')).toBe(Date.UTC(2026, 11, 25, 8) / 1000)
    expect(deribitExpiryTime('PERPETUAL')).toBeNull()
  })

  it('summarizes the expiries inside the horizon with max pain and put/call', () => {
    const payload = {
      result: [
        option('BTC-9OCT26-80000-P', 300),
        option('BTC-9OCT26-85000-C', 100),
        option('BTC-9OCT26-85000-P', 50),
        option('BTC-9OCT26-90000-C', 400),
        option('BTC-8OCT26-86000-C', 10),
        option('BTC-25DEC26-100000-C', 9_999),
        option('ETH-9OCT26-4000-C', 9_999),
        option('BTC-9OCT26-82000-X', 9_999),
      ],
    }
    const options = parseDeribitOptions(payload, 'BTC', NOW)!
    expect(options.underlying).toBe(84_000)
    expect(options.expiries.map((e) => e.code)).toEqual(['8OCT26', '9OCT26'])
    const friday = options.expiries[1]
    expect(friday.openInterest).toBe(850)
    expect(friday.putCall).toBeCloseTo(350 / 500, 6)
    // Settling at 85,000 pays 300 × 5,000 to the 80k puts and nothing else: the least of any strike.
    expect(friday.maxPain).toBe(85_000)
    expect(options.strikes.map((s) => s.strike)).toEqual([80_000, 85_000, 86_000, 90_000])
    expect(options.strikes.find((s) => s.strike === 85_000)).toEqual({
      strike: 85_000,
      callOi: 100,
      putOi: 50,
    })
  })

  it('adds a coin book to the USDC book, and reads small strikes written with a d', () => {
    const coin = { result: [option('BTC-9OCT26-85000-C', 100)] }
    const usdc = {
      result: [
        option('BTC_USDC-9OCT26-85000-C', 3),
        option('BTC_USDC-9OCT26-80000-P', 2),
        option('XRP_USDC-9OCT26-1d35-P', 51_000),
        option('XRP_USDC-9OCT26-1d5-C', 20_000),
      ],
    }
    const btc = parseDeribitOptions([coin, usdc], 'BTC', NOW)!
    expect(btc.expiries[0].openInterest).toBe(105)
    expect(btc.strikes.find((s) => s.strike === 85_000)?.callOi).toBe(103)
    const xrp = parseDeribitOptions(usdc, 'XRP', NOW)!
    expect(xrp.strikes.map((s) => s.strike)).toEqual([1.35, 1.5])
    expect(xrp.expiries[0].putCall).toBeCloseTo(51_000 / 20_000)
    expect(parseDeribitOptions(usdc, 'DOGE', NOW)).toBeNull()
  })

  it('returns null when nothing expires inside the horizon', () => {
    expect(parseDeribitOptions({ result: [option('BTC-25DEC26-100000-C', 1)] }, 'BTC', NOW)).toBe(
      null,
    )
    expect(parseDeribitOptions({ nope: true }, 'BTC', NOW)).toBeNull()
  })
})

describe('perp last prices', () => {
  it('reads the Kraken last trade with its time and the Deribit book mid', () => {
    const kraken = parseKrakenTickers({
      tickers: [
        {
          symbol: 'PF_XBTUSD',
          openInterest: 2400,
          markPrice: 84_000,
          fundingRate: 0.5,
          last: 83_990,
          lastTime: '2026-10-07T02:09:26.115Z',
        },
      ],
    }).get('PF_XBTUSD')!
    expect(kraken.last).toBe(83_990)
    expect(kraken.lastTime).toBeCloseTo(Date.parse('2026-10-07T02:09:26.115Z') / 1000, 3)
    const deribit = parseDeribitSummary(
      {
        result: [
          {
            instrument_name: 'BTC-PERPETUAL',
            open_interest: 84_000_000,
            mark_price: 84_000,
            mid_price: 84_005,
            last: 84_010,
          },
        ],
      },
      'BTC-PERPETUAL',
    )!
    expect(deribit.last).toBe(84_005)
  })
})

describe('Kraken squeeze history', () => {
  const bars = (count: number): HistoryBar[] =>
    Array.from({ length: count }, (_, i) => ({
      time: NOW - (count - i) * FORCED_WINDOW_SECONDS,
      close: 84_000 + ((i * 7) % 5) * 10,
      oiOpen: 2400,
      oiClose: 2400 + ((i * 3) % 7) - 3,
    }))

  it('replays the OI rule and merges consecutive forced bars into one event', () => {
    const tape = bars(DISTRIBUTION_MINIMUM + 50)
    const crash = DISTRIBUTION_MINIMUM + 20
    tape[crash] = { ...tape[crash], close: 83_000, oiClose: 2300 }
    tape[crash + 1] = { ...tape[crash + 1], close: 82_500, oiOpen: 2300, oiClose: 2250 }
    for (let i = crash + 2; i < tape.length; i++) tape[i] = { ...tape[i], close: 82_500 }
    const events = historicalForcedEvents('BTC-USD', tape, 0)
    // The synthetic noise repeats, so a tied noise bar can also clear the thresholds; only the
    // crash matters here.
    const squeeze = events.find((e) => e.start === tape[crash].time)
    expect(squeeze).toMatchObject({
      state: 'longs-liquidating',
      end: tape[crash + 1].time + FORCED_WINDOW_SECONDS,
      history: true,
      liquidatedUsd: 0,
    })
    expect(squeeze!.priceChange).toBeCloseTo(82_500 / tape[crash - 1].close - 1, 6)
    expect(events.some((e) => e.start === tape[crash + 1].time)).toBe(false)
    expect(
      isForcedFlow({ ...new ForcedFlowTracker('BTC-USD').snapshot(NOW), history: events }),
    ).toBe(true)
  })

  it('marks nothing before `since` or while thresholds are uncalibrated', () => {
    const tape = bars(DISTRIBUTION_MINIMUM + 50)
    tape[10] = { ...tape[10], close: 80_000, oiClose: 2000 }
    const crash = DISTRIBUTION_MINIMUM + 20
    tape[crash] = { ...tape[crash], close: 83_000, oiClose: 2300 }
    const starts = historicalForcedEvents('BTC-USD', tape, 0).map((e) => e.start)
    expect(starts).toContain(tape[crash].time)
    // The early crash lands before 100 windows of history exist.
    expect(starts).not.toContain(tape[10].time)
    const later = historicalForcedEvents('BTC-USD', tape, tape[crash + 1].time)
    expect(later.map((e) => e.start)).not.toContain(tape[crash].time)
    expect(later.every((e) => e.start >= tape[crash + 1].time)).toBe(true)
  })

  it('reads Kraken OI bars and trade candles', () => {
    expect(
      parseKrakenOpenInterestHistory({
        result: { timestamp: [100, 400], data: [['1', '2', '0.5', '1.5'], ['x']] },
      }),
    ).toEqual([{ time: 100, open: 1, close: 1.5 }])
    expect(
      parseKrakenCandleCloses({ candles: [{ time: 300_000, close: '84000.5' }, { time: 1 }] }),
    ).toEqual([{ time: 300, value: 84_000.5 }])
  })
})

describe('isForcedFlow with the new fields', () => {
  const base = () => new ForcedFlowTracker('BTC-USD').snapshot(NOW)

  it('accepts a snapshot carrying spot, options and history', () => {
    const snapshot = {
      ...base(),
      options: {
        venue: 'deribit',
        asOf: NOW,
        underlying: 84_000,
        horizonDays: 7,
        expiries: [
          { code: '9OCT26', time: NOW + 86400, openInterest: 10, putCall: 1, maxPain: 84_000 },
        ],
        strikes: [{ strike: 85_000, callOi: 5, putOi: 5 }],
      },
    }
    expect(isForcedFlow(snapshot)).toBe(true)
    expect(isForcedFlow({ ...base(), options: null })).toBe(true)
    // Older servers send none of them.
    const older: Partial<ReturnType<typeof base>> = base()
    delete older.spot
    delete older.history
    expect(isForcedFlow(older)).toBe(true)
  })

  it('rejects malformed new fields', () => {
    expect(isForcedFlow({ ...base(), spot: { leader: 'whales' } })).toBe(false)
    expect(isForcedFlow({ ...base(), options: { venue: 'okx' } })).toBe(false)
    expect(isForcedFlow({ ...base(), history: [{ id: 1 }] })).toBe(false)
  })
})
