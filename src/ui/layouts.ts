/** A multi-chart layout: a CSS grid, and where each chart sits in it (row/col start and end). */
export interface LayoutDef {
  id: string
  name: string
  cols: number
  rows: number
  /** [rowStart, colStart, rowEnd, colEnd] per chart, 1-based like grid-area. */
  cells: [number, number, number, number][]
}

function grid(id: string, name: string, cols: number, rows: number): LayoutDef {
  const cells: LayoutDef['cells'] = []
  for (let r = 1; r <= rows; r++) for (let c = 1; c <= cols; c++) cells.push([r, c, r + 1, c + 1])
  return { id, name, cols, rows, cells }
}

/** TradingView's layouts, grouped by chart count. */
export const LAYOUTS: LayoutDef[] = [
  grid('1', '1 chart', 1, 1),
  grid('2v', '2 charts, side by side', 2, 1),
  grid('2h', '2 charts, one above the other', 1, 2),
  grid('3v', '3 charts in columns', 3, 1),
  grid('3h', '3 charts in rows', 1, 3),
  {
    id: '3l',
    name: '1 large on the left, 2 on the right',
    cols: 2,
    rows: 2,
    cells: [
      [1, 1, 3, 2],
      [1, 2, 2, 3],
      [2, 2, 3, 3],
    ],
  },
  {
    id: '3t',
    name: '1 large on top, 2 below',
    cols: 2,
    rows: 2,
    cells: [
      [1, 1, 2, 3],
      [2, 1, 3, 2],
      [2, 2, 3, 3],
    ],
  },
  grid('4', '4 charts in a grid', 2, 2),
  grid('4v', '4 charts in columns', 4, 1),
  grid('4h', '4 charts in rows', 1, 4),
  grid('6', '6 charts', 3, 2),
  grid('8', '8 charts', 4, 2),
]

export const LAYOUT_BY_ID = new Map(LAYOUTS.map((l) => [l.id, l]))
