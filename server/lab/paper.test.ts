import { describe, expect, it } from 'vitest'
import { asksFor, bidsFor, fillBuy, fillSell } from './paper'

// YES bids 60¢ ×10, 58¢ ×20; NO bids 38¢ ×5, 35¢ ×50: Up asks 62¢ ×5 then 65¢ ×50.
const book = {
  yes: [
    [600, 10],
    [580, 20],
  ],
  no: [
    [380, 5],
    [350, 50],
  ],
} as const
const FEE = 0.07

describe('paper fills on the real book', () => {
  it('reads Up asks from the NO bids, and Down asks from the YES bids', () => {
    expect(asksFor(book, 'up')).toEqual([
      { mills: 620, size: 5 },
      { mills: 650, size: 50 },
    ])
    expect(asksFor(book, 'down')[0]).toEqual({ mills: 400, size: 10 })
    expect(bidsFor(book, 'down')[0]).toEqual({ mills: 380, size: 5 })
  })

  it('walks the asks with the fee inside the dollars', () => {
    const fill = fillBuy(asksFor(book, 'up'), 10, 700, FEE)
    // 5 at 62¢ ($3.10 + 8¢ fee), then 10 at 65¢ ($6.50 + 16¢) = $9.84; an 11th does not fit.
    expect(fill.levels).toEqual([
      { mills: 620, count: 5 },
      { mills: 650, count: 10 },
    ])
    expect(fill.value + fill.fee).toBeLessThanOrEqual(10)
    expect(fill.avgMills).toBe(640)
  })

  it('never pays above the cap', () => {
    expect(fillBuy(asksFor(book, 'up'), 100, 630, FEE)).toMatchObject({ count: 5, avgMills: 620 })
    expect(fillBuy(asksFor(book, 'up'), 100, 600, FEE).count).toBe(0)
  })

  it('sells to the best bids, never under the floor', () => {
    expect(fillSell(bidsFor(book, 'up'), 15, 590, FEE)).toMatchObject({ count: 10, avgMills: 600 })
    const all = fillSell(bidsFor(book, 'up'), 15, 0, FEE)
    expect(all.levels).toEqual([
      { mills: 600, count: 10 },
      { mills: 580, count: 5 },
    ])
    expect(all.fee).toBeGreaterThan(0)
  })
})
