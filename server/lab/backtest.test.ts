import { describe, expect, it } from 'vitest'
import { roundMinutes, strikeOf, type ArchiveRound } from './archive'
import { backtest, compileRule, playRound } from './backtest'
import { Moment, normalCdf } from './moment'
import type { Scene } from './past'

const OPEN = 1_800_000_000

/** A round whose Up bid/ask step through `quotes` (cents), the coin at `price` all along. */
function scene(quotes: [number, number][], result: 'up' | 'down', opts: { price?: number; calls?: Record<string, string>; highs?: number[] } = {}): Scene {
  const minutes = quotes.map(([bid, ask], k) => ({
    t: OPEN + 60 * (k + 1),
    upBid: bid * 10,
    upAsk: ask * 10,
    upBidHigh: (opts.highs?.[k] ?? bid) * 10,
    upAskLow: ask * 10,
    volume: 100,
  }))
  const round: ArchiveRound = { ticker: `KXBTC15M-T${quotes.length}`, product: 'BTC-USD', open: OPEN, close: OPEN + 900, strike: 100, result, settle: null, minutes }
  const closes = new Map<number, number>()
  const reads = new Map<number, { calls: Record<string, string>; values: Record<string, Record<string, number | null>> }>()
  for (let t = OPEN - 7_200; t < OPEN + 900; t += 60) {
    closes.set(t, opts.price ?? 101)
    reads.set(t, { calls: opts.calls ?? { 'Parabolic SAR': 'PRICE ABOVE PARABOLICSAR' }, values: { RSI: { RSI: 55 } } })
  }
  return { round, closes, reads, before: ['down'] }
}

const flat = (bid: number, ask: number): [number, number][] => Array.from({ length: 15 }, () => [bid, ask])

describe('backtest', () => {
  it('buys at the first minute the rule holds, at the ask, and holds to the result with fees', () => {
    const quotes = flat(60, 62)
    quotes[4] = [88, 90]
    const trade = playRound(compileRule({ name: 't', side: 'favorite', enter: 'favAsk >= 85' }), scene(quotes, 'up'))!
    expect(trade).toMatchObject({ minute: 5, side: 'up', paidCents: 90, exit: 'result', won: true })
    // $10 at 90¢: 11 contracts ($9.90 + 7¢ fee), paid $1 each.
    expect(trade.contracts).toBe(11)
    expect(trade.pnl).toBeCloseTo(11 - 9.9 - trade.fees, 6)
  })

  it('buys Down at 100 minus the Up bid', () => {
    const trade = playRound(compileRule({ name: 't', side: 'down', enter: 'minute == 2' }), scene(flat(30, 32), 'down'))!
    expect(trade).toMatchObject({ minute: 2, side: 'down', paidCents: 70, won: true })
  })

  it('sells at the target when a minute reached it, else at the stop', () => {
    const highs = Array(15).fill(60)
    highs[7] = 75
    const target = playRound(compileRule({ name: 't', side: 'up', enter: 'minute == 1', target: 70 }), scene(flat(60, 62), 'down', { highs }))!
    expect(target).toMatchObject({ exit: 'target', exitMinute: 8, exitCents: 70 })
    const quotes = flat(60, 62)
    quotes[9] = [40, 42]
    const stop = playRound(compileRule({ name: 't', side: 'up', enter: 'minute == 1', stop: 45 }), scene(quotes, 'up'))!
    expect(stop).toMatchObject({ exit: 'stop', exitMinute: 10, exitCents: 40, won: false })
  })

  it('reads indicator calls and an exit rule', () => {
    const rule = compileRule({ name: 't', side: 'up', enter: 'has("SAR", "above") and value("RSI", "RSI") > 50', exit: 'gain >= 5' })
    const quotes = flat(60, 62)
    quotes[5] = [70, 72]
    expect(playRound(rule, scene(quotes, 'down'))).toMatchObject({ minute: 1, exit: 'exit', exitMinute: 6, exitCents: 70 })
    expect(playRound(rule, scene(quotes, 'down', { calls: { 'Parabolic SAR': 'PRICE BELOW PARABOLICSAR' } }))).toBeNull()
  })

  it('counts up a run: win rate, edge against the price paid, halves', () => {
    const scenes = [scene(flat(78, 80), 'up'), scene(flat(78, 80), 'up'), scene(flat(78, 80), 'down'), scene(flat(78, 80), 'up')]
    const { summary } = backtest({ name: 't', side: 'up', enter: 'minute == 3' }, scenes)
    expect(summary).toMatchObject({ rounds: 4, entered: 4, winRate: 75, avgPaidCents: 80, edgePct: -5 })
    expect(summary.halves.first.trades).toBe(2)
  })

  it('refuses rules it cannot play', () => {
    expect(() => compileRule({ name: 't', side: 'sideways', enter: 'minute == 1' })).toThrow(/No value named sideways/)
    expect(() => compileRule({ name: 't', side: 'up', enter: 'minute == 1', stake: 5000 })).toThrow(/stake/)
    expect(() => compileRule({ name: 't', side: 'up', enter: 'minute == 1', minutes: [0, 14] })).toThrow(/minutes/)
  })
})

describe('a moment of a round', () => {
  it('sees prices up to its minute and none after', () => {
    const s = scene(flat(60, 62), 'up')
    s.closes.set(OPEN + 60 * 4, 999) // the bar that closes at the end of minute 5
    expect(new Moment(s, 4).get('price')).toBe(101)
    expect(new Moment(s, 5).get('price')).toBe(999)
    expect(new Moment(s, 5).get('fromStrike')).toBe(899)
    expect(new Moment(s, 3).get('secondsLeft')).toBe(720)
  })

  it('turns a z-score into a chance', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3)
    expect(normalCdf(-1)).toBeCloseTo(0.1587, 3)
  })
})

describe('archived minutes', () => {
  it('carries the last prices over minutes without a candle, and empty sides are null', () => {
    const minutes = roundMinutes(OPEN, [
      { end_period_ts: OPEN + 60, yes_bid: { close_dollars: '0.5000', high_dollars: '0.5200' }, yes_ask: { close_dollars: '0.5100', low_dollars: '0.5000' }, volume_fp: '10' },
      { end_period_ts: OPEN + 180, yes_bid: { close_dollars: '0.0000' }, yes_ask: { close_dollars: '1.0000' } },
    ])
    expect(minutes).toHaveLength(15)
    expect(minutes[0]).toMatchObject({ upBid: 500, upAsk: 510, upBidHigh: 520, upAskLow: 500, volume: 10 })
    expect(minutes[1]).toMatchObject({ upBid: 500, upAsk: 510, volume: 0 })
    expect(minutes[2]).toMatchObject({ upBid: null, upAsk: null })
  })

  it('reads historical candles, which name their fields without _dollars', () => {
    const [minute] = roundMinutes(OPEN, [{ end_period_ts: OPEN + 60, yes_bid: { close: '0.1400', high: '0.3000' }, yes_ask: { close: '0.1500', low: '0.1500' }, volume: '646' }])
    expect(minute).toMatchObject({ upBid: 140, upAsk: 150, upBidHigh: 300, upAskLow: 150, volume: 646 })
  })

  it("finds a historical round's strike in its subtitle", () => {
    expect(strikeOf({ floor_strike: 77133.6 })).toBe(77133.6)
    expect(strikeOf({ yes_sub_title: 'Target Price: $78,555.98' })).toBe(78555.98)
    expect(strikeOf({ yes_sub_title: 'Price to beat: $92,474' })).toBe(92474)
    expect(strikeOf({ yes_sub_title: 'Target price: TBD' })).toBeNull()
  })
})
