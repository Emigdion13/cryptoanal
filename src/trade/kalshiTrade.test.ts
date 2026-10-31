import { describe, expect, it } from 'vitest'
import {
  LiveBook,
  TAKER_FEE,
  TAPERED_BANDS,
  autoSellMills,
  buyCostDollars,
  contractsFor,
  feeDollars,
  formatCents,
  netProfitDollars,
  onGrid,
  parseBalance,
  parseBalanceBreakdown,
  parseBands,
  parseOrders,
  parsePosition,
  pickRunningMarket,
  priceTicks,
  sellNowBreakdown,
  sellNowResult,
  seriesChargesMakers,
  snapDown,
  snapUp,
  targetForPercent,
  toTradeMarket,
  toV2Order,
  type TradeMarket,
  type TradeTarget,
} from './kalshiTrade'
import { keypadNumber, keypadPress, quickBuy, quickPlan, quickSellFloor, quickTarget, quickTargets, quickAutoSell } from './quick'

const TICKS = priceTicks(TAPERED_BANDS)

describe('price grid', () => {
  it('reads Kalshi price_ranges into mills', () => {
    const bands = parseBands([
      { start: '0.0000', end: '0.1000', step: '0.0010' },
      { start: '0.1000', end: '0.9000', step: '0.0100' },
      { start: '0.9000', end: '1.0000', step: '0.0010' },
    ])
    expect(bands).toEqual(TAPERED_BANDS)
    expect(parseBands(null)).toBeNull()
    expect(parseBands([{ start: '0', end: '1', step: '0' }])).toBeNull()
  })

  it('steps 0.1¢ near the ends and 1¢ in the middle', () => {
    expect(TICKS[0]).toBe(1)
    expect(TICKS.at(-1)).toBe(999)
    expect(TICKS).toContain(95)
    expect(TICKS).not.toContain(115)
    expect(TICKS.length).toBe(100 + 80 + 99)
  })

  it('snaps onto the grid, and checks both sides of the YES book', () => {
    expect(snapDown(115, TICKS)).toBe(110)
    expect(snapUp(115, TICKS)).toBe(120)
    expect(snapUp(1000, TICKS)).toBeNull()
    expect(onGrid('down', 520, TICKS)).toBe(true)
    expect(onGrid('up', 115, TICKS)).toBe(false)
  })

  it('prints cents', () => {
    expect(formatCents(520)).toBe('52¢')
    expect(formatCents(1)).toBe('0.1¢')
    expect(formatCents(null)).toBe('—')
  })
})

describe('fees and sizing', () => {
  it('rounds the taker fee up to the hundredth of a cent, as Kalshi charged it', () => {
    expect(feeDollars(1, 580, TAKER_FEE)).toBe(0.0171)
    expect(feeDollars(38, 520, TAKER_FEE)).toBe(0.664)
    expect(buyCostDollars(1, 580, TAKER_FEE)).toBe(0.5971)
  })

  it('never spends more than the amount', () => {
    for (const dollars of [1, 5, 15, 30, 41.25])
      for (const mills of [1, 95, 300, 520, 905, 999]) {
        const count = contractsFor(dollars, mills, TAKER_FEE)
        expect(buyCostDollars(count, mills, TAKER_FEE)).toBeLessThanOrEqual(dollars + 1e-9)
        expect(buyCostDollars(count + 1, mills, TAKER_FEE)).toBeGreaterThan(dollars)
      }
  })

  it('nets selling to the bid now: 20 in at 69¢, out at 74¢ is +$0.43, not +$1.00', () => {
    const result = sellNowResult(20, 690, 740)
    expect(result.netDollars).toBeCloseTo(0.4311, 9)
    expect(result.netDollars).toBeCloseTo(netProfitDollars(20, 690, 740, 1, false, true), 9)
    expect(sellNowBreakdown(result)).toBe('+$1.00 move − $0.30 buy fee − $0.27 sale fee')
  })

  it('knows which series charge makers', () => {
    expect(seriesChargesMakers('quadratic')).toBe(false)
    expect(seriesChargesMakers('quadratic_with_maker_fees')).toBe(true)
    expect(targetForPercent(580, 10, TICKS)).toBe(640)
  })
})

describe('order mapping onto the YES book', () => {
  const base = { ticker: 'KXBTC15M-26OCT171400-00', count: 10, timeInForce: 'immediate_or_cancel' as const, clientOrderId: 'ca-test' }
  it('buys Up as a YES bid and Down as a YES ask at 100 minus the price', () => {
    expect(toV2Order({ ...base, outcome: 'up', action: 'buy', mills: 520 })).toMatchObject({ side: 'bid', price: '0.5200', count: '10' })
    expect(toV2Order({ ...base, outcome: 'down', action: 'buy', mills: 1 })).toMatchObject({ side: 'ask', price: '0.9990' })
  })
  it('sells Down as a YES bid, reduce-only when asked', () => {
    expect(toV2Order({ ...base, outcome: 'down', action: 'sell', mills: 300, count: 2.5, reduceOnly: true })).toMatchObject({
      side: 'bid',
      price: '0.7000',
      count: '2.50',
      reduce_only: true,
    })
    expect(toV2Order({ ...base, outcome: 'up', action: 'buy', mills: 520 })).not.toHaveProperty('reduce_only')
  })
})

describe('reading Kalshi payloads', () => {
  const NOW = Date.parse('2026-10-17T17:50:00Z') / 1000
  const markets = {
    markets: [
      { ticker: 'KXBTC15M-26MAY050000-00', status: 'closed', close_time: '2026-05-05T04:00:00Z' },
      {
        ticker: 'KXBTC15M-26OCT171400-00',
        status: 'active',
        open_time: '2026-10-17T17:45:00Z',
        close_time: '2026-10-17T18:00:00Z',
        floor_strike: 81182.85,
        exchange_index: 2,
      },
      { ticker: 'KXBTC15M-26OCT171415-15', status: 'active', open_time: '2026-10-17T18:00:00Z', close_time: '2026-10-17T18:15:00Z' },
    ],
  }

  it('picks the round running now, not a stale or future one', () => {
    const row = pickRunningMarket(markets, NOW)!
    expect(row.ticker).toBe('KXBTC15M-26OCT171400-00')
    expect(toTradeMarket(row, 1, false)).toMatchObject({ strike: 81182.85, exchangeIndex: 2, bands: TAPERED_BANDS })
  })

  it('reads the signed position', () => {
    const payload = { market_positions: [{ ticker: 'T', position_fp: '-930.00', market_exposure_dollars: '0.9300' }] }
    expect(parsePosition(payload, 'T')).toEqual({ outcome: 'down', contracts: 930, avgMills: 1, costDollars: 0.93 })
    expect(parsePosition(payload, 'OTHER')).toBeNull()
    expect(parsePosition({ market_positions: [{ ticker: 'T', position_fp: '0.00' }] }, 'T')).toBeNull()
  })

  it('reads resting orders only', () => {
    const orders = parseOrders({
      orders: [
        { order_id: 'b', client_order_id: 'ca-x', book_side: 'ask', status: 'resting', yes_price_dollars: '0.5800', remaining_count_fp: '19.00' },
        { order_id: 'a', side: 'yes', action: 'buy', status: 'resting', yes_price_dollars: '0.3000', remaining_count_fp: '66.00' },
        { order_id: 'c', status: 'executed', yes_price_dollars: '0.5', remaining_count_fp: '0' },
      ],
    })
    expect(orders.map((o) => [o.orderId, o.side, o.yesMills, o.remaining])).toEqual([
      ['b', 'ask', 580, 19],
      ['a', 'bid', 300, 66],
    ])
  })

  it('reads the balance, in total and per exchange', () => {
    expect(parseBalance({ balance: 41250, balance_dollars: '412.5000' })).toBe(412.5)
    expect(parseBalance({ balance: 41250 })).toBe(412.5)
    expect([
      ...parseBalanceBreakdown({
        balance_breakdown: [
          { exchange_index: 0, balance: '10.0000' },
          { exchange_index: 2, balance: '2.5000' },
        ],
      }),
    ]).toEqual([
      [0, 10],
      [2, 2.5],
    ])
  })
})

describe('the live book', () => {
  it('keeps the stream: a snapshot, then deltas, best bids and the asks they imply', () => {
    const book = new LiveBook()
    book.snapshot({
      yes_dollars_fp: [
        ['0.0600', '20.00'],
        ['0.5000', '1.92'],
      ],
      no_dollars_fp: [
        ['0.2200', '20.00'],
        ['0.4200', '2.00'],
      ],
    })
    expect(book.prices()).toEqual({ upBid: 500, upAsk: 580, downBid: 420, downAsk: 500 })
    // Kalshi's real deltas: the 50¢ bid is taken, a 48¢ bid comes in.
    expect(book.delta({ price_dollars: '0.5000', delta_fp: '-1.92', side: 'yes' })).toBe(true)
    expect(book.delta({ price_dollars: '0.4800', delta_fp: '10.00', side: 'yes' })).toBe(true)
    expect(book.prices()).toMatchObject({ upBid: 480, downAsk: 520 })
    expect(book.delta({ price_dollars: 'x', side: 'yes' })).toBe(false)
  })

  it('reads the REST book the same way', () => {
    const book = new LiveBook()
    expect(book.fromRest({ orderbook_fp: { yes_dollars: [['0.3100', '5']], no_dollars: [] } })).toBe(true)
    expect(book.prices()).toEqual({ upBid: 310, upAsk: null, downBid: null, downAsk: 690 })
    expect(book.fromRest({})).toBe(false)
  })
})

const market: TradeMarket = {
  ticker: 'KXBTC15M-26OCT201400-00',
  strike: 67240.1,
  open: 0,
  close: 900,
  upBid: 610,
  upAsk: 520,
  downBid: 480,
  downAsk: 490,
  bands: [...TAPERED_BANDS],
  feeMultiplier: 1,
  makerFees: false,
  exchangeIndex: 2,
}

describe('quick circles', () => {
  it('buys what the dollars take up to 2¢ over the ask, fee included', () => {
    expect(quickBuy(market, 'up', 5)).toEqual({ mills: 540, count: 8 })
    expect(quickBuy(market, 'up', 30)).toEqual({ mills: 540, count: 53 })
    expect(quickBuy(market, 'down', 5)?.mills).toBe(510)
    expect(quickBuy({ ...market, upAsk: null }, 'up', 5)).toBeNull()
  })

  it('prices +10% … +75% over the average on the grid, and nets the fees', () => {
    const targets = quickTargets(580, 610, 25, market)
    expect(targets.map((t) => [t.pct, t.mills, t.state])).toEqual([
      [10, 640, 'ok'],
      [20, 700, 'ok'],
      [30, 760, 'ok'],
      [50, 870, 'ok'],
      [75, null, 'over'],
    ])
    expect(targets[1].netDollars).toBeCloseTo(3 - 0.4263 - 0.3675, 4)
  })

  it('sells a target the bid is already over at the bid', () => {
    const [ten] = quickTargets(580, 650, 25, market)
    expect(ten).toMatchObject({ mills: 640, atMills: 650, state: 'bid' })
    expect(quickTarget(580, 610, 25, market, 40)).toMatchObject({ mills: 820, state: 'ok' })
  })

  it('types amounts on the keypad', () => {
    const type = (keys: string[]) => keys.reduce(keypadPress, '')
    expect(type(['1', '2', '.', '5'])).toBe('12.5')
    expect(type(['.', '5'])).toBe('0.5')
    expect(type(['1', '.', '.', '2', '5', '9'])).toBe('1.25')
    expect(type(['4', '0', 'back'])).toBe('4')
    expect(keypadNumber('0.')).toBeNull()
    expect(keypadNumber('12.5')).toBe(12.5)
  })

  it('finds the working target on this round, and sells now no lower than 2¢ under the bid', () => {
    const target: TradeTarget = {
      id: 't1',
      env: 'demo',
      ticker: market.ticker,
      outcome: 'up',
      topMills: 700,
      state: 'watching',
      message: '',
      soldContracts: 0,
      closesAt: 900_000,
    }
    expect(quickPlan([target], market.ticker)?.id).toBe('t1')
    expect(quickPlan([{ ...target, state: 'done' }], market.ticker)).toBeNull()
    expect(quickSellFloor(610, market)).toBe(590)
    expect(quickSellFloor(null, market)).toBeNull()
  })
})

describe('the auto-sell every buy queues', () => {
  it('sells at the most the buy can make less 5%, after both fees', () => {
    // 10 at 60¢ can make $3.83 (settling at $1, the buy's fee paid); 5% less is $3.64: 98.2¢.
    expect(netProfitDollars(10, 600, 1000)).toBeCloseTo(3.832, 4)
    expect(autoSellMills(10, 600, TICKS)).toBe(982)
    expect(netProfitDollars(10, 600, 981)).toBeLessThan(3.832 * 0.95)
    expect(netProfitDollars(10, 600, 982)).toBeGreaterThanOrEqual(3.832 * 0.95)
    // A cheaper buy can make more, so its 5% is more: 10 at 20¢ sells at 96.2¢.
    expect(autoSellMills(10, 200, TICKS)).toBe(962)
  })

  it('takes the top of the grid when no price makes 95%, and never sells at a loss', () => {
    expect(autoSellMills(10, 980, TICKS)).toBe(999)
    expect(netProfitDollars(10, 980, 999)).toBeGreaterThan(0)
    expect(autoSellMills(10, 999, TICKS)).toBeNull()
  })

  it('is told apart from the target', () => {
    const base: TradeTarget = { id: 'a', env: 'demo', ticker: 'T', outcome: 'up', topMills: 700, state: 'watching', message: '', soldContracts: 0, closesAt: 0 }
    const auto: TradeTarget = { ...base, id: 'b', kind: 'auto-sell', underPct: 5, topMills: 982 }
    expect(quickPlan([auto, base], 'T')?.id).toBe('a')
    expect(quickAutoSell([auto, base], 'T')?.id).toBe('b')
    expect(quickPlan([auto], 'T')).toBeNull()
  })
})
