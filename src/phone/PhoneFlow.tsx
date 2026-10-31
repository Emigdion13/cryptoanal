import { useState } from 'react'
import { FLOW_WINDOWS, flowWindowText, useOrderFlow, type FlowWindow } from '../data/flow'

const WINDOW_KEY = 'cryptoanal.phone.flowWindow'

/** The window picked on the right of the quick-trade button, remembered on the phone. */
export function useFlowWindow() {
  const [span, setSpanState] = useState<FlowWindow>(() => {
    try {
      const saved = Number(localStorage.getItem(WINDOW_KEY))
      return (FLOW_WINDOWS as readonly number[]).includes(saved) ? (saved as FlowWindow) : 60
    } catch {
      return 60
    }
  })
  const setSpan = (next: FlowWindow) => {
    try {
      localStorage.setItem(WINDOW_KEY, String(next))
    } catch {
      // Remembered for this visit only.
    }
    setSpanState(next)
  }
  return [span, setSpan] as const
}

const pct = (v: number) => `${Math.round(v)}%`

/**
 * Left of the round's timer: who is winning, buyers or sellers, as Kalshi shows Up and Down. The
 * split is the volume of Coinbase trades whose aggressor bought vs sold, over the picked window.
 */
export function FlowPill({ product, span }: { product: string; span: FlowWindow }) {
  const flow = useOrderFlow(product, span)
  const up = flow?.buyPct ?? null
  const coin = product.split('-')[0]
  const lead = up === null ? '' : up > 50 ? ' is-buyers' : up < 50 ? ' is-sellers' : ''
  return (
    <div
      className={`phone-flow${lead}${flow && !flow.complete ? ' is-partial' : ''}`}
      style={up !== null ? { ['--buy' as string]: `${up}%` } : undefined}
      role="status"
      aria-label={
        flow && up !== null
          ? `Last ${flowWindowText(span)}: buyers ${pct(up)} (${flow.buy.toFixed(3)} ${coin}), sellers ${pct(100 - up)} (${flow.sell.toFixed(3)} ${coin})${flow.complete ? '' : ', still reading the start of the window'}`
          : 'Buyers and sellers: no trades yet'
      }
    >
      <span className="phone-flow-up">▲ {up !== null ? pct(up) : '–'}</span>
      <span className="phone-flow-down">▼ {up !== null ? pct(100 - up) : '–'}</span>
    </div>
  )
}

/** Right of the quick-trade button: the window the buyers / sellers split is taken over. */
export function FlowWindows({ span, onChange }: { span: FlowWindow; onChange: (w: FlowWindow) => void }) {
  return (
    <div className="phone-flow-windows" role="radiogroup" aria-label="Buyers and sellers over the last">
      {FLOW_WINDOWS.map((w) => (
        <button key={w} type="button" role="radio" aria-checked={span === w} className={span === w ? 'is-on' : ''} onClick={() => onChange(w)}>
          {flowWindowText(w)}
        </button>
      ))}
    </div>
  )
}
