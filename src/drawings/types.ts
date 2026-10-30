/** A drawing's anchor: a bar time (seconds, UTC; past the last bar it runs on at the interval) and a price. */
export interface DrawingPoint {
  time: number
  price: number
}

export type LineDash = 'solid' | 'dashed' | 'dotted'

/** A drawing the user placed with a tool from the left toolbar. Saved per symbol, shown at every interval. */
export interface UserDrawing {
  id: string
  /** A tool id from TOOLS. */
  tool: string
  points: DrawingPoint[]
  color: string
  width: number
  dash: LineDash
  /** Shapes and boxes: filled behind the outline. */
  fill: boolean
  text?: string
  /** Tool switches: extendLeft, extendRight, labels. */
  opts?: Record<string, boolean | number | string>
  locked?: boolean
  hidden?: boolean
}

/** Magnet: points snap to a bar's open, high, low or close — when near one (weak) or always (strong). */
export type MagnetMode = 'off' | 'weak' | 'strong'

/** The left toolbar's switches for every chart's drawings. */
export interface DrawingPrefs {
  magnet: MagnetMode
  /** Keep the tool after placing a drawing, instead of going back to the cursor. */
  stay: boolean
  /** No drawing can be moved, changed or removed by the mouse. */
  locked: boolean
  hidden: boolean
}

export const DRAWING_PREFS_DEFAULTS: DrawingPrefs = { magnet: 'off', stay: false, locked: false, hidden: false }
