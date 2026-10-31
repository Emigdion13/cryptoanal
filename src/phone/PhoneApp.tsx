import { useCallback, useEffect, useState } from 'react'
import {
  faceIdAvailable,
  phoneSession,
  PhoneRequestError,
  setUpFaceId,
  signInWithFaceId,
  signInWithPasscode,
  signOut,
  type PhoneSession,
} from './auth'
import { PhoneCharts } from './PhoneCharts'

type Screen =
  | { kind: 'loading' }
  | { kind: 'refused'; message: string }
  | { kind: 'signIn'; session: PhoneSession }
  | { kind: 'charts'; session: PhoneSession; offerFaceId: boolean }

const message = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

/** The phone page: sign in (passcode, then Face ID), then the desktop's charts. */
export function PhoneApp() {
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })

  const check = useCallback(async (offerFaceId = false) => {
    try {
      const session = await phoneSession()
      setScreen(session.signedIn ? { kind: 'charts', session, offerFaceId: offerFaceId && session.passkeys === 0 } : { kind: 'signIn', session })
    } catch (error) {
      setScreen({ kind: 'refused', message: message(error) })
    }
  }, [])
  useEffect(() => void check(), [check])
  const onSignedOut = useCallback(() => void check(), [check])

  if (screen.kind === 'loading') return <div className="phone-center phone-dim">Connecting…</div>
  if (screen.kind === 'refused')
    return (
      <div className="phone-center">
        <Brand />
        <p className="phone-note">{screen.message}</p>
        <button className="phone-btn" onClick={() => void check()}>
          Try again
        </button>
      </div>
    )
  if (screen.kind === 'signIn') return <SignIn session={screen.session} onDone={() => void check(true)} />
  return (
    <>
      <PhoneCharts
        local={!!screen.session.local}
        onSignedOut={onSignedOut}
        onSignOut={() => void signOut().finally(() => void check())}
      />
      {screen.offerFaceId && <FaceIdOffer onClose={() => setScreen({ ...screen, offerFaceId: false })} />}
    </>
  )
}

function Brand() {
  return (
    <div className="phone-brand">
      <svg width="44" height="44" viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="7" fill="#131313" />
        <path d="M9 8v16M9 12h-2M9 20h2" stroke="#089981" strokeWidth="2" />
        <rect x="17" y="10" width="6" height="10" fill="#f23645" />
        <path d="M20 6v4M20 20v6" stroke="#f23645" strokeWidth="2" />
      </svg>
      <span>CryptoAnal</span>
    </div>
  )
}

/** V2's lock screen: Face ID when this phone has it, else six dots and a keypad. */
function SignIn({ session, onDone }: { session: PhoneSession; onDone: () => void }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [faceId, setFaceId] = useState(false)
  useEffect(() => {
    if (session.passkeys > 0) void faceIdAvailable().then(setFaceId)
  }, [session.passkeys])

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await task()
      onDone()
    } catch (e) {
      setError(message(e))
      setCode('')
    } finally {
      setBusy(false)
    }
  }
  const press = (digit: string) => {
    if (busy) return
    setError(null)
    const next = (code + digit).slice(0, 6)
    setCode(next)
    if (next.length === 6) void run(() => signInWithPasscode(next))
  }

  return (
    <div className="phone-center">
      <Brand />
      {faceId && (
        <button className="phone-btn primary" disabled={busy} onClick={() => void run(signInWithFaceId)}>
          Sign in with Face ID
        </button>
      )}
      <p className="phone-note phone-dim">{faceId ? 'or enter your passcode' : 'Enter your passcode'}</p>
      <div className="phone-dots" aria-label={`${code.length} of 6 digits entered`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={i < code.length ? 'on' : undefined} />
        ))}
      </div>
      <div className="phone-keypad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <span />
        <button onClick={() => press('0')} disabled={busy}>
          0
        </button>
        <button className="plain" aria-label="Delete a digit" onClick={() => setCode(code.slice(0, -1))} disabled={busy || !code}>
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
            <path d="M9 5h11v14H9l-6-7z M12 9.5l5 5M17 9.5l-5 5" />
          </svg>
        </button>
      </div>
      <p className={error ? 'phone-error' : 'phone-note phone-dim'} role="status">
        {error ?? 'Set on the computer in ⚙ → Phone access.'}
      </p>
    </div>
  )
}

/** After a passcode sign-in on a phone with no Face ID here yet. */
function FaceIdOffer({ onClose }: { onClose: () => void }) {
  const [available, setAvailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => void faceIdAvailable().then(setAvailable), [])
  if (!available) return null
  return (
    <div className="phone-sheet">
      <b>Use Face ID next time?</b>
      <span className="phone-dim">A passkey stays in this iPhone's keychain; the computer keeps only its public key.</span>
      {error && <span className="phone-error">{error}</span>}
      <div className="phone-row">
        <button className="phone-btn" onClick={onClose}>
          Not now
        </button>
        <button
          className="phone-btn primary"
          onClick={() =>
            void setUpFaceId().then(onClose, (e: unknown) =>
              setError(e instanceof PhoneRequestError || e instanceof Error ? e.message : 'Face ID was not set up.'),
            )
          }
        >
          Set up
        </button>
      </div>
    </div>
  )
}
