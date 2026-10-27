/**
 * The market-structure zig-zag of EmreKb's "Market Structure Break & Order Block" (MSB-OB),
 * ported from btcAnalyzerV2 (src/lib/msb-zigzag.ts): the line joining each swing high to the next
 * swing low. As in V2, the MSB break lines and order-block boxes of the original are left out.
 *
 * The trend turns down on a bar whose low is the lowest of the last `length` bars and up on a bar
 * whose high is the highest. When it turns up, the lowest low since the last new high becomes a
 * pivot; when it turns down, the highest high since the last new low. Each leg appears once its
 * turn is confirmed, and the leg running now is not drawn.
 */
import type { Candle } from '../../data/types'

export interface MsbZigZagPivot {
  side: 'high' | 'low'
  /** The bar the high or low printed on. */
  index: number
  price: number
  /** The bar the trend turned on. */
  confirmedAt: number
}

export function calculateMsbZigZag(candles: readonly Candle[], length = 9): { trend: (1 | -1)[]; pivots: MsbZigZagPivot[] } {
  const trend: (1 | -1)[] = []
  const pivots: MsbZigZagPivot[] = []
  let current: 1 | -1 = 1
  let lastUp = -1
  let lastDown = -1
  let lowMatch = 0
  let highMatch = 0
  for (let i = 0; i < candles.length; i++) {
    const { high, low } = candles[i]
    let toUp = false
    let toDown = false
    if (i >= length - 1) {
      let highest = -Infinity
      let lowest = Infinity
      for (let j = i - length + 1; j <= i; j++) {
        highest = Math.max(highest, candles[j].high)
        lowest = Math.min(lowest, candles[j].low)
      }
      toUp = high >= highest
      toDown = low <= lowest
    }
    const turned = (current === 1 && toDown) || (current === -1 && toUp)
    if (turned) current = current === 1 ? -1 : 1
    trend.push(current)

    // ta.lowest(ta.barssince(to_up[1])); the original's window arithmetic is kept as it is.
    const lowSpan = lastUp >= 0 && i - lastUp - 1 > 0 ? i - lastUp - 1 : 1
    let lowVal = Infinity
    for (let j = i - lowSpan + 1; j <= i; j++) lowVal = Math.min(lowVal, candles[j].low)
    if (low === lowVal) lowMatch = i
    const highSpan = lastDown >= 0 && i - lastDown - 1 > 0 ? i - lastDown - 1 : 1
    let highVal = -Infinity
    for (let j = i - highSpan + 1; j <= i; j++) highVal = Math.max(highVal, candles[j].high)
    if (high === highVal) highMatch = i

    if (i > 0 && turned)
      pivots.push(
        current === 1
          ? { side: 'low', index: lowMatch, price: lowVal, confirmedAt: i }
          : { side: 'high', index: highMatch, price: highVal, confirmedAt: i },
      )
    if (toUp) lastUp = i
    if (toDown) lastDown = i
  }
  return { trend, pivots }
}
