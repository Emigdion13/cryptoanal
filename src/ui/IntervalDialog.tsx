import { useState } from 'react'
import { parseInterval } from '../data/intervals'

/** TradingView's "Change interval" box, opened by typing a number on the chart. */
export function IntervalDialog(props: { initial: string; onPick: (id: string) => void; onClose: () => void }) {
  const [text, setText] = useState(props.initial)
  const def = parseInterval(text)

  return (
    <div className="overlay clear" onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="dialog interval-dialog">
        <div className="interval-dialog-title">Change interval</div>
        <input
          autoFocus
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && def) props.onPick(def.id)
            if (e.key === 'Escape') props.onClose()
          }}
        />
        <div className={`interval-dialog-hint${def ? '' : ' bad'}`}>{def ? def.name : 'Not applicable'}</div>
      </div>
    </div>
  )
}
