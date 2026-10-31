import { describe, expect, it } from 'vitest'
import type { IndicatorInstance } from '../indicators/types'
import { reordered } from './PhoneIndicators'

const inst = (id: string): IndicatorInstance => ({ id, type: 'rsi', inputs: {}, styles: {}, hidden: false })
const ids = (list: IndicatorInstance[]) => list.map((i) => i.id)

describe('the tiles dragged into a new order', () => {
  it('puts the tiles in their new order and leaves the rest where they were', () => {
    // a, c and e are tiles; the overlays b and d keep their places between them.
    const list = ['a', 'b', 'c', 'd', 'e'].map(inst)
    expect(ids(reordered(list, ['e', 'a', 'c']))).toEqual(['e', 'b', 'a', 'd', 'c'])
    expect(ids(reordered(list, ['a', 'c', 'e']))).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('skips an id the list no longer has, and keeps one the order did not name', () => {
    const list = ['a', 'b', 'c'].map(inst)
    expect(ids(reordered(list, ['c', 'gone', 'a']))).toEqual(['c', 'b', 'a'])
    expect(reordered(list, ['c', 'a'])[1]).toBe(list[1])
  })
})
