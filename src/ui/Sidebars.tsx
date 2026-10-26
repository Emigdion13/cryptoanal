import { useCallback, useRef, useState } from 'react'
import type { CursorMode } from '../chart/ChartEngine'
import { useDismiss } from './common'
import { CURSOR_ICONS, WatchlistIcon } from './icons'

const CURSORS: { mode: CursorMode; name: string }[] = [
  { mode: 'cross', name: 'Cross' },
  { mode: 'dot', name: 'Dot' },
  { mode: 'arrow', name: 'Arrow' },
]

/** The left toolbar: the cursor picker (no drawing tools). */
export function LeftToolbar({ cursor, onCursor }: { cursor: CursorMode; onCursor: (m: CursorMode) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const Current = CURSOR_ICONS[cursor]

  return (
    <aside className="left-toolbar">
      <div className="flyout-anchor" ref={ref}>
        <button className="side-btn active" onClick={() => setOpen(!open)} title={CURSORS.find((c) => c.mode === cursor)?.name}>
          <Current />
          <span className="side-arrow" />
        </button>
        {open && (
          <div className="menu flyout">
            {CURSORS.map(({ mode, name }) => {
              const ModeIcon = CURSOR_ICONS[mode]
              return (
                <div
                  key={mode}
                  className={`menu-item with-icon${mode === cursor ? ' selected' : ''}`}
                  onClick={() => {
                    onCursor(mode)
                    close()
                  }}
                >
                  <ModeIcon />
                  <span className="menu-label">{name}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </aside>
  )
}

/** The right widget bar. */
export function RightToolbar({ watchlistOpen, onWatchlist }: { watchlistOpen: boolean; onWatchlist: () => void }) {
  return (
    <aside className="right-toolbar">
      <button className={`side-btn${watchlistOpen ? ' active' : ''}`} onClick={onWatchlist} title="Watchlist">
        <WatchlistIcon />
      </button>
    </aside>
  )
}
