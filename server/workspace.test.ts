import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceApi } from './workspace'

let dir: string
let file: string
let server: Server
let url: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cryptoanal-ws-'))
  file = join(dir, 'nested', 'workspace.json')
  const api = createWorkspaceApi(file, false)
  server = createServer((req, res) => {
    if (!api.handle(req, res)) res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  url = `http://127.0.0.1:${address.port}/api/workspace`
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  rmSync(dir, { recursive: true, force: true })
})

const layout = (id: string, name: string) => ({ id, name, updatedAt: 1, content: { layout: '1', charts: [] } })
const patch = (changes: unknown) =>
  fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ changes }) })

describe('workspace file', () => {
  it('starts empty and creates the file on the first save', async () => {
    const empty = await (await fetch(url)).json()
    expect(empty).toMatchObject({ file, writable: true, exists: false, data: null })
    expect((await patch({ settings: { layout: '2v' } })).status).toBe(200)
    expect(JSON.parse(readFileSync(file, 'utf8')).settings).toEqual({ layout: '2v' })
  })

  it('keeps layouts saved separately, as two tabs would', async () => {
    await patch({ layouts: { a: layout('a', 'Scalping') } })
    await patch({ layouts: { b: layout('b', 'Swing') } })
    await patch({ settings: { layout: '1' } })
    const { data } = await (await fetch(url)).json()
    expect(Object.keys(data.layouts).sort()).toEqual(['a', 'b'])
    expect(data.settings).toEqual({ layout: '1' })
  })

  it('deletes one layout and leaves the rest', async () => {
    await patch({ layouts: { a: layout('a', 'A'), b: layout('b', 'B') } })
    await patch({ layouts: { a: null } })
    const { data } = await (await fetch(url)).json()
    expect(Object.keys(data.layouts)).toEqual(['b'])
  })

  it('applies saves that arrive together one after another', async () => {
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => patch({ layouts: { [id]: layout(id, id) } })))
    const { data } = await (await fetch(url)).json()
    expect(Object.keys(data.layouts).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('refuses malformed changes without touching the file', async () => {
    await patch({ layouts: { a: layout('a', 'A') } })
    expect((await patch({ layouts: { 'bad id!': layout('bad id!', 'x') } })).status).toBe(400)
    expect((await patch({ layouts: { a: { id: 'other', name: 'x', content: {} } } })).status).toBe(400)
    expect((await fetch(url, { method: 'PATCH', body: '{nope' })).status).toBe(400)
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(405)
    const { data } = await (await fetch(url)).json()
    expect(data.layouts.a.name).toBe('A')
  })
})
