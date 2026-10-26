import { useEffect, useState } from 'react'
import { FALLBACK_NAMES, fetchCurrencyNames, fetchProducts, productFromId } from './coinbase'
import type { Product } from './types'

export interface Catalog {
  products: Product[]
  byId: Map<string, Product>
  names: Record<string, string>
}

let cached: Promise<Catalog> | null = null

function loadCatalog(): Promise<Catalog> {
  cached ??= Promise.all([fetchProducts(), fetchCurrencyNames().catch(() => FALLBACK_NAMES)]).then(
    ([products, names]) => ({ products, byId: new Map(products.map((p) => [p.id, p])), names }),
  )
  cached.catch(() => (cached = null))
  return cached
}

const EMPTY: Catalog = { products: [], byId: new Map(), names: FALLBACK_NAMES }

/** Every tradable Coinbase product, with currency names. Empty until it loads. */
export function useCatalog(): Catalog {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY)
  useEffect(() => {
    let alive = true
    loadCatalog()
      .then((c) => alive && setCatalog(c))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return catalog
}

export function getProduct(catalog: Catalog, id: string): Product {
  return catalog.byId.get(id) ?? productFromId(id)
}

/** "Bitcoin / U.S. Dollar" */
export function describe(catalog: Catalog, p: Product): string {
  return `${catalog.names[p.base] ?? p.base} / ${catalog.names[p.quote] ?? p.quote}`
}
