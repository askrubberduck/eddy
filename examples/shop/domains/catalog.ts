import { defineDomain, reduce, view } from '../../../src/index'
import type { DomainType, Reduce } from '../../../src/index'

export type Product = {
  sku: string
  title: string

  price: number
  tags: string[]
}

export type CatalogState = {
  products: Product[]
  query: string
  selectedSku: string | null
}

export type CatalogViews = {
  visible: Product[]
  selected: Product | null

  cheapestVisible: Product | null
}

export type CatalogActions = {
  setQuery: Reduce<{ text: string }>
  select: Reduce<{ sku: string | null }>
  reprice: Reduce<{ sku: string; price: number }>
}

declare module '../../../src/types' {
  interface Domains {
    catalog: DomainType<CatalogState, CatalogActions, CatalogViews>
  }
}

const SEED: Product[] = [
  { sku: 'mug-white', title: 'White mug', price: 900, tags: ['kitchen'] },
  { sku: 'mug-black', title: 'Black mug', price: 1100, tags: ['kitchen'] },
  { sku: 'lamp-noir', title: 'Noir lamp', price: 4900, tags: ['lighting'] },
  { sku: 'rug-jute', title: 'Jute rug', price: 7500, tags: ['floor'] },
]

export const catalog = defineDomain('catalog', [], {
  state: () => ({
    products: SEED.map(product => ({ ...product, tags: [...product.tags] })),
    query: '',
    selectedSku: null,
  }),

  actions: {
    setQuery: reduce((_state, action) => ({ query: action.input.text })),

    select: reduce((_state, action) => ({ selectedSku: action.input.sku })),

    reprice: reduce((state, action) => ({
      products: state.products.map(product =>
        product.sku === action.input.sku ? { ...product, price: action.input.price } : product,
      ),
    })),
  },

  views: {
    visible: view(
      state => ({ products: state.products, query: state.query.trim().toLowerCase() }),
      ({ products, query }) =>
        query === ''
          ? products
          : products.filter(
              product => product.title.toLowerCase().includes(query) || product.tags.some(tag => tag.includes(query)),
            ),
    ),

    selected: view(
      state => ({ products: state.products, sku: state.selectedSku }),
      ({ products, sku }) => products.find(product => product.sku === sku) ?? null,
    ),

    cheapestVisible: view(
      state => state.visible,
      products =>
        products.reduce<Product | null>((best, p) => (best === null || p.price < best.price ? p : best), null),
    ),
  },
})
