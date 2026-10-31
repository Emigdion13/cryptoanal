/**
 * P&L per round from Kalshi's fills and settlements: round trips, wins and losses at settlement,
 * a partial sell, an open round, and the Kalshi rows as they arrive (btcAnalyzerV2's cases).
 */
import { describe, expect, it } from 'vitest'
import { historyCurve, historyRoundText, historyRounds, historyTotals, parseFills, parseSettlements, type KalshiFill } from './history'

const T = 'KXBTC15M-26OCT201615-15'
const fill = (over: Partial<KalshiFill>): KalshiFill => ({
  ticker: T,
  outcome: 'yes',
  count: 10,
  price: 0.52,
  fee: 0,
  time: 1_790_000_000,
  ...over,
})

describe('historyRounds', () => {
  it('a round trip: Up bought at 52c and sold at 61c makes +$0.88 after a 2c fee', () => {
    // Selling Up is a NO fill at 1 − 0.61; the pair nets to $1 each.
    const [round] = historyRounds(
      [fill({ fee: 0.02 }), fill({ outcome: 'no', price: 0.39, time: 1_790_000_300 })],
      [],
    )
    expect(round).toMatchObject({
      side: 'Up',
      bought: 10,
      boughtAvg: 0.52,
      sold: 10,
      soldAvg: 0.61,
      held: 0,
      outcome: 'sold',
      pnl: 0.88,
      fees: 0.02,
    })
  })

  it('held to settlement: a Down win pays $1 each, an Up loss pays nothing', () => {
    const rounds = historyRounds(
      [
        fill({ ticker: 'KXBTC15M-A', outcome: 'no', count: 8, price: 0.47, fee: 0.03 }),
        fill({ ticker: 'KXBTC15M-B', count: 12, price: 0.55, fee: 0.04, time: 1_790_000_900 }),
      ],
      [
        { ticker: 'KXBTC15M-A', result: 'no', revenue: 8, time: 1_790_000_800 },
        { ticker: 'KXBTC15M-B', result: 'no', revenue: 0, time: 1_790_001_700 },
      ],
    )
    // Newest first.
    expect(rounds.map((r) => [r.ticker, r.side, r.outcome, r.pnl])).toEqual([
      ['KXBTC15M-B', 'Up', 'lost', -6.64],
      ['KXBTC15M-A', 'Down', 'won', 4.21],
    ])
  })

  it('a partial sell, the rest held to a win', () => {
    // 10 Up at 50c, 4 sold at 60c, 6 settle at $1: −5 − 1.6 + 4 + 6 = +3.40.
    const [round] = historyRounds(
      [fill({ price: 0.5 }), fill({ outcome: 'no', count: 4, price: 0.4 })],
      [{ ticker: T, result: 'yes', revenue: 6, time: 1_790_000_900 }],
    )
    expect(round).toMatchObject({ sold: 4, soldAvg: 0.6, held: 6, outcome: 'won', pnl: 3.4 })
  })

  it('an open round has no P&L yet and stays out of the totals', () => {
    const rounds = historyRounds(
      [fill({ ticker: 'KXBTC15M-OPEN', count: 5, price: 0.5 }), fill({ fee: 0.01 })],
      [{ ticker: T, result: 'yes', revenue: 10, time: 1_790_000_900 }],
    )
    expect(rounds.find((r) => r.ticker === 'KXBTC15M-OPEN')).toMatchObject({
      outcome: 'open',
      pnl: null,
    })
    expect(historyTotals(rounds)).toEqual({ pnl: 4.79, fees: 0.01, rounds: 1, won: 1, lost: 0 })
  })

  it('names other markets Yes and No', () => {
    expect(historyRounds([fill({ ticker: 'KXFED-26DEC-T4.25' })], [])[0].side).toBe('Yes')
  })

  it('draws the running total oldest first', () => {
    const rounds = historyRounds(
      [
        fill({ ticker: 'KXBTC15M-A', fee: 0 }),
        fill({ ticker: 'KXBTC15M-A', outcome: 'no', price: 0.39, time: 1_790_000_100 }),
        fill({ ticker: 'KXBTC15M-B', time: 1_790_001_000 }),
      ],
      [{ ticker: 'KXBTC15M-B', result: 'no', revenue: 0, time: 1_790_001_800 }],
    )
    expect(historyCurve(rounds).map((p) => p.pnl)).toEqual([0.9, -4.3])
  })
})

describe('parsing Kalshi', () => {
  it('reads fills by outcome side, with the price for that side', () => {
    const fills = parseFills([
      {
        ticker: T,
        outcome_side: 'no',
        book_side: 'ask',
        count_fp: '10.00',
        yes_price_dollars: '0.6100',
        no_price_dollars: '0.3900',
        fee_cost: '0.0171',
        created_time: '2026-10-20T20:05:00Z',
      },
      {
        ticker: T,
        book_side: 'bid',
        count_fp: '2.00',
        yes_price_dollars: '0.5000',
        ts: 1_790_000_000,
      },
      { junk: true },
    ])
    expect(fills).toEqual([
      { ticker: T, outcome: 'no', count: 10, price: 0.39, fee: 0.0171, time: 1_792_526_700 },
      { ticker: T, outcome: 'yes', count: 2, price: 0.5, fee: 0, time: 1_790_000_000 },
    ])
  })

  it('reads settlements with the revenue in cents', () => {
    expect(
      parseSettlements([
        { ticker: T, market_result: 'yes', revenue: 600, settled_time: '2026-10-20T20:15:00Z' },
      ]),
    ).toEqual([{ ticker: T, result: 'yes', revenue: 6, time: 1_792_527_300 }])
  })
})

describe('the demo account, as Kalshi sent it', () => {
  // Up bought 2 at 11¢, 1.75 sold at 4¢ (a NO fill at 96¢), the last 0.25 lost at settlement.
  const fills = parseFills([
    { ticker: 'KXBTC15M-26OCT310000-00', outcome_side: 'no', book_side: 'ask', count_fp: '1.75', no_price_dollars: '0.9600', yes_price_dollars: '0.0400', fee_cost: '0.004800', created_time: '2026-10-31T03:53:17.474724Z' },
    { ticker: 'KXBTC15M-26OCT310000-00', outcome_side: 'yes', book_side: 'bid', count_fp: '2.00', no_price_dollars: '0.8900', yes_price_dollars: '0.1100', fee_cost: '0.013800', created_time: '2026-10-31T03:53:15.820608Z' },
  ])
  const settlements = parseSettlements([{ ticker: 'KXBTC15M-26OCT310000-00', market_result: 'no', revenue: 0, settled_time: '2026-10-31T04:00:05.413296Z' }])

  it('reads as Up bought, partly sold, the rest lost', () => {
    const [round] = historyRounds(fills, settlements)
    expect(round).toMatchObject({ side: 'Up', bought: 2, boughtAvg: 0.11, sold: 1.75, soldAvg: 0.04, held: 0.25, outcome: 'lost', pnl: -0.1686 })
    expect(historyRoundText(round)).toBe('Up 2 @ 11¢ · 1.75 sold at 4¢ · lost')
  })
})
