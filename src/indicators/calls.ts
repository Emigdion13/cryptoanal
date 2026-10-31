/**
 * The calls (floating windows, phone tiles) of indicators the generic reading in floatingModel.ts
 * gets wrong: it sets the first line against the second, or calls a rising line bullish, and
 * neither is what these are read for.
 */
import type { Output, Verdict } from './types'

/** A signal older than this many bars no longer makes the call (floatingModel's too). */
export const SIGNAL_BARS = 5
/** DMI: under this ADX there is no trend, over the next a real one, over the last a very strong one. */
const ADX_TREND = 20
const ADX_STRONG = 25
const ADX_VERY_STRONG = 40
/** BBW: the narrowest in this many bars is a squeeze. */
const SQUEEZE_BARS = 50

const WARMING_UP: Verdict = { text: 'WARMING UP', tone: 'flat' }

function at(out: Output, key: string, i: number): number | null {
  const v = out.values[key]?.[i]
  return v !== undefined && Number.isFinite(v) ? v : null
}

/** "this bar", "1 bar ago", "3 bars ago". */
export function barsAgo(ago: number): string {
  return ago <= 0 ? 'this bar' : ago === 1 ? '1 bar ago' : `${ago} bars ago`
}

/** How many bars ago `key` last had a value (a signal plotted as dots), within SIGNAL_BARS. */
function markAgo(out: Output, key: string, i: number): number | null {
  for (let ago = 0; ago < SIGNAL_BARS && i - ago >= 0; ago++) if (at(out, key, i - ago) !== null) return ago
  return null
}

/**
 * DMI: the side from +DI against −DI (who pushed to new highs or lows more), the strength from
 * ADX (how far apart they are, whichever side): under 20 no trend; rising from 20 building, past
 * 25 strong, past 40 very strong; falling, fading. A cross of the DIs is named on its bar.
 */
export function dmiCall(out: Output, i: number): Verdict {
  const plus = at(out, 'plus', i)
  const minus = at(out, 'minus', i)
  if (plus === null || minus === null) return WARMING_UP
  const adx = at(out, 'adx', i)
  const prevAdx = at(out, 'adx', i - 1)
  const prevPlus = at(out, 'plus', i - 1)
  const prevMinus = at(out, 'minus', i - 1)
  const up = plus > minus
  const crossed = prevPlus !== null && prevMinus !== null && (prevPlus > prevMinus) !== up && plus !== minus
  const side = crossed ? (up ? 'BULL CROSS' : 'BEAR CROSS') : up ? 'UP' : 'DOWN'
  if (adx === null) return plus === minus ? { text: 'EVEN', tone: 'flat' } : { text: side, tone: up ? 'bull' : 'bear' }
  if (adx < ADX_TREND || plus === minus) return { text: crossed ? `NO TREND · ${side}` : 'NO TREND', tone: 'flat' }
  const strength =
    prevAdx !== null && adx < prevAdx ? 'FADING' : adx >= ADX_VERY_STRONG ? 'VERY STRONG' : adx >= ADX_STRONG ? 'STRONG' : 'BUILDING'
  return { text: `${side} · ${strength}`, tone: up ? 'bull' : 'bear' }
}

/** ATR: how big the bars are. Bigger or smaller says nothing of the direction. */
export function atrCall(out: Output, i: number): Verdict {
  const v = at(out, 'atr', i)
  const prev = at(out, 'atr', i - 1)
  if (v === null) return WARMING_UP
  if (prev === null || v === prev) return { text: 'VOLATILITY FLAT', tone: 'flat' }
  return { text: v > prev ? 'VOLATILITY RISING' : 'VOLATILITY FALLING', tone: 'flat' }
}

/**
 * Bollinger BandWidth: how wide the bands are, no direction either. The narrowest in
 * SQUEEZE_BARS is a squeeze, which often comes before a big move (either way).
 */
export function bbwCall(out: Output, i: number): Verdict {
  const v = at(out, 'bbw', i)
  const prev = at(out, 'bbw', i - 1)
  if (v === null) return WARMING_UP
  let narrowest = true
  for (let k = Math.max(0, i - SQUEEZE_BARS + 1); k < i && narrowest; k++) {
    const w = at(out, 'bbw', k)
    if (w !== null && w < v) narrowest = false
  }
  if (narrowest && i >= SQUEEZE_BARS - 1) return { text: 'SQUEEZE', tone: 'flat' }
  if (prev === null || v === prev) return { text: 'BANDS FLAT', tone: 'flat' }
  return { text: v > prev ? 'BANDS WIDENING' : 'BANDS NARROWING', tone: 'flat' }
}

/** OBV: a running total from an arbitrary start, so only its direction means anything (not zero). */
export function obvCall(out: Output, i: number): Verdict {
  const v = at(out, 'obv', i)
  const prev = at(out, 'obv', i - 1)
  if (v === null) return WARMING_UP
  if (prev === null || v === prev) return { text: 'FLAT', tone: 'flat' }
  return v > prev ? { text: 'RISING', tone: 'bull' } : { text: 'FALLING', tone: 'bear' }
}

/** Chaikin Money Flow: over zero the money flows in (buyers), under it out (sellers); then which way it moves. */
export function cmfCall(out: Output, i: number): Verdict {
  const v = at(out, 'cmf', i)
  const prev = at(out, 'cmf', i - 1)
  if (v === null) return WARMING_UP
  const move = prev === null || v === prev ? '' : v > prev ? ' · RISING' : ' · FALLING'
  if (v === 0) return { text: `EVEN${move}`, tone: 'flat' }
  return v > 0 ? { text: `BUYERS${move}`, tone: 'bull' } : { text: `SELLERS${move}`, tone: 'bear' }
}

/** TMO [LuxAlgo]: its Buy / Sell circles in the last few bars, else the oscillator's side and direction. */
export function tmoLuxCall(out: Output, i: number): Verdict | null {
  const buy = markAgo(out, 'bull', i)
  const sell = markAgo(out, 'bear', i)
  if (buy !== null && (sell === null || buy <= sell)) return { text: `BUY · ${barsAgo(buy)}`, tone: 'bull' }
  if (sell !== null) return { text: `SELL · ${barsAgo(sell)}`, tone: 'bear' }
  const v = at(out, 'osc', i)
  const prev = at(out, 'osc', i - 1)
  if (v === null) return null
  const side = v >= 0 ? ' · ABOVE 0' : ' · BELOW 0'
  if (prev === null || v === prev) return { text: `FLAT${side}`, tone: 'flat' }
  return v > prev ? { text: `RISING${side}`, tone: 'bull' } : { text: `FALLING${side}`, tone: 'bear' }
}

/**
 * Bayesian/nQQE/BankFunds: its Long / Short signals in the last few bars; else which break is the
 * likelier, Break Down (red: price has sat high on the bands, a drop is due) or Break Up (green: it
 * has sat low); SIDEWAYS when both, and Prime, are under the script's lower threshold. With the
 * probabilities hidden, the nQQE regime: over 60 bull, under 40 bear (its 60 / 40 lines).
 */
export function bayesianCall(out: Output, i: number): Verdict | null {
  const long = markAgo(out, 'long', i)
  const short = markAgo(out, 'short', i)
  if (long !== null && (short === null || long <= short)) return { text: `LONG · ${barsAgo(long)}`, tone: 'bull' }
  if (short !== null) return { text: `SHORT · ${barsAgo(short)}`, tone: 'bear' }
  const down = at(out, 'probDown', i)
  const up = at(out, 'probUp', i)
  if (down !== null && up !== null) {
    if (at(out, 'sideways', i) === 1) return { text: 'SIDEWAYS', tone: 'flat' }
    if (down === up) return { text: `EVEN ${Math.round(up)}%`, tone: 'flat' }
    return down > up ? { text: `BREAK DOWN ${Math.round(down)}%`, tone: 'bear' } : { text: `BREAK UP ${Math.round(up)}%`, tone: 'bull' }
  }
  const nqqe = at(out, 'nqqe', i)
  if (nqqe === null) return null
  return nqqe > 60 ? { text: 'nQQE BULL', tone: 'bull' } : nqqe < 40 ? { text: 'nQQE BEAR', tone: 'bear' } : { text: 'nQQE NEUTRAL', tone: 'flat' }
}
