/**
 * The phone page's sign-in, as btcAnalyzerV2's: the passcode, and Face ID through a passkey kept
 * in the phone's keychain (WebAuthn). The server checks everything (server/phone.ts); this only
 * carries the bytes between Safari and it.
 */

export interface PhoneSession {
  host: string
  signedIn: boolean
  /** Face ID passkeys this address knows. */
  passkeys: number
  /** Opened on the computer itself: no sign-in, no Face ID. */
  local?: boolean
}

/** A refusal from the server, with its code ("PHONE_OFF", "LOCKED", …). */
export class PhoneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** A JSON request the phone gate accepts: POSTs carry the page's header (server/phone.ts). */
export async function phoneFetch<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CryptoAnal-Phone': '1' }
        : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      credentials: 'same-origin',
    })
  } catch {
    throw new PhoneRequestError(0, 'OFFLINE', "Can't reach the computer. Is it awake, with the app running and Tailscale on?")
  }
  const data = (await response.json().catch(() => null)) as ({ error?: unknown; message?: unknown } & T) | null
  if (!response.ok)
    throw new PhoneRequestError(
      response.status,
      typeof data?.error === 'string' ? data.error : 'FAILED',
      typeof data?.message === 'string' ? data.message : `The computer answered ${response.status}.`,
    )
  return data as T
}

const call = <T>(route: string, body?: Record<string, unknown>) => phoneFetch<T>(`/api/phone/${route}`, body)

export const phoneSession = () => call<PhoneSession>('session')
export const signInWithPasscode = (passcode: string) => call('login', { passcode })
export const signOut = () => call('logout', {})

const toBytes = (b64url: string) => Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
const toB64 = (buffer: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

/** Whether this phone can do Face ID (or Touch ID) for a passkey. */
export async function faceIdAvailable(): Promise<boolean> {
  try {
    return typeof window.PublicKeyCredential !== 'undefined' && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
  } catch {
    return false
  }
}

interface CreateOptions {
  challenge: string
  rp: { id: string; name: string }
  user: { id: string; name: string; displayName: string }
  pubKeyCredParams: { type: 'public-key'; alg: number }[]
  authenticatorSelection: AuthenticatorSelectionCriteria
  attestation: AttestationConveyancePreference
  timeout: number
  excludeCredentials: { type: 'public-key'; id: string }[]
}

interface GetOptions {
  challenge: string
  rpId: string
  allowCredentials: { type: 'public-key'; id: string }[]
  userVerification: UserVerificationRequirement
  timeout: number
}

/** Makes a Face ID passkey for this address (the phone is signed in with the passcode). */
export async function setUpFaceId(): Promise<void> {
  const options = await call<CreateOptions>('passkey/create-options', {})
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: options.excludeCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Face ID was not set up.')
  const response = credential.response as AuthenticatorAttestationResponse
  await call('passkey/create', {
    id: credential.id,
    clientDataJSON: toB64(response.clientDataJSON),
    attestationObject: toB64(response.attestationObject),
  })
}

/** Signs in with Face ID: the phone's passkey signs the server's challenge. */
export async function signInWithFaceId(): Promise<void> {
  const options = await call<GetOptions>('passkey/get-options', {})
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      allowCredentials: options.allowCredentials.map((c) => ({ ...c, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error('Face ID was canceled.')
  const response = credential.response as AuthenticatorAssertionResponse
  await call('passkey/get', {
    id: credential.id,
    clientDataJSON: toB64(response.clientDataJSON),
    authenticatorData: toB64(response.authenticatorData),
    signature: toB64(response.signature),
  })
}
