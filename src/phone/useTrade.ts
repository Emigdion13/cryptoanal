import { useCallback, useEffect, useRef, useState } from 'react'
import type { TradeEnv, TradeResult, TradeState } from '../trade/kalshiTrade'
import { phoneFetch } from './auth'

export type TradeRoute = 'buy' | 'sell-now' | 'target' | 'target/cancel' | 'auto-sell'

/** The answer to the last tap: Kalshi's words, and how long the order took. */
export interface TradeStatus {
  id: number
  tone: 'ok' | 'warn' | 'error'
  text: string
}

const ENV_KEY = 'cryptoanal.phone.tradeEnv'
/** A live order's second tap must come within this, ms. */
const CONFIRM_MS = 3_000
/** How long an answer stays on screen, ms. */
const STATUS_MS = 8_000

function storedEnv(): TradeEnv {
  try {
    return localStorage.getItem(ENV_KEY) === 'live' ? 'live' : 'demo'
  } catch {
    return 'demo'
  }
}

/**
 * The phone's line to the trading engine: the account's state for one coin, pushed by the computer
 * as Kalshi changes it (server-sent events), and `send` for the circles. Starts in Demo. In Live
 * every order takes two taps: the first arms it ("Tap again"), the second sends it.
 */
export function useTrade(product: string) {
  const [env, setEnvState] = useState<TradeEnv>(storedEnv)
  const [state, setState] = useState<TradeState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [status, setStatus] = useState<TradeStatus | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const statusTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const statusId = useRef(0)

  useEffect(() => {
    setState(null)
    const source = new EventSource(`/api/trade/stream?${new URLSearchParams({ env, product })}`)
    source.onmessage = (event) => {
      try {
        setState(JSON.parse(event.data) as TradeState)
      } catch {
        // A torn message; the next one is whole.
      }
    }
    return () => source.close()
  }, [env, product])

  useEffect(
    () => () => {
      clearTimeout(armTimer.current)
      clearTimeout(statusTimer.current)
    },
    [],
  )

  const setEnv = useCallback((next: TradeEnv) => {
    try {
      localStorage.setItem(ENV_KEY, next)
    } catch {
      // Remembered for this visit only.
    }
    setArmed(null)
    setStatus(null)
    setEnvState(next)
  }, [])

  const show = (tone: TradeStatus['tone'], text: string) => {
    clearTimeout(statusTimer.current)
    setStatus({ id: ++statusId.current, tone, text })
    statusTimer.current = setTimeout(() => setStatus(null), STATUS_MS)
  }

  /** Answers Kalshi's answer, or null when nothing went (refused, or a live order waiting for its 2nd tap). */
  const send = async (key: string, route: TradeRoute, body: Record<string, unknown>, { confirm = env === 'live' }: { confirm?: boolean } = {}): Promise<TradeResult | null> => {
    if (busy) return null
    clearTimeout(armTimer.current)
    if (confirm && armed !== key) {
      setArmed(key)
      armTimer.current = setTimeout(() => setArmed(null), CONFIRM_MS)
      return null
    }
    setArmed(null)
    setBusy(key)
    try {
      const result = await phoneFetch<TradeResult>(`/api/trade/${route}`, { ...body, env })
      const nothing = (route === 'buy' || route === 'sell-now') && !result.filled
      show(nothing ? 'warn' : 'ok', `${result.message}${result.ms !== undefined ? ` · ${result.ms} ms` : ''}`)
      return result
    } catch (error) {
      show('error', error instanceof Error ? error.message : 'The order failed.')
      return null
    } finally {
      setBusy(null)
    }
  }

  return { env, setEnv, state, busy, armed, status, send }
}

export type Trade = ReturnType<typeof useTrade>
