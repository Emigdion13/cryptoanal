import { useCallback, useRef, useState } from 'react'
import { useDismiss } from './common'
import { LayoutIcon } from './icons'
import { LAYOUTS, type LayoutDef } from './layouts'
import type { SyncOptions } from './settings'

/** A small drawing of the layout's grid. */
function LayoutPreview({ layout }: { layout: LayoutDef }) {
  const w = 26,
    h = 20,
    gap = 1.5
  const cw = (w - gap * (layout.cols - 1)) / layout.cols
  const rh = (h - gap * (layout.rows - 1)) / layout.rows
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      {layout.cells.map(([r0, c0, r1, c1], k) => (
        <rect
          key={k}
          x={(c0 - 1) * (cw + gap)}
          y={(r0 - 1) * (rh + gap)}
          width={(c1 - c0) * cw + (c1 - c0 - 1) * gap}
          height={(r1 - r0) * rh + (r1 - r0 - 1) * gap}
          rx="1.5"
          fill="currentColor"
          fillOpacity="0.25"
          stroke="currentColor"
        />
      ))}
    </svg>
  )
}

const SYNC: { key: keyof SyncOptions; label: string }[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'interval', label: 'Interval' },
  { key: 'crosshair', label: 'Crosshair' },
  { key: 'time', label: 'Time' },
]

/** TradingView's "Select layout" menu with the "Sync in layout" switches. */
export function LayoutMenu(props: {
  layout: string
  sync: SyncOptions
  onLayout: (id: string) => void
  onSync: (sync: SyncOptions) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const counts = [...new Set(LAYOUTS.map((l) => l.cells.length))]

  return (
    <div className="dropdown" ref={ref}>
      <button className={`tb-btn icon${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title="Select layout">
        <LayoutIcon />
      </button>
      {open && (
        <div className="menu layout-menu">
          {counts.map((count) => (
            <div key={count} className="layout-row">
              <span className="layout-count">{count}</span>
              {LAYOUTS.filter((l) => l.cells.length === count).map((l) => (
                <button
                  key={l.id}
                  className={`layout-btn${l.id === props.layout ? ' active' : ''}`}
                  title={l.name}
                  onClick={() => props.onLayout(l.id)}
                >
                  <LayoutPreview layout={l} />
                </button>
              ))}
            </div>
          ))}
          <div className="menu-section static">SYNC IN LAYOUT</div>
          {SYNC.map(({ key, label }) => (
            <label key={key} className="menu-item switch-item">
              <span className="menu-label">{label}</span>
              <input
                type="checkbox"
                className="switch"
                checked={props.sync[key]}
                onChange={(e) => props.onSync({ ...props.sync, [key]: e.target.checked })}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
