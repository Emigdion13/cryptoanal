import { useEffect, useState } from 'react'
import { CloseIcon } from './icons'

interface PhoneSettings {
  enabled: boolean
  passcodeSet: boolean
  sessions: number
  passkeys: number
  /** This computer's Tailscale name, when Tailscale is on. */
  name: string | null
  /** The phone page's address, once `tailscale serve` publishes this port. */
  url: string | null
  port: number
}

async function call(body?: Record<string, unknown>): Promise<PhoneSettings> {
  const response = await fetch('/api/phone/settings', {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json', 'X-CryptoAnal-Phone': '1' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const data = (await response.json().catch(() => null)) as (PhoneSettings & { message?: string }) | null
  if (!response.ok || !data) throw new Error(data?.message ?? 'The dev server is not answering.')
  return data
}

/**
 * ⚙ → Phone access: V2's iPhone access for this app. The passcode, the switch, and signing every
 * phone out; the phone page itself is phone.html through Tailscale (server/phone.ts).
 */
export function PhoneAccessDialog({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<PhoneSettings | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    call().then(setSettings, (e: Error) => setError(e.message))
  }, [])
  const change = (body: Record<string, unknown>, done: string) => {
    setError(null)
    setSaved(null)
    call(body).then(
      (s) => {
        setSettings(s)
        setSaved(done)
      },
      (e: Error) => setError(e.message),
    )
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog phone-dialog" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="dialog-head">
          <span className="dialog-title">Phone access</span>
          <button className="dialog-close" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="settings-body phone-access">
          <p className="phone-access-note">
            Your iPhone opens these charts through Tailscale, your own private network: nobody else can reach the page. It
            still asks for this passcode, or Face ID, and it can only look — never change your layouts.
          </p>
          {settings && (
            <>
              <div className="phone-access-row">
                <span>Address</span>
                {settings.url ? (
                  <code>{settings.url}</code>
                ) : settings.name ? (
                  <span className="phone-access-warn">
                    Not published yet. Run once in a Terminal:
                    <code>tailscale serve --bg --https=8443 {settings.port}</code>
                  </span>
                ) : (
                  <span className="phone-access-warn">Tailscale is off or not signed in on this computer.</span>
                )}
              </div>
              <label className="field column">
                <span>{settings.passcodeSet ? 'New passcode (signs every phone out)' : '6-digit passcode'}</span>
                <span className="phone-access-pass">
                  <input
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    placeholder="••••••"
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  />
                  <button
                    className="btn primary"
                    disabled={code.length !== 6}
                    onClick={() => {
                      change({ passcode: code }, 'Passcode set.')
                      setCode('')
                    }}
                  >
                    Set
                  </button>
                </span>
              </label>
              <label className="menu-item switch-item phone-access-switch">
                <span className="menu-label">Allow the phone page</span>
                <input
                  type="checkbox"
                  className="switch"
                  checked={settings.enabled}
                  disabled={!settings.passcodeSet}
                  onChange={(e) => change({ enabled: e.target.checked }, e.target.checked ? 'Phone access is on.' : 'Phone access is off.')}
                />
              </label>
              <div className="phone-access-row">
                <span className="phone-access-dim">
                  {settings.sessions} phone{settings.sessions === 1 ? '' : 's'} signed in · {settings.passkeys} Face ID
                </span>
                <button
                  className="btn ghost"
                  disabled={!settings.sessions && !settings.passkeys}
                  onClick={() => change({ signOutAll: true }, 'Every phone is signed out.')}
                >
                  Sign out all phones
                </button>
              </div>
            </>
          )}
          {saved && <div className="phone-access-ok">{saved}</div>}
          {error && <div className="phone-access-warn">{error}</div>}
        </div>
      </div>
    </div>
  )
}
