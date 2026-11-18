import { describe, expect, it } from 'vitest'
import { autoSellPrice, intentOf, parseUsBook, planBuy, polyFee, polyTotals, priceText, usRoundSlug, yesPrice, type PolyPlay } from './polyUs'

describe('the book', () => {
  // Yes (= Up) bids and offers, as /v1/markets/{slug}/book answers, in any order.
  const books = parseUsBook({
    marketData: {
      bids: [
        { px: { value: '0.33', currency: 'USD' }, qty: '456' },
        { px: { value: '0.34', currency: 'USD' }, qty: '623.16' },
      ],
      offers: [
        { px: { value: '0.37', currency: 'USD' }, qty: '50' },
        { px: { value: '0.36', currency: 'USD' }, qty: '10' },
      ],
    },
  })
  it('reads Up as the Yes book, best first', () => {
    expect(books.up.bids.map((l) => l.price)).toEqual([0.34, 0.33])
    expect(books.up.asks.map((l) => l.price)).toEqual([0.36, 0.37])
  })
  it('reads Down as the Yes book turned around: bought from Yes buyers, sold to Yes sellers', () => {
    expect(books.down.asks).toEqual([
      { price: 0.66, size: 623.16 },
      { price: 0.67, size: 456 },
    ])
    expect(books.down.bids.map((l) => l.price)).toEqual([0.64, 0.63])
  })
})

describe('orders', () => {
  it('price Down as the Yes side sold', () => {
    expect(intentOf('up', 'buy')).toBe('ORDER_INTENT_BUY_LONG')
    expect(intentOf('down', 'buy')).toBe('ORDER_INTENT_BUY_SHORT')
    expect(intentOf('down', 'sell')).toBe('ORDER_INTENT_SELL_SHORT')
    expect(yesPrice('down', 0.68)).toBe(0.32)
    expect(priceText(0.32)).toBe('0.32')
    expect(priceText(0.3249999, 0.001)).toBe('0.325')
  })
  it('buy whole contracts, fees included, never over the cap', () => {
    const asks = [
      { price: 0.5, size: 10 },
      { price: 0.53, size: 10 },
      { price: 0.6, size: 100 },
    ]
    const fill = planBuy(asks, 100, 0.55)!
    expect(fill.contracts).toBe(20)
    expect(fill.value).toBeCloseTo(10.3)
    const small = planBuy(asks, 5, 0.55)!
    expect(Number.isInteger(small.contracts)).toBe(true)
    expect(small.value + small.contracts * 0.095 * 0.25).toBeLessThanOrEqual(5)
  })
  it('charge the taker fee Θ × C × p × (1 − p)', () => {
    // The docs' example at Θ = 0.0695: 100 at 50¢ pays $1.74.
    expect(polyFee(100, 0.5, 0.0695)).toBeCloseTo(1.74, 2)
    expect(polyFee(100, 0.5)).toBeCloseTo(2.38, 2)
  })
})

describe('autoSellPrice', () => {
  it('asks the most a holding can make less 10%, a tick under $1 at most', () => {
    expect(autoSellPrice(0.52, 10)).toBe(0.96)
    expect(autoSellPrice(0.97, 10)).toBe(0.99)
    expect(autoSellPrice(0.995, 10)).toBe(null)
  })
})

describe('rounds', () => {
  it('are named by their opening, UTC', () => {
    expect(usRoundSlug(Date.parse('2026-11-18T21:40:00Z') / 1000)).toBe('cpc-btc-updown-5m-2026-11-18-2140z')
    expect(usRoundSlug(Date.parse('2026-01-02T03:05:00Z') / 1000)).toBe('cpc-btc-updown-5m-2026-01-02-0305z')
  })
})

describe('totals', () => {
  const play = (pnl: number, outcome: PolyPlay['outcome']): PolyPlay => ({ slug: 's', side: 'up', contracts: 10, cost: 5, proceeds: 5 + pnl, pnl, outcome, start: 0, end: 300, closedAt: 1 })
  it('count plays, wins and the P&L', () => {
    expect(polyTotals([play(4, 'won'), play(-5, 'lost'), play(1.5, 'auto-sold')])).toMatchObject({ plays: 3, won: 1, lost: 1, wins: 2, pnl: 0.5 })
  })
})
