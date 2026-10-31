/**
 * ChrisMoody's CM_Williams_Vix_Fix, ported from btcAnalyzerV2 (src/lib/cm-williams-vix-fix.ts):
 * Larry Williams' synthetic VIX, the "fear index" for any asset — spikes read as market bottoms.
 * https://www.tradingview.com/script/og7JPrRA-CM-Williams-Vix-Fix-Finds-Market-Bottoms/
 *
 *   wvf       = ((highest(close, pd) − low) / highest(close, pd)) × 100
 *   upperBand = sma(wvf, bbl) + mult × stdev(wvf, bbl)
 *   rangeHigh = highest(wvf, lb) × ph,  rangeLow = lowest(wvf, lb) × pl
 *   lime      = wvf ≥ upperBand or wvf ≥ rangeHigh   (gray otherwise)
 *
 * Warm-up is na, and a comparison against na is false, so early bars are gray.
 */
import type { Candle } from '../../data/types'
import { ta } from './ta'

/** The original Pine v1 named colours. */
export const WVF_COLORS = { lime: '#00ff00', gray: '#808080', orange: '#ff9800', aqua: '#00ffff' } as const

export interface VixFixSettings {
  pd: number
  bbl: number
  mult: number
  lb: number
  ph: number
  pl: number
}

type Values = (number | null)[]

export interface VixFixValues {
  wvf: Values
  upperBand: Values
  rangeHigh: Values
  rangeLow: Values
  isGreen: boolean[]
}

export function calculateVixFix(candles: readonly Candle[], s: VixFixSettings): VixFixValues {
  const close = candles.map((c) => c.close)
  const highestClose = ta.highest(close, s.pd)
  const wvf = candles.map((c, i) => {
    const highest = highestClose[i]
    // na until `pd` closes exist; a zero highest close would divide by zero.
    if (highest === null || highest === 0) return null
    return ((highest - c.low) / highest) * 100
  })
  const stdev = ta.stdev(wvf, s.bbl)
  const upperBand = ta.sma(wvf, s.bbl).map((mid, i) => (mid === null || stdev[i] === null ? null : mid + s.mult * stdev[i]!))
  const rangeHigh = ta.highest(wvf, s.lb).map((v) => (v === null ? null : v * s.ph))
  const rangeLow = ta.lowest(wvf, s.lb).map((v) => (v === null ? null : v * s.pl))
  const isGreen = wvf.map((v, i) => {
    if (v === null) return false
    const upper = upperBand[i],
      range = rangeHigh[i]
    return (upper !== null && v >= upper) || (range !== null && v >= range)
  })
  return { wvf, upperBand, rangeHigh, rangeLow, isGreen }
}

/**
 * V2's window call for bar `i`: a lime bar is a potential bottom (it holds while the bars stay
 * lime), within 15% of the nearest trigger is a warning, anything else is quiet.
 */
export function vixFixCall(wvf: number, previous: number | null, green: boolean, previousGreen: boolean, upper: number | null, rangeHigh: number | null) {
  if (green) return previousGreen ? { text: '▲ BOTTOM SIGNAL HOLDS', tone: 'bull' as const } : { text: '▲ POTENTIAL BOTTOM', tone: 'bull' as const }
  const triggers = [upper, rangeHigh].filter((v): v is number => v !== null)
  const direction = previous === null ? '' : wvf > previous ? ' · RISING' : wvf < previous ? ' · FALLING' : ''
  if (!triggers.length) return { text: `QUIET${direction}`, tone: 'flat' as const }
  const nearest = Math.min(...triggers)
  // A gray bar sits under every trigger and WVF is never negative, so this is the distance to a spike.
  if (nearest > 0 && wvf / nearest >= 0.85) return { text: '⚠ NEAR TRIGGER', tone: 'os' as const }
  return { text: `QUIET${direction}`, tone: 'flat' as const }
}
