/**
 * The phone's own indicators (server/phoneProfile.ts): a list apart from the desktop's charts,
 * shown on every chart tab. Until the phone saves one it shows the desktop chart's own; the first
 * change copies those and makes them the phone's. The sheet adds and removes them; their inputs
 * are the indicators' defaults.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createInstance, INDICATOR_BY_TYPE, INDICATORS } from '../indicators/catalog'
import type { IndicatorInstance } from '../indicators/types'
import { phoneFetch, PhoneRequestError } from './auth'

const ROUTE = '/api/phone/indicators'

/** The phone's list (null: the desktop's), and saving a new one. */
export function usePhoneIndicators(onSignedOut: () => void) {
  const [list, setList] = useState<IndicatorInstance[] | null>(null)
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const saved = useRef<IndicatorInstance[] | null>(null)

  const fail = useCallback(
    (error: unknown) => {
      if (error instanceof PhoneRequestError && (error.code === 'SIGNED_OUT' || error.code === 'PHONE_OFF')) return onSignedOut()
      setProblem(error instanceof Error ? error.message : 'Could not reach the computer.')
    },
    [onSignedOut],
  )

  useEffect(() => {
    let alive = true
    phoneFetch<{ indicators: IndicatorInstance[] | null }>(ROUTE)
      .then((reply) => {
        if (!alive) return
        saved.current = reply.indicators
        setList(reply.indicators)
        setReady(true)
      })
      .catch((error: unknown) => alive && fail(error))
    return () => {
      alive = false
    }
  }, [fail])

  /** Shown at once; put back if the computer refuses it. */
  const save = useCallback(
    (next: IndicatorInstance[] | null) => {
      setList(next)
      setProblem(null)
      phoneFetch<{ indicators: IndicatorInstance[] | null }>(ROUTE, { indicators: next })
        .then((reply) => (saved.current = reply.indicators))
        .catch((error: unknown) => {
          setList(saved.current)
          fail(error)
        })
    },
    [fail],
  )

  return { list, ready, save, problem }
}

/**
 * The sheet: what the phone shows, each with a remove button, then every indicator to add,
 * searchable. "Use the desktop's" drops the phone's list.
 */
export function PhoneIndicatorSheet({
  shown,
  own,
  problem,
  onChange,
  onReset,
  onClose,
}: {
  /** What the phone shows now: its own list, or the desktop chart's. */
  shown: IndicatorInstance[]
  own: boolean
  problem: string | null
  onChange: (list: IndicatorInstance[]) => void
  onReset: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return INDICATORS.filter((d) => !q || d.name.toLowerCase().includes(q) || d.short.toLowerCase().includes(q) || d.category.toLowerCase().includes(q))
  }, [query])
  const has = new Set(shown.map((i) => i.type))

  return (
    <div className="phone-ind-backdrop" onClick={onClose}>
      <section className="phone-ind-sheet" role="dialog" aria-label="Phone indicators" onClick={(e) => e.stopPropagation()}>
        <header className="phone-ind-head">
          <b>Phone indicators</b>
          <span className="phone-spacer" />
          <button type="button" className="phone-ind-done" onClick={onClose}>
            Done
          </button>
        </header>
        <p className="phone-ind-note phone-dim">
          {own ? 'The phone’s own, on every chart tab. The desktop keeps its own.' : 'Showing the desktop chart’s. Any change here makes them the phone’s own.'}
        </p>
        {problem && <p className="phone-ind-note phone-problem">{problem}</p>}

        <div className="phone-ind-list">
          {shown.length === 0 && <p className="phone-ind-note phone-dim">None yet: add one below.</p>}
          {shown.map((inst) => {
            const def = INDICATOR_BY_TYPE.get(inst.type)
            if (!def) return null
            return (
              <div key={inst.id} className="phone-ind-row">
                <span className="phone-ind-name">
                  {def.short}
                  <small className="phone-dim">{def.overlay ? 'on the price chart' : 'tile'}</small>
                </span>
                <button type="button" className="phone-ind-btn is-remove" aria-label={`Remove ${def.short}`} onClick={() => onChange(shown.filter((i) => i.id !== inst.id))}>
                  −
                </button>
              </div>
            )
          })}
        </div>

        <input
          className="phone-ind-search"
          type="search"
          value={query}
          placeholder="Add an indicator…"
          spellCheck={false}
          autoCorrect="off"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="phone-ind-list is-catalog">
          {matches.map((def) => (
            <div key={def.type} className="phone-ind-row">
              <span className="phone-ind-name">
                {def.name}
                <small className="phone-dim">{def.category}</small>
              </span>
              <button
                type="button"
                className={`phone-ind-btn${has.has(def.type) ? ' is-added' : ''}`}
                aria-label={`Add ${def.short}`}
                onClick={() => onChange([...shown, createInstance(def.type)])}
              >
                +
              </button>
            </div>
          ))}
          {!matches.length && <p className="phone-ind-note phone-dim">No indicators match.</p>}
        </div>

        {own && (
          <button type="button" className="phone-ind-reset" onClick={onReset}>
            Use the desktop’s instead
          </button>
        )}
      </section>
    </div>
  )
}

export const IndicatorsIcon = () => (
  <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 15l4-5 3 3 4-6 3 4" />
    <path d="M3 4v12h14" />
  </svg>
)
