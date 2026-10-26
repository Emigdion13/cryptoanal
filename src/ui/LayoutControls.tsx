import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDismiss } from './common'
import { CheckIcon, ChevronDown, CloseIcon, SearchIcon, TrashIcon } from './icons'
import { summarize } from './layoutStore'
import { LAYOUT_BY_ID } from './layouts'
import type { WorkspaceApi } from './useWorkspace'

type NameAsk = { title: string; initial: string; then: (name: string) => void }
type Confirm = { name: string; then: () => void }

function NameDialog({ ask, onClose }: { ask: NameAsk; onClose: () => void }) {
  const [name, setName] = useState(ask.initial)
  const ok = () => {
    if (!name.trim()) return
    ask.then(name.trim())
    onClose()
  }
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog name-dialog">
        <div className="dialog-head">
          <span className="dialog-title">{ask.title}</span>
          <button className="dialog-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="settings-body">
          <label className="field column">
            <span>Layout name</span>
            <input
              autoFocus
              value={name}
              maxLength={80}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ok()
                if (e.key === 'Escape') onClose()
              }}
            />
          </label>
        </div>
        <div className="dialog-foot">
          <span className="header-spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={ok} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/** "Save changes?" before leaving a layout with autosave off. */
function ConfirmDialog({ confirm, onSave, onClose }: { confirm: Confirm; onSave: () => void; onClose: () => void }) {
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog name-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="dialog-head">
          <span className="dialog-title">Unsaved changes</span>
        </div>
        <div className="settings-body">You have unsaved changes in “{confirm.name}”. Save them first?</div>
        <div className="dialog-foot">
          <button
            className="btn ghost"
            onClick={() => {
              confirm.then()
              onClose()
            }}
          >
            Don't save
          </button>
          <span className="header-spacer" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            autoFocus
            className="btn primary"
            onClick={() => {
              onSave()
              confirm.then()
              onClose()
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function ago(time: number): string {
  const s = Math.max(0, (Date.now() - time) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function LoadDialog({ ws, onOpen, onClose }: { ws: WorkspaceApi; onOpen: (id: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [armed, setArmed] = useState<string | null>(null)
  const list = useMemo(
    () =>
      ws.layouts
        .filter((l) => l.name.toLowerCase().includes(query.trim().toLowerCase()))
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [ws.layouts, query],
  )
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog load-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="dialog-head">
          <span className="dialog-title">Load layout</span>
          <button className="dialog-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="search-row">
          <SearchIcon />
          <input autoFocus value={query} spellCheck={false} placeholder="Search" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="load-list">
          <div className="load-head">
            <span>Layout name</span>
            <span>Modified</span>
          </div>
          {list.map((l) => {
            const charts = LAYOUT_BY_ID.get(l.content.layout)?.cells.length ?? 1
            return (
              <div key={l.id} className={`load-item${l.id === ws.current?.id ? ' current' : ''}`} onClick={() => onOpen(l.id)}>
                <span className="load-name">
                  <b>{l.name}</b>
                  <span>
                    {summarize(l, charts)} · {charts} chart{charts === 1 ? '' : 's'}
                  </span>
                </span>
                <span className="load-date">{ago(l.updatedAt)}</span>
                <button
                  className={`load-delete${armed === l.id ? ' armed' : ''}`}
                  title={armed === l.id ? 'Click again to delete' : 'Delete layout'}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (armed === l.id) {
                      ws.remove(l.id)
                      setArmed(null)
                    } else setArmed(l.id)
                  }}
                >
                  {armed === l.id ? 'Delete?' : <TrashIcon />}
                </button>
              </div>
            )
          })}
          {!list.length && <div className="search-empty">No saved layouts</div>}
        </div>
      </div>
    </div>
  )
}

/** TradingView's layout name menu and Save button, with their dialogs and shortcuts. */
export function LayoutControls({ ws }: { ws: WorkspaceApi }) {
  const [open, setOpen] = useState(false)
  const [ask, setAsk] = useState<NameAsk | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(ref, open, close)
  const name = ws.current?.name ?? 'Unnamed'

  /** Runs `then`, first offering to save when leaving unsaved changes behind. */
  const leave = (then: () => void) => {
    if (ws.dirty && ws.current && !ws.autosaveOn) setConfirm({ name, then })
    else then()
  }
  const save = () => {
    if (!ws.save()) setAsk({ title: 'Save new chart layout', initial: 'My layout', then: ws.saveAs })
  }

  // Ctrl+S saves, "." opens Load layout, as on TradingView.
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
        return
      }
      const target = e.target as HTMLElement
      if (e.key === '.' && !e.ctrlKey && !e.metaKey && !target.closest?.('input, textarea, select') && !document.querySelector('.overlay')) {
        e.preventDefault()
        setLoading(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const item = (label: string, action: () => void, hint?: string) => (
    <div
      className="menu-item"
      onClick={() => {
        close()
        action()
      }}
    >
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
    </div>
  )

  return (
    <>
      <div className="dropdown" ref={ref}>
        <button className={`tb-btn layout-name${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title="Manage layouts">
          <span>{name}</span>
          <ChevronDown />
        </button>
        {open && (
          <div className="menu save-menu">
            {item('Save layout', save, 'Ctrl+S')}
            {item('Rename…', () => setAsk({ title: 'Rename chart layout', initial: name, then: ws.rename }))}
            {item('Make a copy…', () => setAsk({ title: 'Copy chart layout', initial: `${name} copy`, then: ws.saveAs }))}
            {item('New layout…', () =>
              leave(() => setAsk({ title: 'Create new chart layout', initial: 'New layout', then: ws.newLayout })),
            )}
            {item('Load layout…', () => setLoading(true), '.')}
            <label className="menu-item switch-item autosave">
              <span className="menu-label">Autosave</span>
              <input
                type="checkbox"
                className="switch"
                checked={ws.autosaveOn}
                onChange={(e) => ws.setAutosave(e.target.checked)}
              />
            </label>
            <div className="menu-note" title={ws.file ?? undefined}>
              {ws.file ? `Saved to ${ws.file}` : 'Saved in this browser only'}
            </div>
          </div>
        )}
      </div>
      <button
        className={`tb-btn save-btn${ws.dirty ? ' dirty' : ''}${ws.saveError ? ' error' : ''}`}
        onClick={save}
        title={ws.saveError ?? (ws.dirty ? 'Save layout (Ctrl+S)' : 'All changes saved')}
      >
        {ws.saveError ? 'Not saved' : ws.dirty ? 'Save' : (
          <>
            <CheckIcon />
            Saved
          </>
        )}
      </button>
      {ask && <NameDialog ask={ask} onClose={() => setAsk(null)} />}
      {confirm && <ConfirmDialog confirm={confirm} onSave={() => ws.save()} onClose={() => setConfirm(null)} />}
      {loading && (
        <LoadDialog
          ws={ws}
          onOpen={(id) => {
            setLoading(false)
            if (id !== ws.current?.id) leave(() => ws.open(id))
          }}
          onClose={() => setLoading(false)}
        />
      )}
    </>
  )
}
