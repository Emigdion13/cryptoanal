/**
 * Where settings and saved layouts live. With the dev server (`npm run dev` / `npm run preview`)
 * that is one file on disk, ~/.cryptoanal/workspace.json (server/workspace.ts): the same on every
 * port and every browser, with no size limit. It is read once at startup, before the first
 * render, and is the only copy: the browser's old settings are moved into it the first time and
 * then removed, so two copies can never disagree.
 *
 * Changes are sent as small PATCHes (the settings, or one layout) shortly after they happen, one
 * at a time; a failed save is kept, retried, and reported. A last save goes out as the page closes.
 *
 * Without the server (a static deploy) everything stays in the browser's storage instead.
 */
import type { SavedLayout } from '../ui/layoutStore'
import type { Settings } from '../ui/settings'

const ENDPOINT = '/api/workspace'
/** A burst of changes (a divider drag) becomes one save. */
const SAVE_DELAY_MS = 400
const RETRY_MS = 3000
/** How long startup waits for the server before opening on the browser's storage. */
const START_WAIT_MS = 3000
/** Browsers drop a keep-alive request sent while the page closes above about 64 KB. */
const KEEPALIVE_MAX_CHARS = 60_000

export const SETTINGS_KEY = 'cryptoanal.settings.v2'
export const OLD_SETTINGS_KEY = 'cryptoanal.settings.v1'
const LAYOUTS_KEY = 'cryptoanal.layouts.v1'

export interface WorkspaceInfo {
  mode: 'file' | 'browser'
  file: string | null
}

interface Changes {
  settings?: Settings
  layouts?: Record<string, SavedLayout | null>
}

let info: WorkspaceInfo = { mode: 'browser', file: null }
let initialSettings: Settings | null = null
/** The single-chart settings of the first version, for settings.ts to migrate. */
let initialV1: Record<string, unknown> | null = null
let initialLayouts: SavedLayout[] = []

const pending: Changes = {}
let timer: ReturnType<typeof setTimeout> | undefined
let saving: Promise<void> = Promise.resolve()
const problemListeners = new Set<(message: string | null) => void>()

function readBrowser(): { settings: Settings | null; v1: Record<string, unknown> | null; layouts: SavedLayout[] } {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    const v1 = localStorage.getItem(OLD_SETTINGS_KEY)
    const layouts = localStorage.getItem(LAYOUTS_KEY)
    return {
      settings: raw ? (JSON.parse(raw) as Settings) : null,
      v1: v1 ? (JSON.parse(v1) as Record<string, unknown>) : null,
      layouts: layouts ? Object.values(JSON.parse(layouts) as Record<string, SavedLayout>) : [],
    }
  } catch {
    return { settings: null, v1: null, layouts: [] }
  }
}

async function patch(changes: Changes, keepalive = false): Promise<void> {
  const body = JSON.stringify({ changes })
  const res = await fetch(ENDPOINT, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: keepalive && body.length < KEEPALIVE_MAX_CHARS,
  })
  if (!res.ok) {
    const reason = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
    throw new Error(reason ?? `save failed (${res.status})`)
  }
}

/**
 * Picks the store before the app renders: the file when the dev server answers and lets this
 * computer write, else the browser. Moves the browser's settings into a new file.
 */
export async function startWorkspace(): Promise<void> {
  const browser = readBrowser()
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), START_WAIT_MS)
    const res = await fetch(ENDPOINT, { cache: 'no-store', signal: controller.signal })
    clearTimeout(t)
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.includes('application/json')) throw new Error('no workspace server')
    const reply = (await res.json()) as {
      file: string
      writable: boolean
      data: { settings: Settings | null; layouts: Record<string, SavedLayout> } | null
    }
    if (!reply.writable || typeof reply.file !== 'string') throw new Error('workspace not writable')
    info = { mode: 'file', file: reply.file }
    if (reply.data?.settings) {
      initialSettings = reply.data.settings
      initialLayouts = Object.values(reply.data.layouts ?? {})
    } else {
      // First run with the file: move what this browser had into it.
      // (settings.ts migrates v1 and saves the result on the first change.)
      initialSettings = browser.settings
      initialV1 = browser.settings ? null : browser.v1
      initialLayouts = browser.layouts
      if (initialSettings || initialLayouts.length)
        await patch({
          ...(initialSettings && { settings: initialSettings }),
          layouts: Object.fromEntries(initialLayouts.map((l) => [l.id, l])),
        })
    }
    // One copy only: the browser's is now stale.
    for (const key of [SETTINGS_KEY, OLD_SETTINGS_KEY, LAYOUTS_KEY]) localStorage.removeItem(key)
  } catch {
    info = { mode: 'browser', file: null }
    initialSettings = browser.settings
    initialV1 = browser.settings ? null : browser.v1
    initialLayouts = browser.layouts
  }
}

export const workspaceInfo = () => info
export const getInitialSettings = () => initialSettings
export const getInitialV1 = () => initialV1
export const getInitialLayouts = () => initialLayouts

/** Hears about failed saves (a message) and recoveries (null). */
export function onSaveProblem(fn: (message: string | null) => void): () => void {
  problemListeners.add(fn)
  return () => problemListeners.delete(fn)
}
const report = (message: string | null) => problemListeners.forEach((fn) => fn(message))

function writeBrowser(changes: Changes) {
  try {
    if (changes.settings) localStorage.setItem(SETTINGS_KEY, JSON.stringify(changes.settings))
    if (changes.layouts) {
      const all = Object.fromEntries(readBrowser().layouts.map((l) => [l.id, l]))
      for (const [id, l] of Object.entries(changes.layouts)) {
        if (l) all[id] = l
        else delete all[id]
      }
      localStorage.setItem(LAYOUTS_KEY, JSON.stringify(all))
    }
    report(null)
  } catch {
    report('The browser’s storage is full, so layouts could not be saved.')
  }
}

function take(): Changes | null {
  if (!pending.settings && !pending.layouts) return null
  const changes: Changes = { ...pending }
  delete pending.settings
  delete pending.layouts
  return changes
}

/** Sends everything waiting now. Resolves once the save landed (or failed and was re-queued). */
export function flushWorkspace(keepalive = false): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  const changes = take()
  if (!changes) return saving
  if (info.mode === 'browser') {
    writeBrowser(changes)
    return saving
  }
  saving = saving
    .then(() => patch(changes, keepalive))
    .then(() => report(null))
    .catch((error: unknown) => {
      // Keep the changes (unless something newer came in meanwhile) and try again.
      if (changes.settings && !pending.settings) pending.settings = changes.settings
      for (const [id, l] of Object.entries(changes.layouts ?? {}))
        if (!pending.layouts || !(id in pending.layouts)) pending.layouts = { ...pending.layouts, [id]: l }
      report(`Couldn't save to ${info.file}: ${error instanceof Error ? error.message : String(error)}. Retrying…`)
      schedule(RETRY_MS)
    })
  return saving
}

function schedule(delay = SAVE_DELAY_MS) {
  if (timer === undefined) timer = setTimeout(() => void flushWorkspace(), delay)
}

// What the app starts from follows every change, not just the file read at page load: a remount
// (a dev-server hot update while the app is open) must start from the latest state, or it would
// save the page-load copy back over everything changed since.

export function queueSettings(settings: Settings) {
  initialSettings = settings
  initialV1 = null
  pending.settings = settings
  schedule()
}

export function queueLayout(id: string, layout: SavedLayout | null) {
  const known = initialLayouts.some((l) => l.id === id)
  initialLayouts = layout
    ? known
      ? initialLayouts.map((l) => (l.id === id ? layout : l))
      : [...initialLayouts, layout]
    : initialLayouts.filter((l) => l.id !== id)
  pending.layouts = { ...pending.layouts, [id]: layout }
  schedule()
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flushWorkspace(true))
