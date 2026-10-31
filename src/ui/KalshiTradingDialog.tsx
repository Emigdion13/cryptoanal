import { useEffect, useState } from 'react'
import { CloseIcon } from './icons'

type Env = 'demo' | 'live'

interface KeyStatus {
  keyId: string
  path: string
  /** Saved here, borrowed from btcAnalyzerV2's settings, or not set. */
  source: 'settings' | 'btcAnalyzerV2' | null
  error: string | null
}

interface KeysView {
  file: string
  demo: KeyStatus
  live: KeyStatus
  liveTrading: boolean
}

async function call(body?: Record<string, unknown>): Promise<KeysView> {
  const response = await fetch('/api/trade/settings', {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-CryptoAnal-Phone': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = (await response.json().catch(() => null)) as (KeysView & { message?: string }) | null
  if (!response.ok || !data) throw new Error(data?.message ?? 'The dev server is not answering.')
  return data
}

const ENV_LABEL: Record<Env, string> = { demo: 'Demo key', live: 'Live key (real money)' }

/**
 * ⚙ → Kalshi trading: the keys the phone's quick-trade circles sign orders with, and the switch
 * for real-money orders. The private keys stay files on this computer; only their paths are kept.
 * An account without a key of its own here uses btcAnalyzerV2's.
 */
export function KalshiTradingDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<KeysView | null>(null)
  const [editing, setEditing] = useState<Env | null>(null)
  const [keyId, setKeyId] = useState('')
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    call().then(setView, (e: Error) => setError(e.message))
  }, [])
  const change = (body: Record<string, unknown>, done: string) => {
    setError(null)
    setSaved(null)
    call(body).then(
      (v) => {
        setView(v)
        setSaved(done)
        setEditing(null)
      },
      (e: Error) => setError(e.message),
    )
  }
  const edit = (env: Env) => {
    setEditing(env)
    setKeyId(view?.[env].source === 'settings' ? view[env].keyId : '')
    setPath(view?.[env].source === 'settings' ? view[env].path : '')
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog phone-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="dialog-head">
          <span className="dialog-title">Kalshi trading</span>
          <button className="dialog-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="settings-body phone-access">
          <p className="phone-access-note">
            The phone's quick-trade circles (tap an indicator's name) buy and sell Kalshi's 15-minute markets with these keys.
            The keys never leave this computer. The phone starts in Demo; Live orders need the switch below.
          </p>
          {view && (
            <>
              {(['demo', 'live'] as const).map((env) => {
                const k = view[env]
                return (
                  <div key={env} className="kalshi-key">
                    <div className="phone-access-row">
                      <span>{ENV_LABEL[env]}</span>
                      <span className="kalshi-key-actions">
                        <button className="btn ghost" onClick={() => edit(env)}>
                          {k.source === 'settings' ? 'Change' : 'Set'}
                        </button>
                        {k.source === 'settings' && (
                          <button className="btn ghost" onClick={() => change({ clear: env }, `The ${env} key is removed.`)}>
                            Remove
                          </button>
                        )}
                      </span>
                    </div>
                    <div className="phone-access-dim">
                      {k.source === null
                        ? 'Not set.'
                        : `${k.keyId.slice(0, 8)}… · ${k.source === 'btcAnalyzerV2' ? "btcAnalyzerV2's key" : 'saved here'}`}
                    </div>
                    {k.error && <div className="phone-access-warn kalshi-key-error">{k.error}</div>}
                    {editing === env && (
                      <div className="kalshi-key-form">
                        <input value={keyId} placeholder="Key ID" spellCheck={false} onChange={(e) => setKeyId(e.target.value.trim())} />
                        <input value={path} placeholder="Private key file, e.g. ~/.kalshi/demo.pem" spellCheck={false} onChange={(e) => setPath(e.target.value)} />
                        <span className="kalshi-key-actions">
                          <button className="btn ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button
                            className="btn primary"
                            disabled={!keyId || !path.trim()}
                            onClick={() => change({ save: { env, keyId, path: path.trim() } }, `The ${env} key is saved.`)}
                          >
                            Save
                          </button>
                        </span>
                      </div>
                    )}
                  </div>
                )
              })}
              <label className="menu-item switch-item phone-access-switch">
                <span className="menu-label">Allow real-money orders</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={view.liveTrading}
                  disabled={!view.live.source && !view.liveTrading}
                  onChange={(e) =>
                    change({ liveTrading: e.target.checked }, e.target.checked ? 'Live orders are on: the phone can trade real money.' : 'Live orders are off.')
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
