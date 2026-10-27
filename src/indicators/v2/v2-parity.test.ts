/**
 * The btcAnalyzerV2 ports must reproduce V2 exactly. The fixture holds real Coinbase candles and
 * what V2's own code (origin/main 4fad720) computed on them.
 */
import { describe, expect, it } from 'vitest'
import { aggregateSeconds, parseInterval } from '../../data/intervals'
import type { Candle } from '../../data/types'
import { createInstance, INDICATOR_BY_TYPE } from '../catalog'
import { rsi } from '../math'
import { calculateCmMacd, cmHistogramColor } from './cmMacd'
import { asNullable, detectMacdDivergences } from './divergence'
import { calculateTmoLux } from './tmoLux'
import golden from './fixtures/v2-golden.json'
import { calculateMsbZigZag } from './msbZigZag'
import { calculateSmc, SMC_DEFAULTS } from './smc'
import { calculateTmoScalper } from './tmoScalper'

const { m1, m5, m15 } = golden.candles as Record<string, Candle[]>
const round = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1e6) / 1e6)
const ctx = { interval: parseInterval('1')!, product: 'BTC-USD', feed: () => m1, timeToIndex: (t: number) => t }

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

  it('Stoch RSI (14, 14, 3, 3) and RSI 14, as the chart computes them', () => {
    const stoch = INDICATOR_BY_TYPE.get('stochRsi')!
    const inst = createInstance('stochRsi')
    const out = stoch.compute(m1, inst.inputs, inst.styles, ctx)
    expect(out.values.k.map(round)).toEqual(golden.stochRsi.k)
    expect(out.values.d.map(round)).toEqual(golden.stochRsi.d)
    expect(rsi(m1.map((c) => c.close), 14).map(round)).toEqual(golden.rsi)
  })

  it('RSI Divergence', () => {
    const def = INDICATOR_BY_TYPE.get('rsiDivergence')!
    const inst = createInstance('rsiDivergence')
    const r = rsi(m1.map((c) => c.close), 14)
    const settings = { showRegular: true, showHidden: true, pivotLookback: 5, rangeUpper: 60, rangeLower: 5, showLines: true, showLabels: true }
    expect(detectMacdDivergences(m1, asNullable(r), settings).map((d) => [d.label, d.fromIndex, d.toIndex])).toEqual(golden.rsiDivergences)
    expect(def.compute(m1, inst.inputs, inst.styles, ctx).drawings?.filter((d) => d.type === 'text')).toHaveLength(golden.rsiDivergences.length)
  })

  it('TMO [LuxAlgo]: histogram, colours, Buy/Sell turns and divergence lines', () => {
    const v = calculateTmoLux(m1, m1.map((c) => c.close), 7, true, false)
    expect(v.osc.map(round)).toEqual(golden.tmoLux.osc)
    expect(v.colors.map((c) => (c === 'rgba(0, 0, 0, 0)' ? '#00000000' : c))).toEqual(golden.tmoLux.colors)
    expect(v.bull).toEqual(golden.tmoLux.bull)
    expect(v.bear).toEqual(golden.tmoLux.bear)
    expect(v.lines).toEqual(golden.tmoLux.lines)
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
