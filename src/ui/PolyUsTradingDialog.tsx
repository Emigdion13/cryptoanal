import { useEffect, useState } from 'react'
import type { PolyKeysView, PolyResult } from '../trade/polyUs'
import { CloseIcon } from './icons'

async function call<T>(route: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/poly/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-CryptoAnal-Phone': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null
  if (!response.ok || !data) throw new Error(data?.message ?? 'The dev server is not answering.')
  return data
}

/**
 * ⚙ → Polymarket US trading: the key the Polymarket phone page (polymarket.html) signs real orders
 * with, and the switch for them. The Secret Key stays a file on this computer; only its path is kept.
 */
export function PolyUsTradingDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<PolyKeysView | null>(null)
  const [editing, setEditing] = useState(false)
  const [keyId, setKeyId] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    call<PolyKeysView>('settings').then(setView, (e: Error) => setError(e.message))
  }, [])
  const change = (body: Record<string, unknown>, done: string) => {
    setError(null)
    setSaved(null)
    call<PolyKeysView>('settings', body).then(
      (v) => {
        setView(v)
        setSaved(done)
        setEditing(false)
      },
      (e: Error) => setError(e.message),
    )
  }
  const check = () => {
    setError(null)
    setSaved(null)
    setChecking(true)
    call<PolyResult>('check', {})
      .then(
        (r) => (r.ok ? setSaved(r.message) : setError(r.message)),
        (e: Error) => setError(e.message),
      )
      .finally(() => setChecking(false))
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog phone-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="dialog-head">
          <span className="dialog-title">Polymarket US trading</span>
          <button className="dialog-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="settings-body phone-access">
          <p className="phone-access-note">
            The Polymarket page (/polymarket.html) buys and sells Polymarket US's 5-minute BTC rounds with this key, real money. Make the key at
            polymarket.us/developer, save its Secret Key in a file on this computer (for example ~/.cryptoanal/polymarket-us.key), and give its path
            here. The secret never leaves this computer.
          </p>
          {view && (
            <>
              <div className="kalshi-key">
                <div className="phone-access-row">
                  <span>Key</span>
                  <span className="kalshi-key-actions">
                    <button
                      className="btn ghost"
                      onClick={() => {
                        setEditing(true)
                        setKeyId(view.keyId)
                        setPath(view.path)
                      }}
                    >
                      {view.keyId ? 'Change' : 'Set'}
                    </button>
                    {view.keyId && (
                      <button className="btn ghost" onClick={() => change({ clear: true }, 'The key is removed.')}>
                        Remove
                      </button>
                    )}
                  </span>
                </div>
                <div className="phone-access-dim">{view.keyId ? `${view.keyId.slice(0, 8)}… · ${view.path}` : 'Not set.'}</div>
                {view.error && <div className="phone-access-warn kalshi-key-error">{view.error}</div>}
                {editing && (
                  <div className="kalshi-key-form">
                    <input value={keyId} placeholder="Key ID" spellCheck={false} onChange={(e) => setKeyId(e.target.value.trim())} />
                    <input value={path} placeholder="Secret Key file, e.g. ~/.cryptoanal/polymarket-us.key" spellCheck={false} onChange={(e) => setPath(e.target.value)} />
                    <span className="kalshi-key-actions">
                      <button className="btn ghost" onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                      <button className="btn primary" disabled={!keyId || !path.trim()} onClick={() => change({ save: { keyId, path: path.trim() } }, 'The key is saved.')}>
                        Save
                      </button>
                    </span>
                  </div>
                )}
              </div>
              <div className="phone-access-row">
                <span className="phone-access-dim">Asks Polymarket US how it reads each kind of order. Nothing is placed.</span>
                <button className="btn ghost" disabled={!view.keyId || !!view.error || checking} onClick={check}>
                  {checking ? 'Checking…' : 'Check orders'}
                </button>
              </div>
              <label className="menu-item switch-item phone-access-switch">
                <span className="menu-label">Allow real-money orders</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={view.liveTrading}
                  disabled={(!view.keyId || !!view.error) && !view.liveTrading}
                  onChange={(e) =>
                    change({ liveTrading: e.target.checked }, e.target.checked ? 'Real-money orders are on: the Polymarket page trades.' : 'Real-money orders are off.')
                  }
                />
              </label>
              <div className="phone-access-dim">Saved in {view.file}</div>
            </>
          )}
          {saved && <div className="phone-access-ok">{saved}</div>}
          {error && <div className="phone-access-warn">{error}</div>}
        </div>
      </div>
    </div>
  )
}
