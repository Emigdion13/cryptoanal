import { describe, expect, it } from 'vitest'
import { flowOver, OrderFlow, type FlowTrade } from './flow'

const t = (id: number, time: number, size: number, buy: boolean): FlowTrade => ({ id, time, size, buy })

describe('buyers vs sellers', () => {
  it('splits the window by the aggressors’ volume', () => {
    const trades = [t(1, 900, 5, false), t(2, 960, 3, true), t(3, 980, 1, false), t(4, 990, 0.5, true)]
    const flow = flowOver(trades, 1000, 60, 0)
    expect(flow.buy).toBe(3.5)
    expect(flow.sell).toBe(1)
    expect(flow.buyPct).toBeCloseTo(77.78, 2)
    expect(flow.trades).toBe(3)
    expect(flow.complete).toBe(true)
    expect(flowOver(trades, 1000, 30, 0).buyPct).toBeCloseTo(33.33, 2)
    expect(flowOver([], 1000, 30, 0).buyPct).toBeNull()
    // Trades read only from 975 on: a minute is not all there yet.
    expect(flowOver(trades, 1000, 60, 975).complete).toBe(false)
  })

  it('reads history back only as far as the window, without counting a trade twice', async () => {
    // Coinbase: trades 1..3000 one a second up to t=3000, newest first, 1000 a page.
    const reads: (number | undefined)[] = []
    const read = async (_: string, olderThan?: number) => {
      reads.push(olderThan)
      const top = olderThan === undefined ? 3000 : olderThan - 1
      const page: FlowTrade[] = []
      for (let id = top; id > Math.max(0, top - 1000); id--) page.push(t(id, id, 1, id % 4 === 0))
      return page
    }
    const book = new OrderFlow('BTC-USD', 3000, read)
    // Live trades came in while the first page was read.
    book.add(t(2999, 2999, 1, true))
    book.add(t(3000, 3000, 1, false))
    await book.fill(300, 3000)
    expect(reads).toEqual([undefined])
    expect(book.trades).toHaveLength(1000)
    expect(book.coveredFrom).toBe(2001)
    const minute = flowOver(book.trades, 3000, 60, book.coveredFrom)
    expect(minute).toMatchObject({ trades: 61, complete: true })
    await book.fill(1500, 3000)
    expect(reads).toEqual([undefined, 2001])
    expect(book.coveredFrom).toBe(1001)
    expect(new Set(book.trades.map((x) => x.id)).size).toBe(book.trades.length)
    book.prune(3000)
    expect(book.trades[0].time).toBeGreaterThanOrEqual(3000 - 960)
  })
})
