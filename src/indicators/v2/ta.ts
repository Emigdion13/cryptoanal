/**
 * btcAnalyzerV2's Pine-style helpers (src/lib/indicator-runtime.ts, origin/main 4fad720), copied
 * as they are so the V2 ports compute exactly what V2 does: na in, na out; an EMA reseeds after a
 * gap; windows with any na are na.
 */
function createTa() {
  type Values = (number | null)[]
  function validate(period: number) {
    if (!Number.isInteger(period) || period < 1 || period > 2000)
      throw new Error('Period must be an integer between 1 and 2000.')
  }
  function sma(values: Values, period: number): Values {
    validate(period)
    let sum = 0,
      valid = 0
    return values.map((value, i) => {
      if (value !== null && Number.isFinite(value)) {
        sum += value
        valid++
      }
      if (i >= period) {
        const old = values[i - period]
        if (old !== null && Number.isFinite(old)) {
          sum -= old
          valid--
        }
      }
      return i >= period - 1 && valid === period ? sum / period : null
    })
  }
  function ema(values: Values, period: number): Values {
    validate(period)
    const alpha = 2 / (period + 1)
    let previous: number | null = null,
      seed = 0,
      count = 0
    return values.map((value) => {
      if (value === null || !Number.isFinite(value)) {
        seed = 0
        count = 0
        previous = null
        return null
      }
      if (previous === null) {
        seed += value
        count++
        if (count < period) return null
        previous = seed / period
      } else previous = value * alpha + previous * (1 - alpha)
      return previous
    })
  }
  function rsi(values: Values, period: number): Values {
    validate(period)
    let gain = 0,
      loss = 0,
      count = 0
    return values.map((value, i) => {
      const prev = values[i - 1]
      if (
        i === 0 ||
        value === null ||
        prev === null ||
        !Number.isFinite(value) ||
        !Number.isFinite(prev)
      ) {
        gain = 0
        loss = 0
        count = 0
        return null
      }
      const diff = value - prev
      count++
      if (count <= period) {
        gain += Math.max(diff, 0)
        loss += Math.max(-diff, 0)
      }
      if (count < period) return null
      if (count === period) {
        gain /= period
        loss /= period
      } else {
        gain = (gain * (period - 1) + Math.max(diff, 0)) / period
        loss = (loss * (period - 1) + Math.max(-diff, 0)) / period
      }
      return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss)
    })
  }
  function stdev(values: Values, period: number): Values {
    validate(period)
    const means = sma(values, period)
    return values.map((_, i) => {
      if (means[i] === null) return null
      let sum = 0
      for (let j = i - period + 1; j <= i; j++)
        sum += ((values[j] as number) - (means[i] as number)) ** 2
      return Math.sqrt(sum / period)
    })
  }
  function highest(values: Values, period: number): Values {
    validate(period)
    return values.map((_, i) => {
      const window = values.slice(Math.max(0, i - period + 1), i + 1)
      return window.length === period && window.every((v) => v !== null && Number.isFinite(v))
        ? Math.max(...(window as number[]))
        : null
    })
  }
  function lowest(values: Values, period: number): Values {
    validate(period)
    return values.map((_, i) => {
      const window = values.slice(Math.max(0, i - period + 1), i + 1)
      return window.length === period && window.every((v) => v !== null && Number.isFinite(v))
        ? Math.min(...(window as number[]))
        : null
    })
  }
  function crossover(a: Values, b: Values): boolean[] {
    return a.map(
      (v, i) =>
        i > 0 &&
        v !== null &&
        b[i] !== null &&
        a[i - 1] !== null &&
        b[i - 1] !== null &&
        v > b[i]! &&
        a[i - 1]! <= b[i - 1]!,
    )
  }
  return { sma, ema, rsi, stdev, highest, lowest, crossover }
}
export const ta = createTa()
