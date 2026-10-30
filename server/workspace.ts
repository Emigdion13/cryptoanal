/**
 * The workspace file: CryptoAnal's settings and saved chart layouts, kept on disk instead of in
 * the browser. Browser storage is per origin — another dev-server port or cleared site data
 * starts empty — and only a few megabytes; the file has neither problem.
 *
 * `CRYPTOANAL_STORE`, or `~/.cryptoanal/workspace.json` by default, holds
 * `{ version: 1, settings, layouts: { id: layout } }`. Changes arrive as PATCHes of single
 * entries (`settings`, one layout, or a layout's removal) and are applied one at a time to the
 * file as it is on disk, so two tabs saving different layouts never undo each other.
 * Reads are open; writes only from this computer (loopback, not through a proxy) unless
 * CRYPTOANAL_ALLOW_REMOTE=1. A phone through Tailscale is gated by server/phone.ts.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import { isLocal } from './proxy'

/** Far above any real workspace (a layout is a few KB); only a guard. */
export const WORKSPACE_MAX_BYTES = 32 * 1024 * 1024

export function workspaceFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CRYPTOANAL_STORE?.trim() || join(homedir(), '.cryptoanal', 'workspace.json'))
}

export interface WorkspaceData {
  version: 1
  settings: Record<string, unknown> | null
  layouts: Record<string, Record<string, unknown>>
}

/** `settings` to replace them; `layouts: { id: layout }` to save one, `{ id: null }` to delete it. */
export interface WorkspaceChanges {
  settings?: Record<string, unknown>
  layouts?: Record<string, Record<string, unknown> | null>
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const validId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id)

export function isChanges(value: unknown): value is WorkspaceChanges {
  if (!isObject(value)) return false
  if (value.settings !== undefined && !isObject(value.settings)) return false
  if (value.layouts !== undefined) {
    if (!isObject(value.layouts)) return false
    for (const [id, layout] of Object.entries(value.layouts)) {
      if (!validId(id)) return false
      if (layout !== null && !(isObject(layout) && layout.id === id && typeof layout.name === 'string' && isObject(layout.content)))
        return false
    }
  }
  return true
}

export function applyChanges(data: WorkspaceData, changes: WorkspaceChanges): WorkspaceData {
  const layouts = { ...data.layouts }
  for (const [id, layout] of Object.entries(changes.layouts ?? {})) {
    if (layout === null) delete layouts[id]
    else layouts[id] = layout
  }
  return { version: 1, settings: changes.settings ?? data.settings, layouts }
}

class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > WORKSPACE_MAX_BYTES) throw new WorkspaceError(413, 'Workspace is too large.')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new WorkspaceError(400, 'Workspace change is not valid JSON.')
  }
}

export function createWorkspaceApi(
  file = workspaceFile(),
  allowRemoteWrites = process.env.CRYPTOANAL_ALLOW_REMOTE === '1',
) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(JSON.stringify(value))
  }
  const read = async (): Promise<WorkspaceData | null> => {
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch {
      return null
    }
    const parsed = JSON.parse(text) as Partial<WorkspaceData>
    if (parsed?.version !== 1 || !isObject(parsed.layouts))
      throw new WorkspaceError(500, `The workspace file ${file} is not a valid workspace.`)
    return { version: 1, settings: isObject(parsed.settings) ? parsed.settings : null, layouts: parsed.layouts as WorkspaceData['layouts'] }
  }
  const write = async (data: WorkspaceData) => {
    await mkdir(dirname(file), { recursive: true })
    // Write then rename, so a crash never leaves a half-written file; keep the last version too.
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(data, null, 1), 'utf8')
    await copyFile(file, `${file}.bak`).catch(() => {})
    await rename(temporary, file)
  }
  // One change at a time: a read-modify-write must not interleave with another.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => undefined)
    return run
  }

  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    // A phone through Tailscale's proxy arrives from loopback too: it is not this computer.
    const writable = allowRemoteWrites || isLocal(req)
    if (req.method === 'GET') {
      const data = await serial(read)
      json(res, 200, { file, writable, exists: data !== null, data })
      return
    }
    if (req.method !== 'PATCH') throw new WorkspaceError(405, 'Use GET or PATCH.')
    if (!writable) throw new WorkspaceError(403, 'The workspace can only be changed from this computer.')
    const payload = (await body(req)) as { changes?: unknown }
    if (!isChanges(payload?.changes)) throw new WorkspaceError(400, 'Not a valid workspace change.')
    const changes = payload.changes
    const layouts = await serial(async () => {
      const next = applyChanges((await read()) ?? { version: 1, settings: null, layouts: {} }, changes)
      await write(next)
      return Object.keys(next.layouts).length
    })
    json(res, 200, { layouts })
  }

  return {
    file,
    handle(req: IncomingMessage, res: ServerResponse): boolean {
      if ((req.url?.split('?')[0] ?? '') !== '/api/workspace') return false
      void dispatch(req, res).catch((error) => {
        const e = error instanceof WorkspaceError ? error : new WorkspaceError(500, 'Could not save the workspace.')
        json(res, e.status, { error: e.message })
      })
      return true
    },
  }
}

/** Serves /api/workspace from `npm run dev` and `npm run preview`. */
export function workspacePlugin(): Plugin {
  const api = createWorkspaceApi()
  const use = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!api.handle(req, res)) next()
  }
  return {
    name: 'cryptoanal-workspace',
    configureServer(server) {
      server.middlewares.use(use)
      server.config.logger.info(`  workspace file: ${api.file}`)
    },
    configurePreviewServer(server) {
      server.middlewares.use(use)
    },
  }
}
