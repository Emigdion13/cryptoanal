/**
 * The phone's own indicators: a profile apart from the desktop's charts. The phone still follows
 * the desktop's charts (their symbols, intervals, drawings), but shows the indicators kept here on
 * every one of them, and changes them itself. Until the phone first saves a list, there is none
 * and it shows the desktop chart's own.
 *
 * Kept next to the workspace as `phone-profile.json`. A signed-in phone (or this computer) may
 * write it, so everything sent is checked: known indicators only, plain values, sizes capped.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { INDICATOR_BY_TYPE } from '../src/indicators/catalog'
import type { IndicatorInstance, InputValue, PlotStyle } from '../src/indicators/types'
import { PhoneError } from './phone'

export const PROFILE_MAX_INDICATORS = 40
const MAX_KEYS = 80
const MAX_TEXT = 200

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length > 0 && v.length <= max

function cleanInputs(value: unknown): Record<string, InputValue> {
  if (!isObject(value) || Object.keys(value).length > MAX_KEYS) throw bad()
  const out: Record<string, InputValue> = {}
  for (const [key, v] of Object.entries(value)) {
    if (!text(key, 64)) throw bad()
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_TEXT)) out[key] = v
    else throw bad()
  }
  return out
}

function cleanStyles(value: unknown): Record<string, PlotStyle> {
  if (!isObject(value) || Object.keys(value).length > MAX_KEYS) throw bad()
  const out: Record<string, PlotStyle> = {}
  for (const [key, v] of Object.entries(value)) {
    if (!text(key, 64) || !isObject(v) || !text(v.color, 64) || typeof v.width !== 'number' || typeof v.visible !== 'boolean') throw bad()
    if (v.color2 !== undefined && !text(v.color2, 64)) throw bad()
    out[key] = { color: v.color, width: Math.min(4, Math.max(1, Math.round(v.width))), visible: v.visible, ...(v.color2 ? { color2: v.color2 } : {}) }
  }
  return out
}

const bad = () => new PhoneError(400, 'Not a valid indicator list.', 'BAD_BODY')

/** The list a phone sent, checked and copied: unknown indicators and odd values are refused. */
export function cleanIndicators(value: unknown): IndicatorInstance[] {
  if (!Array.isArray(value) || value.length > PROFILE_MAX_INDICATORS) throw bad()
  const ids = new Set<string>()
  return value.map((item) => {
    if (!isObject(item) || !text(item.id, 64) || ids.has(item.id) || !text(item.type, 64) || !INDICATOR_BY_TYPE.has(item.type)) throw bad()
    ids.add(item.id)
    if (item.hidden !== undefined && typeof item.hidden !== 'boolean') throw bad()
    return { id: item.id, type: item.type, inputs: cleanInputs(item.inputs), styles: cleanStyles(item.styles), hidden: item.hidden === true }
  })
}

export class PhoneProfile {
  constructor(readonly file: string) {}

  /** The phone's indicators, or null while it has never saved any (it shows the desktop's). */
  read(): IndicatorInstance[] | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { indicators?: unknown }
      return raw.indicators === null || raw.indicators === undefined ? null : cleanIndicators(raw.indicators)
    } catch {
      return null
    }
  }

  /** Saves the list; null goes back to the desktop's. */
  write(indicators: IndicatorInstance[] | null): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, indicators }, null, 2)}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
  }
}
