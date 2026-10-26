import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getInitialLayouts, onSaveProblem, queueLayout, queueSettings, workspaceInfo } from '../data/workspace'
import { contentOf, makeLayout, type LayoutContent, type SavedLayout } from './layoutStore'
import { defaults, type Settings } from './settings'

type Update = (patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)) => void

export interface WorkspaceApi {
  /** The file saves go to, or null when they stay in this browser. */
  file: string | null
  layouts: SavedLayout[]
  current: SavedLayout | null
  /** The charts differ from the saved copy of the current layout. */
  dirty: boolean
  autosaveOn: boolean
  /** Why the last save to the file failed (it is being retried), or null. */
  saveError: string | null
  /** Saves the current layout; false when it has no name yet (ask for one, then saveAs). */
  save: () => boolean
  saveAs: (name: string) => void
  rename: (name: string) => void
  newLayout: (name: string) => void
  open: (id: string) => void
  remove: (id: string) => void
  setAutosave: (on: boolean) => void
}

/** Named chart layouts, as on TradingView, saved one by one to the workspace. */
export function useWorkspace(settings: Settings, update: Update): WorkspaceApi {
  const [layouts, setLayouts] = useState<SavedLayout[]>(getInitialLayouts)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => onSaveProblem(setSaveError), [])

  /** Changes the list and saves just the layouts that changed. */
  const change = useCallback((fn: (list: SavedLayout[]) => SavedLayout[]) => {
    setLayouts((list) => {
      const next = fn(list)
      const before = new Map(list.map((l) => [l.id, l]))
      for (const l of next) if (before.get(l.id) !== l) queueLayout(l.id, l)
      for (const id of before.keys()) if (!next.some((l) => l.id === id)) queueLayout(id, null)
      return next
    })
  }, [])

  // First run: the settings land in the file at once (not on the first change), and there is a
  // saved layout from the start, so autosave always has somewhere to write.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const s = settingsRef.current
    queueSettings(s)
    const initial = getInitialLayouts()
    // Deleted from another tab or window: this one now shows an unsaved layout.
    if (s.currentLayoutId && !initial.some((l) => l.id === s.currentLayoutId)) update({ currentLayoutId: null })
    if (!initial.length) {
      const first = makeLayout('My layout', contentOf(settingsRef.current))
      change((list) => (list.length ? list : [first]))
      update({ currentLayoutId: first.id })
    }
  }, [change, update])

  const current = layouts.find((l) => l.id === settings.currentLayoutId) ?? null
  const content = useMemo(() => contentOf(settings), [settings])
  const contentKey = useMemo(() => JSON.stringify(content), [content])
  const savedKey = useMemo(() => (current ? JSON.stringify(current.content) : ''), [current])
  const dirty = !current || savedKey !== contentKey

  const writeCurrent = useCallback(
    (id: string, c: LayoutContent) =>
      change((list) => list.map((l) => (l.id === id ? { ...l, content: structuredClone(c), updatedAt: Date.now() } : l))),
    [change],
  )

  // Autosave: the current layout follows the charts a second after they settle.
  useEffect(() => {
    if (!settings.autosave || !current || !dirty) return
    const t = setTimeout(() => writeCurrent(current.id, content), 1000)
    return () => clearTimeout(t)
  }, [settings.autosave, current, dirty, content, writeCurrent])

  const saveAs = (name: string) => {
    const layout = makeLayout(name, content)
    change((list) => [...list, layout])
    update({ currentLayoutId: layout.id })
  }

  return {
    file: workspaceInfo().file,
    layouts,
    current,
    dirty,
    autosaveOn: settings.autosave,
    saveError,
    save: () => {
      if (!current) return false
      writeCurrent(current.id, content)
      return true
    },
    saveAs,
    rename: (name) => {
      if (!current) return saveAs(name)
      change((list) => list.map((l) => (l.id === current.id ? { ...l, name, updatedAt: Date.now() } : l)))
    },
    newLayout: (name) => {
      const layout = makeLayout(name, contentOf(defaults()))
      change((list) => [...list, layout])
      update({ ...structuredClone(layout.content), currentLayoutId: layout.id })
    },
    open: (id) => {
      const layout = layouts.find((l) => l.id === id)
      if (layout) update({ ...structuredClone(layout.content), currentLayoutId: id })
    },
    remove: (id) => {
      change((list) => list.filter((l) => l.id !== id))
      if (id === settings.currentLayoutId) update({ currentLayoutId: null })
    },
    setAutosave: (autosave) => update({ autosave }),
  }
}
