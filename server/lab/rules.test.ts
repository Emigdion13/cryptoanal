import { describe, expect, it } from 'vitest'
import { compile, evaluate, RuleError, type Scope, type Value } from './rules'

const known = { vars: ['upAsk', 'minute', 'favorite', 'price'], fns: ['has', 'abs'] }
const scope = (vars: Record<string, Value>): Scope => ({
  vars: (name) => vars[name],
  fns: { has: (name, text) => name === 'SAR' && text === 'ABOVE', abs: (v) => (typeof v === 'number' ? Math.abs(v) : null) },
})
const run = (text: string, vars: Record<string, Value> = {}) => evaluate(compile(text, known), scope(vars))

describe('rule expressions', () => {
  it('reads comparisons, words and symbols for and / or / not, and precedence', () => {
    expect(run('upAsk >= 85 and upAsk <= 92', { upAsk: 90 })).toBe(true)
    expect(run('upAsk >= 85 && minute > 10', { upAsk: 90, minute: 3 })).toBe(false)
    expect(run('not (minute < 5) || upAsk == 1', { minute: 7, upAsk: 0 })).toBe(true)
    expect(run('1 + 2 * 3 - -4 / 2')).toBe(9)
    expect(run('abs(price - 100) < 5', { price: 97 })).toBe(true)
  })

  it('compares text without case, and calls functions', () => {
    expect(run("favorite == 'UP'", { favorite: 'up' })).toBe(true)
    expect(run('has("SAR", "ABOVE") and favorite != "down"', { favorite: 'up' })).toBe(true)
  })

  it('never trades on a missing value', () => {
    expect(run('upAsk < 50', { upAsk: null })).toBe(false)
    expect(run('upAsk >= 50', { upAsk: null })).toBe(false)
    expect(run('upAsk + 1')).toBe(null)
    expect(run('minute / 0', { minute: 4 })).toBe(null)
  })

  it('names the mistake before anything runs', () => {
    expect(() => compile('upAks > 3', known)).toThrow(/No value named upAks/)
    expect(() => compile('rsi("x")', known)).toThrow(RuleError)
    expect(() => compile('upAsk > ', known)).toThrow(/ends too early/)
    expect(() => compile('upAsk > 3 3', known)).toThrow(/Unexpected "3"/)
    expect(() => compile('upAsk ; 3', known)).toThrow(/Cannot read/)
  })
})
