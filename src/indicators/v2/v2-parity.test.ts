/**
 * The btcAnalyzerV2 ports must reproduce V2 exactly. The fixture holds real Coinbase candles and
 * what V2's own code (commit 859951a) computed on them.
 */
import { describe, expect, it } from 'vitest'
import { aggregateSeconds } from '../../data/intervals'
import type { Candle } from '../../data/types'
import { calculateCmMacd, cmHistogramColor } from './cmMacd'
import { detectMacdDivergences } from './divergence'
import golden from './fixtures/v2-golden.json'
import { calculateMsbZigZag } from './msbZigZag'
import { calculateSmc, SMC_DEFAULTS } from './smc'
import { calculateTmoScalper } from './tmoScalper'

const { m1, m5, m15 } = golden.candles as Record<string, Candle[]>
const round = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6)

describe('btcAnalyzerV2 parity', () => {
  it('TMO Scalper: 1m / 5m / 30m lines and gated arrows', () => {
    const settings = { tmoLength: 14, calcLength: 5, smoothLength: 3, signalOffset: 2, extremeOb: 9, extremeOs: -9 }
    const v = calculateTmoScalper(m1, [m1, m5, aggregateSeconds(m15, 1800)], [60, 300, 1800], 60, settings)
    expect(v.main[0].map(round)).toEqual(golden.tmo.main1)
    expect(v.main[1].map(round)).toEqual(golden.tmo.main2)
    expect(v.main[2].map(round)).toEqual(golden.tmo.main3)
    expect(v.signal[2].map(round)).toEqual(golden.tmo.signal3)
    expect(v.bull1.map(round)).toEqual(golden.tmo.bull1)
    expect(v.bear2.map(round)).toEqual(golden.tmo.bear2)
  })

  it('CM_Ult_MacD_MTF: lines, histogram and its four colours', () => {
    const v = calculateCmMacd(m1, m1, 60, 60, { fast: 12, slow: 26, signal: 9 })
    expect(v.macd.map(round)).toEqual(golden.cm.macd)
    expect(v.histogram.map(round)).toEqual(golden.cm.histogram)
    expect(v.histogram.map((h, i) => cmHistogramColor(h, v.histogramPrevious[i]))).toEqual(golden.cm.colors)
  })

  it('MACD divergences', () => {
    const v = calculateCmMacd(m1, m1, 60, 60, { fast: 12, slow: 26, signal: 9 })
    const settings = { showRegular: true, showHidden: true, pivotLookback: 5, rangeUpper: 60, rangeLower: 5, showLines: true, showLabels: true }
    expect(detectMacdDivergences(m1, v.histogram, settings).map((d) => [d.label, d.fromIndex, d.toIndex])).toEqual(golden.divergences)
  })

  it('MSB-OB ZigZag pivots', () => {
    expect(calculateMsbZigZag(m1, 9).pivots).toEqual(golden.msbPivots)
  })

  it('Smart Money Concepts structure, order blocks, EQH/EQL and FVGs', () => {
    const r = calculateSmc(m1, { ...SMC_DEFAULTS })
    expect(r.internalEvents).toEqual(golden.smc.internalEvents)
    expect(r.swingEvents).toEqual(golden.smc.swingEvents)
    expect([...r.internalOrderBlocks, ...r.swingOrderBlocks].map((b) => b.id)).toEqual(golden.smc.orderBlocks)
    expect(r.equalLevels).toEqual(golden.smc.equalLevels)
    expect(r.fairValueGaps.map((g) => [g.side, g.startIndex, g.endIndex])).toEqual(golden.smc.fairValueGaps)
  })
})
