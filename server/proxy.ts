/**
 * Telling this computer's own browser from a phone coming through `tailscale serve`: both reach
 * the server from loopback, but the proxy adds a `*.ts.net` host and its forwarding headers.
 */
import type { IncomingMessage } from 'node:http'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export const header = (req: IncomingMessage, name: string): string => {
  const value = req.headers[name]
  return (Array.isArray(value) ? value[0] : (value ?? '')).trim()
}

export const isLoopback = (req: IncomingMessage) => LOOPBACK.has(req.socket.remoteAddress ?? '')

/** The address the browser used: the proxy's X-Forwarded-Host when there is one, without port. */
export function requestHost(req: IncomingMessage): string {
  const raw = (header(req, 'x-forwarded-host').split(',')[0] || header(req, 'host')).trim()
  const host = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return host.toLowerCase()
}

/** Whether a request came through a proxy (Tailscale's), rather than from a browser on this computer. */
export function isProxied(req: IncomingMessage): boolean {
  return (
    header(req, 'tailscale-user-login') !== '' ||
    header(req, 'x-forwarded-for') !== '' ||
    header(req, 'x-forwarded-host') !== '' ||
    header(req, 'forwarded') !== '' ||
    requestHost(req).endsWith('.ts.net')
  )
}

/** This computer's own browser: from loopback and not through a proxy. */
export const isLocal = (req: IncomingMessage) => isLoopback(req) && !isProxied(req)
