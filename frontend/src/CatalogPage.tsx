import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { BarcodeIcon, BoxIcon, JarIcon, MoonIcon, SunIcon, TagIcon } from './LoginPage'
import './CatalogPage.css'

type Theme = 'light' | 'dark'

// Draft mock -- there is no /api/items-with-filters backend yet, so this
// page works entirely off a hardcoded list to give a sense of the catalog
// screen's shape (sidebar sort/category/filter, view modes, item cards,
// search) before any real data layer exists. Layout follows the wireframe:
// top bar (menu, logo, search) + left sidebar (sort/categories/filters,
// view switcher) + main item grid.
//
// Category and location are deliberately separate, per the data model in
// docs/scanning-grammar.md: category classifies WHAT a thing is (its own
// hierarchy there, e.g. "Крепёж -> Винт -> М2"), independent of WHERE it
// physically lives. Bins don't have a category at all there -- location is
// a property of the bin (and, here, the item filling it), never the item's
// classification. Location is modelled the same shape as category's own
// path -- an ordered array of segments of any depth ("Ванная" alone, or
// "Ванная:Левый шкаф:Нижняя дверца:Верхняя полка") -- joined with ":" to
// match the format the room path was requested in.

type SortKey = 'name' | 'qty' | 'location'
type FilterKey = 'all' | 'low' | 'high'
type ViewMode = 'grid' | 'list' | 'large'

// Categories form a tree of any depth ("Монтажное › Электрика ›
// Освещение"), stored as an adjacency list like the backend's
// categories.parent_id. An item can sit in several categories at once;
// the first is its primary one and decides the card's color.
type CategoryNode = {
  id: string
  name: string
  parentId: string | null
}

type CategoryIndex = Map<string, CategoryNode>

type CatalogItem = {
  id: number
  name: string
  categoryIds: string[]
  location: string[]
  qty: number
  barcode: string
  tags: string[]
  // Fallback glyph for the photo slot when there's no photo or it fails to
  // load.
  icon: keyof typeof ITEM_ICONS
  // Unsplash photo id (the part after "photo-" in images.unsplash.com
  // URLs). Stock placeholders for the draft -- real items will carry their
  // own photos.
  photo?: string
}

const ITEM_ICONS = {
  box: BoxIcon,
  tag: TagIcon,
  jar: JarIcon,
  barcode: BarcodeIcon,
}

// A category (like a tag) only ever comes into being from an item's card
// -- there's no standalone "manage categories" screen. This is the seed
// tree; the detail card can add to it.
const SEED_CATEGORIES: CategoryNode[] = [
  { id: 'med', name: 'Лекарства', parentId: null },
  { id: 'med-first-aid', name: 'Первая помощь', parentId: 'med' },
  { id: 'solder', name: 'Пайка', parentId: null },
  { id: 'mount', name: 'Монтажное', parentId: null },
  { id: 'mount-electric', name: 'Электрика', parentId: 'mount' },
  { id: 'mount-light', name: 'Освещение', parentId: 'mount-electric' },
  { id: 'mount-fasteners', name: 'Крепёж', parentId: 'mount' },
  { id: 'drone', name: 'Дроновое', parentId: null },
  { id: 'drone-power', name: 'Питание', parentId: 'drone' },
  { id: 'food', name: 'Еда', parentId: null },
  { id: 'food-canned', name: 'Консервы', parentId: 'food' },
  { id: 'food-grains', name: 'Крупы', parentId: 'food' },
  { id: 'hygiene', name: 'Гигиена', parentId: null },
  { id: 'hygiene-chem', name: 'Бытовая химия', parentId: 'hygiene' },
  { id: 'hygiene-textile', name: 'Текстиль', parentId: 'hygiene' },
  { id: 'auto', name: 'Авто', parentId: null },
  { id: 'auto-tires', name: 'Шины', parentId: 'auto' },
  { id: 'auto-chem', name: 'Автохимия', parentId: 'auto' },
  { id: 'auto-accessories', name: 'Аксессуары', parentId: 'auto' },
  { id: 'misc', name: 'Разное', parentId: null },
]

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'По названию' },
  { key: 'qty', label: 'По количеству' },
  { key: 'location', label: 'По местоположению' },
]

const LOW_STOCK_MAX = 2
const HIGH_STOCK_MIN = 5

const STOCK_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Любой остаток' },
  { key: 'low', label: `Мало (≤ ${LOW_STOCK_MAX} шт.)` },
  { key: 'high', label: `Много (> ${HIGH_STOCK_MIN} шт.)` },
]

// There's no per-item "normal stock" figure yet, so the meter is a fixed
// scale: one segment per unit, full at this many.
const STOCK_METER_SEGMENTS = 8

// One muted hue per top-level category (a whole branch shares it), picked
// to sit well on both themes' warm surfaces. Used for fills (spine, meter,
// tints), never as text color.
const CATEGORY_HUES: Record<string, string> = {
  med: '#df7a6c',
  solder: '#c27ab8',
  mount: '#d9a24e',
  drone: '#a484d8',
  food: '#8fb35a',
  hygiene: '#4fb0a5',
  auto: '#6f95d6',
  misc: '#9a8f80',
}

const UNCATEGORIZED_HUE = '#9a8f80'

// Top-level categories created from a card, and tags, get a stable hue
// from their name. Wide enough that a handful of tags on one item rarely
// share a color.
const FALLBACK_HUES = [
  '#d98a5a',
  '#5fa3c9',
  '#b7a24a',
  '#8b9bd9',
  '#c97f95',
  '#6fb58a',
  '#e0b85c',
  '#9c7fd0',
  '#58b6b0',
  '#d4736f',
  '#8fae4f',
  '#c98ac2',
]

function hashHue(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length]
}

// Root first, `id` last.
function categoryChain(index: CategoryIndex, id: string): CategoryNode[] {
  const chain: CategoryNode[] = []
  for (let node = index.get(id); node; node = node.parentId ? index.get(node.parentId) : undefined) {
    chain.unshift(node)
  }
  return chain
}

function categoryPathLabel(index: CategoryIndex, id: string): string {
  return categoryChain(index, id)
    .map((node) => node.name)
    .join(' › ')
}

function categoryRootHue(index: CategoryIndex, id: string): string {
  const root = categoryChain(index, id)[0]
  if (!root) return UNCATEGORIZED_HUE
  return CATEGORY_HUES[root.id] ?? hashHue(root.name)
}

// What a card shows as "the" category: the primary (first) one's own name,
// with its full path in the tooltip.
function primaryCategory(index: CategoryIndex, item: CatalogItem): { name: string; path: string; hue: string } | null {
  const id = item.categoryIds.find((c) => index.has(c))
  if (!id) return null
  return { name: index.get(id)!.name, path: categoryPathLabel(index, id), hue: categoryRootHue(index, id) }
}

function categoryStyle(index: CategoryIndex, item: CatalogItem): CSSProperties {
  return { '--cat': primaryCategory(index, item)?.hue ?? UNCATEGORIZED_HUE } as CSSProperties
}

// Cards read the category tree from here rather than having it threaded
// through every view's props.
const CategoryIndexContext = createContext<CategoryIndex>(new Map())

function photoUrl(id: string, width: number): string {
  return `https://images.unsplash.com/photo-${id}?w=${width}&q=70&auto=format&fit=crop`
}

const ITEMS: CatalogItem[] = [
  { id: 1, name: 'Консервированные томаты', categoryIds: ['food-canned'], location: ['Кухня', 'Кухонный шкаф', 'Полка 2'], qty: 6, barcode: '4607123456781', tags: ['консервы', 'еда'], icon: 'jar', photo: '1612204103209-fb81a3384c78' },
  { id: 2, name: 'Туалетная бумага', categoryIds: ['hygiene'], location: ['Ванная', 'Левый шкаф', 'Нижняя дверца', 'Верхняя полка'], qty: 12, barcode: '4607123456798', tags: ['гигиена', 'расходники'], icon: 'box', photo: '1584556812952-905ffd0c611a' },
  { id: 3, name: 'Аптечка первой помощи', categoryIds: ['med-first-aid'], location: ['Прихожая', 'Верхняя полка'], qty: 1, barcode: '4607123456804', tags: ['медицина', 'экстренное'], icon: 'box', photo: '1563260324-5ebeedc8af7c' },
  { id: 4, name: 'Зимняя резина, комплект', categoryIds: ['auto-tires'], location: ['Гараж', 'Стеллаж A'], qty: 4, barcode: '4607123456811', tags: ['шины', 'сезонное'], icon: 'tag', photo: '1571335746824-742511d49bce' },
  { id: 5, name: 'Крупа гречневая', categoryIds: ['food-grains'], location: ['Кухня', 'Кладовая', 'Полка 1'], qty: 3, barcode: '4607123456828', tags: ['крупы', 'еда'], icon: 'jar', photo: '1719060038791-012d4a471d91' },
  { id: 6, name: 'Лампочки LED E27', categoryIds: ['mount-light'], location: ['Кладовая', 'Ящик 3'], qty: 8, barcode: '4607123456835', tags: ['электрика', 'освещение'], icon: 'box', photo: '1552862750-746b8f6f7f25' },
  { id: 7, name: 'Моторное масло 5W-30', categoryIds: ['auto-chem'], location: ['Гараж', 'Стеллаж B'], qty: 2, barcode: '4607123456842', tags: ['автохимия', 'жидкости'], icon: 'jar', photo: '1590227763209-821c686b932f' },
  { id: 8, name: 'Стиральный порошок', categoryIds: ['hygiene-chem'], location: ['Балкон', 'Шкаф'], qty: 1, barcode: '4607123456859', tags: ['гигиена', 'стирка'], icon: 'box', photo: '1582735689369-4fe89db7114c' },
  { id: 9, name: 'Батарейки АА', categoryIds: ['drone-power', 'mount-electric'], location: ['Кухня', 'Ящик стола'], qty: 16, barcode: '4607123456866', tags: ['электрика', 'расходники'], icon: 'tag', photo: '1576834975354-ee694be1f0d1' },
  { id: 10, name: 'Консервы тунец', categoryIds: ['food-canned'], location: ['Кладовая', 'Полка 2'], qty: 5, barcode: '4607123456873', tags: ['консервы', 'еда'], icon: 'jar', photo: '1590769383363-5681e57ff10f' },
  { id: 11, name: 'Автомобильные щётки', categoryIds: ['auto-accessories'], location: ['Гараж', 'Стеллаж A'], qty: 2, barcode: '4607123456880', tags: ['уход', 'автохимия'], icon: 'tag', photo: '1508786250378-b165238d6e8b' },
  { id: 12, name: 'Полотенца банные', categoryIds: ['hygiene-textile'], location: ['Ванная', 'Верхняя полка'], qty: 4, barcode: '4607123456897', tags: ['текстиль', 'гигиена'], icon: 'box', photo: '1523471826770-c437b4636fe6' },
]

function locationPath(item: CatalogItem): string {
  return item.location.join(':')
}

// The bin/cell itself (the path's last segment) is what you need at a
// glance; cards emphasize it and let the parent rooms/shelves truncate
// first. The full path is always in the native title tooltip.
function locationCell(item: CatalogItem): string {
  return item.location[item.location.length - 1] ?? ''
}

function locationParents(item: CatalogItem): string {
  return item.location.slice(0, -1).join(' › ')
}

// ---------- EAN-13 ----------
//
// Draws the item's actual barcode (scannable when the check digit is
// valid) instead of a decorative stripe pattern -- this is a barcode-
// driven inventory, so the label should carry the real thing.

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

// 95 modules: guard, 6 left digits, center guard, 6 right digits, guard.
// The first digit isn't drawn; it's encoded in the left half's L/G parity.
function ean13Modules(code: string): string | null {
  if (!/^\d{13}$/.test(code)) return null
  const d = [...code].map(Number)
  const parity = EAN_PARITY[d[0]]
  let bits = '101'
  for (let i = 1; i <= 6; i++) bits += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[d[i]]
  bits += '01010'
  for (let i = 7; i <= 12; i++) bits += EAN_R[d[i]]
  return bits + '101'
}

const EAN_GUARD_MODULES = new Set([0, 1, 2, 45, 46, 47, 48, 49, 92, 93, 94])

// Adjacent dark modules merged into one bar each -- fewer nodes, and no
// hairline seams between them when the SVG is scaled to a fractional
// width. Guards never merge with digit bars (every digit pattern starts
// or ends with a light module next to a guard).
function barcodeBars(bits: string): { x: number; w: number; guard: boolean }[] {
  const bars = []
  for (let i = 0; i < bits.length; ) {
    if (bits[i] !== '1') {
      i++
      continue
    }
    let j = i
    while (bits[j] === '1') j++
    bars.push({ x: i, w: j - i, guard: EAN_GUARD_MODULES.has(i) })
    i = j
  }
  return bars
}

function Barcode({ value }: { value: string }) {
  const bits = ean13Modules(value)
  return (
    <div className="barcode">
      {bits && (
        <svg viewBox="0 0 95 30" preserveAspectRatio="none" shapeRendering="crispEdges" aria-hidden="true">
          {barcodeBars(bits).map((bar) => (
            <rect key={bar.x} x={bar.x} y={0} width={bar.w} height={bar.guard ? 30 : 26} />
          ))}
        </svg>
      )}
      <span className="barcode-digits">{value}</span>
    </div>
  )
}

// ---------- search: prefix parsing + fuzzy matching ----------
//
// Real (if simple) matching rather than a plain .includes(): exact ->
// prefix -> substring -> ordered-subsequence fuzzy, each tier scored so
// results can be ranked instead of just included/excluded. `#tags:`,
// `#cat`/`#categ`/`#category` and `#barcode`/`#bc` restrict which field is
// searched; anything else searches name/category/location/tags/barcode
// together.

type SearchField = 'all' | 'tags' | 'category' | 'barcode'

function parseSearch(raw: string): { field: SearchField; text: string } {
  const trimmed = raw.trim()
  const prefixMatch = trimmed.match(/^#(tags?|category|categ|cat|barcode|bc)\b:?\s*/i)
  if (!prefixMatch) return { field: 'all', text: trimmed }
  const word = prefixMatch[1].toLowerCase()
  const text = trimmed.slice(prefixMatch[0].length).trim()
  if (word.startsWith('tag')) return { field: 'tags', text }
  if (word === 'bc' || word === 'barcode') return { field: 'barcode', text }
  return { field: 'category', text }
}

// -1 means "no match". Otherwise higher is better: exact match beats a
// prefix match, beats a substring match, beats an ordered-subsequence
// fuzzy match (favoring runs of consecutive characters over scattered
// ones, like most fuzzy-finders). The scattered-subsequence tier only
// kicks in for queries of 4+ chars -- below that, almost any short string
// is a "subsequence" of almost any long one (e.g. "апт" is technically
// found, wildly scattered, inside "...резинА, комПлекТ"), which is noise
// rather than a real abbreviation match. Short queries fall back to just
// substring matching, which is exact enough to be trustworthy on its own.
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  if (t === q) return 1000
  if (t.startsWith(q)) return 800 - (t.length - q.length)
  const idx = t.indexOf(q)
  if (idx !== -1) return 600 - idx
  if (q.length < 4) return -1

  let qi = 0
  let score = 0
  let lastMatch = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastMatch === ti - 1 ? 5 : 2
      lastMatch = ti
      qi++
    }
  }
  return qi === q.length ? score : -1
}

function boost(score: number, amount: number): number {
  return score === -1 ? -1 : score + amount
}

// Every level of every category the item is in -- "#cat: авто" should
// find an item filed under "Авто › Шины".
function itemCategoryNames(index: CategoryIndex, item: CatalogItem): string[] {
  return [...new Set(item.categoryIds.flatMap((id) => categoryChain(index, id).map((node) => node.name)))]
}

function scoreItem(item: CatalogItem, field: SearchField, text: string, index: CategoryIndex): number {
  if (!text) return 0
  const categoryScore = () =>
    itemCategoryNames(index, item).reduce((best, name) => Math.max(best, fuzzyScore(text, name)), -1)
  if (field === 'tags') {
    return item.tags.reduce((best, tag) => Math.max(best, fuzzyScore(text, tag)), -1)
  }
  if (field === 'category') {
    return categoryScore()
  }
  if (field === 'barcode') {
    return fuzzyScore(text, item.barcode)
  }
  const candidates = [
    boost(fuzzyScore(text, item.name), 300),
    item.barcode.includes(text) ? 250 : -1,
    categoryScore(),
    boost(fuzzyScore(text, locationPath(item)), -50),
    ...item.tags.map((tag) => fuzzyScore(text, tag)),
  ]
  return Math.max(...candidates)
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function ListViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

function GridViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  )
}

function LargeViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <path d="M3 14h18" />
    </svg>
  )
}

// Mobile-only floating button that opens the filters bottom sheet --
// classic "two sliders" filter glyph.
function FiltersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7h6M13 7h8" />
      <circle cx="10" cy="7" r="2.3" />
      <path d="M3 17h10M17 17h4" />
      <circle cx="14" cy="17" r="2.3" />
    </svg>
  )
}

function ItemIcon({ icon }: { icon: CatalogItem['icon'] }) {
  const Icon = ITEM_ICONS[icon]
  return <Icon />
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
      <path d="M12 11v6" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

// Periodically swapped in for the search icon (see the interval in
// CatalogPage) to hint that the field doubles as a command line, not just
// item search.
function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6l6 6-6 6" />
      <path d="M17 5l-4 14" />
    </svg>
  )
}

// Photo with a category-tinted placeholder (the item's glyph) for items
// without one, or when the image fails to load (offline, removed photo).
function ItemPhoto({ item, width }: { item: CatalogItem; width: number }) {
  const [failed, setFailed] = useState(false)
  if (!item.photo || failed) {
    return (
      <span className="item-photo item-photo-placeholder">
        <ItemIcon icon={item.icon} />
      </span>
    )
  }
  return (
    <img
      className="item-photo"
      src={photoUrl(item.photo, width)}
      srcSet={`${photoUrl(item.photo, width)} 1x, ${photoUrl(item.photo, width * 2)} 2x`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  )
}

function StockMeter({ qty }: { qty: number }) {
  const filled = Math.min(qty, STOCK_METER_SEGMENTS)
  return (
    <span className="stock-meter" aria-hidden="true">
      {Array.from({ length: STOCK_METER_SEGMENTS }, (_, i) => (
        <span key={i} className={i < filled ? 'is-filled' : undefined} />
      ))}
    </span>
  )
}

function StockLine({ item }: { item: CatalogItem }) {
  return (
    <div className="stock-line" aria-label={`Остаток: ${item.qty} шт.`}>
      <StockMeter qty={item.qty} />
      <span className="stock-qty">×{item.qty}</span>
    </div>
  )
}

// "ЯЧ" label + path, with the cell itself in bold and always visible --
// the parent rooms/shelves are what give way (ellipsis) when it's long.
// `full` wraps the whole path instead of truncating it (detail card).
function CellLabel({ item, full = false }: { item: CatalogItem; full?: boolean }) {
  const parents = locationParents(item)
  return (
    <p className={`cell-label ${full ? 'cell-label-full' : ''}`} title={locationPath(item)}>
      <span className="cell-label-tag">ЯЧ</span>
      <span className="cell-label-path">
        {parents && <span className="cell-label-parents">{parents} ›&nbsp;</span>}
        <b>{locationCell(item)}</b>
      </span>
    </p>
  )
}

function isLowStock(item: CatalogItem): boolean {
  return item.qty <= LOW_STOCK_MAX
}

// The catalog's main card, styled as a warehouse tag: photo on top,
// category-colored stock meter and a big faded qty numeral in the body,
// and a tear-off stub with the item's real EAN-13 barcode. `lg` is the
// roomier variant for the large view and the search best match (adds the
// tags). At <=860px the grid view restyles this same markup into a compact
// square tile (see .view-grid in the CSS), which is what .item-tile-meta
// is for.
function ItemTagCard({ item, size = 'md' }: { item: CatalogItem; size?: 'md' | 'lg' }) {
  const index = useContext(CategoryIndexContext)
  const category = primaryCategory(index, item)
  const low = isLowStock(item)
  return (
    <article className={`tag-card tag-card-${size} ${low ? 'is-low' : ''}`} style={categoryStyle(index, item)}>
      <div className="tag-card-photo">
        <ItemPhoto item={item} width={size === 'lg' ? 520 : 360} />
        {category && (
          <span className="tag-card-category" title={category.path}>
            {category.name}
          </span>
        )}
        {low && <span className="tag-card-low">Заканчивается</span>}
      </div>
      <div className="tag-card-body">
        <span className="tag-card-watermark" aria-hidden="true">
          {item.qty}
        </span>
        <h3>{item.name}</h3>
        <CellLabel item={item} />
        <StockLine item={item} />
        {size === 'lg' && item.tags.length > 0 && (
          <div className="tag-card-tags">
            {item.tags.map((tag) => (
              <span key={tag} className="item-tag-pill">
                {tag}
              </span>
            ))}
          </div>
        )}
        <p className="item-tile-meta" title={locationPath(item)}>
          <span className="item-tile-cell">{locationCell(item)}</span>
          <span className="item-tile-sep" aria-hidden="true">
            |
          </span>
          <span className="item-tile-qty">×{item.qty}</span>
        </p>
      </div>
      <div className="tag-card-stub">
        <Barcode value={item.barcode} />
      </div>
    </article>
  )
}

// List view: the same tag language laid out as a row -- photo, name +
// category, cell and stock, then the barcode stub behind a vertical
// perforation (desktop only) and the info button.
function ItemListRow({ item, onOpenDetail }: { item: CatalogItem; onOpenDetail: (item: CatalogItem) => void }) {
  const index = useContext(CategoryIndexContext)
  const category = primaryCategory(index, item)
  const low = isLowStock(item)
  const topTags = item.tags.slice(0, 3).join(', ')
  return (
    <article className={`item-row ${low ? 'is-low' : ''}`} style={categoryStyle(index, item)}>
      <div className="item-row-photo">
        <ItemPhoto item={item} width={180} />
      </div>
      <div className="item-row-body">
        <div className="item-row-heading">
          <h3>{item.name}</h3>
          {category && (
            <span className="item-row-category" title={category.path}>
              {category.name}
            </span>
          )}
        </div>
        <CellLabel item={item} />
        <div className="item-row-stock">
          <StockLine item={item} />
          {low && <span className="item-row-low">Заканчивается</span>}
          {topTags && <span className="item-row-tags">{topTags}</span>}
        </div>
      </div>
      <div className="item-row-stub">
        <Barcode value={item.barcode} />
      </div>
      <button
        type="button"
        className="item-row-info"
        aria-label={`Подробнее: ${item.name}`}
        onClick={() => onOpenDetail(item)}
      >
        <InfoIcon />
      </button>
    </article>
  )
}

// ---------- item detail card ----------

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  )
}

const MAX_TAG_LENGTH = 32
const MAX_CATEGORY_NAME_LENGTH = 40

function normalizeTag(raw: string): string {
  return raw.replace(/^#+/, '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH)
}

// A one-shot text input for naming something new: Enter or blur with text
// submits, Escape or blur while empty cancels. Escape doesn't reach the
// modal, so it only closes this input, not the whole card. `viaKeyboard`
// tells the caller whether to put focus back on its trigger (it shouldn't
// when the input closed because the user clicked something else).
function InlineCreate({
  placeholder,
  maxLength,
  onSubmit,
  onCancel,
}: {
  placeholder: string
  maxLength: number
  onSubmit: (value: string, viaKeyboard: boolean) => void
  onCancel: (viaKeyboard: boolean) => void
}) {
  const [value, setValue] = useState('')
  // Submitting unmounts the input, and some browsers fire blur on removal
  // -- without this that would submit (or cancel) a second time.
  const doneRef = useRef(false)
  function finish(submit: boolean, viaKeyboard: boolean) {
    if (doneRef.current) return
    doneRef.current = true
    const trimmed = value.trim()
    if (submit && trimmed) onSubmit(trimmed, viaKeyboard)
    else onCancel(viaKeyboard)
  }
  return (
    <input
      className="inline-create"
      autoFocus
      value={value}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(true, true)
        } else if (e.key === 'Escape') {
          e.stopPropagation()
          finish(false, true)
        }
      }}
      onBlur={() => finish(true, false)}
    />
  )
}

// Checkbox tree of every category. Any node can be ticked (an item can sit
// in several categories, at any depth), and every level ends in a "+" row
// that creates a category right there -- a new top-level one at the root,
// a subcategory inside an expanded node. Leaves can be expanded too, just
// to reach their "+" row.
function CategoryPicker({
  categories,
  selectedIds,
  onToggle,
  onCreate,
}: {
  categories: CategoryNode[]
  selectedIds: string[]
  onToggle: (id: string) => void
  onCreate: (name: string, parentId: string | null) => void
}) {
  const index = useContext(CategoryIndexContext)
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, CategoryNode[]>()
    for (const node of categories) {
      const siblings = map.get(node.parentId) ?? []
      siblings.push(node)
      map.set(node.parentId, siblings)
    }
    return map
  }, [categories])
  // Opens onto the item's current categories.
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const open = new Set<string>()
    for (const id of selectedIds) for (const node of categoryChain(index, id).slice(0, -1)) open.add(node.id)
    return open
  })
  // Which level's "+" row is currently a text input: a node id, null for
  // the root level, undefined for none.
  const [addingTo, setAddingTo] = useState<string | null | undefined>(undefined)
  // The level whose "+" button should take focus as it reappears (after
  // the input closed from the keyboard). Consumed by the button's ref on
  // mount, so it doesn't grab focus again if it remounts later.
  const refocusAddForRef = useRef<string | null | undefined>(undefined)

  function stopAdding(parentId: string | null, viaKeyboard: boolean) {
    setAddingTo(undefined)
    if (viaKeyboard) refocusAddForRef.current = parentId
  }

  function focusIfRequested(el: HTMLButtonElement | null, parentId: string | null) {
    if (el && refocusAddForRef.current === parentId) {
      refocusAddForRef.current = undefined
      el.focus()
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderLevel(parentId: string | null, depth: number) {
    const nodes = childrenByParent.get(parentId) ?? []
    const depthStyle = { '--depth': depth } as CSSProperties
    return (
      <ul className="cat-tree-level">
        {nodes.map((node) => {
          const childCount = childrenByParent.get(node.id)?.length ?? 0
          const open = expanded.has(node.id)
          return (
            <li key={node.id}>
              <div className="cat-tree-row" style={depthStyle}>
                <button
                  type="button"
                  className={`cat-tree-toggle ${open ? 'is-open' : ''} ${childCount ? '' : 'is-leaf'}`}
                  aria-expanded={open}
                  aria-label={`${open ? 'Свернуть' : 'Развернуть'}: ${node.name}`}
                  onClick={() => toggleExpanded(node.id)}
                >
                  <ChevronIcon />
                </button>
                <label className="cat-tree-label">
                  <input type="checkbox" checked={selectedIds.includes(node.id)} onChange={() => onToggle(node.id)} />
                  {depth === 0 && (
                    <span
                      className="cat-tree-dot"
                      style={{ background: categoryRootHue(index, node.id) }}
                      aria-hidden="true"
                    />
                  )}
                  <span className="cat-tree-name">{node.name}</span>
                  {childCount > 0 && <span className="cat-tree-count">{childCount}</span>}
                </label>
              </div>
              {open && renderLevel(node.id, depth + 1)}
            </li>
          )
        })}
        <li>
          <div className="cat-tree-row" style={depthStyle}>
            {addingTo === parentId ? (
              <InlineCreate
                placeholder={parentId ? `Подкатегория в «${index.get(parentId)?.name}»` : 'Новая категория'}
                maxLength={MAX_CATEGORY_NAME_LENGTH}
                onSubmit={(name, viaKeyboard) => {
                  onCreate(name, parentId)
                  stopAdding(parentId, viaKeyboard)
                }}
                onCancel={(viaKeyboard) => stopAdding(parentId, viaKeyboard)}
              />
            ) : (
              <button
                type="button"
                className="cat-tree-add"
                ref={(el) => focusIfRequested(el, parentId)}
                onClick={() => setAddingTo(parentId)}
              >
                <PlusIcon />
                {parentId ? 'Подкатегория' : 'Новая категория'}
              </button>
            )}
          </div>
        </li>
      </ul>
    )
  }

  return <div className="cat-tree">{renderLevel(null, 0)}</div>
}

// Discord-role-style tag list: each tag is a pill with a colored dot that
// turns into a remove button on hover/focus, and a "+" at the end opens an
// input with suggestions from every tag already in use. Enter adds what's
// typed (or the highlighted suggestion) and keeps the input open for the
// next one; Enter on an empty input or Escape closes it, Backspace on an
// empty input drops the last tag.
function TagEditor({
  tags,
  knownTags,
  onChange,
}: {
  tags: string[]
  knownTags: string[]
  onChange: (tags: string[]) => void
}) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [active, setActive] = useState(-1)
  // Put focus back on "+" as it reappears after a keyboard close (see the
  // same pattern in CategoryPicker).
  const refocusAddRef = useRef(false)
  const query = normalizeTag(text)
  const suggestions = knownTags.filter((tag) => !tags.includes(tag) && (!query || tag.includes(query))).slice(0, 6)

  function add(raw: string) {
    const tag = normalizeTag(raw)
    if (tag && !tags.includes(tag)) onChange([...tags, tag])
    setText('')
    setActive(-1)
  }

  // Closing unmounts the focused input, and some browsers fire blur on
  // removal -- without this, that blur would still add whatever Escape
  // meant to discard.
  const closingRef = useRef(false)

  function open() {
    closingRef.current = false
    setAdding(true)
  }

  function close() {
    closingRef.current = true
    setAdding(false)
    setText('')
    setActive(-1)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (active < 0 && !text.trim()) {
        close()
        refocusAddRef.current = true
      } else {
        add(active >= 0 ? suggestions[active] : text)
      }
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      refocusAddRef.current = true
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, suggestions.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Backspace' && !text && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="tag-editor">
      {tags.map((tag) => (
        <span key={tag} className="tag-chip" style={{ '--tag': hashHue(tag) } as CSSProperties}>
          <button
            type="button"
            className="tag-chip-remove"
            aria-label={`Убрать тег «${tag}»`}
            onClick={() => onChange(tags.filter((t) => t !== tag))}
          >
            <CloseIcon />
          </button>
          {tag}
        </span>
      ))}
      {adding ? (
        <div className="tag-input-wrap">
          <input
            className="tag-input"
            autoFocus
            value={text}
            maxLength={MAX_TAG_LENGTH}
            placeholder="Новый тег"
            aria-label="Новый тег"
            onChange={(e) => {
              setText(e.target.value)
              setActive(-1)
            }}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (closingRef.current) return
              if (text.trim()) add(text)
              close()
            }}
          />
          {suggestions.length > 0 && (
            <ul className="tag-suggest" role="listbox" aria-label="Существующие теги">
              {suggestions.map((tag, i) => (
                <li
                  key={tag}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'is-active' : undefined}
                  // mousedown, not click: click would come after the
                  // input's blur has already closed the list.
                  onMouseDown={(e) => {
                    e.preventDefault()
                    add(tag)
                  }}
                >
                  <span className="tag-suggest-dot" style={{ background: hashHue(tag) }} aria-hidden="true" />
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="tag-add"
          aria-label="Добавить тег"
          ref={(el) => {
            if (el && refocusAddRef.current) {
              refocusAddRef.current = false
              el.focus()
            }
          }}
          onClick={open}
        >
          <PlusIcon />
        </button>
      )}
    </div>
  )
}

// What opens from a search result (or a list row's info button): the
// item's full "passport" -- photo, name, the whole cell address, qty and
// stock, categories and tags (both editable here, the only place either
// gets created), and the code on a tear-off stub like the cards'.
function ItemDetailCard({
  item,
  categories,
  knownTags,
  onChange,
  onCreateCategory,
  onClose,
}: {
  item: CatalogItem
  categories: CategoryNode[]
  knownTags: string[]
  onChange: (patch: Partial<Pick<CatalogItem, 'categoryIds' | 'tags'>>) => void
  onCreateCategory: (name: string, parentId: string | null) => string
  onClose: () => void
}) {
  const index = useContext(CategoryIndexContext)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const low = isLowStock(item)
  const itemCategoryIds = item.categoryIds.filter((id) => index.has(id))

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])

  function toggleCategory(id: string) {
    onChange({
      categoryIds: itemCategoryIds.includes(id)
        ? itemCategoryIds.filter((c) => c !== id)
        : [...itemCategoryIds, id],
    })
  }

  function createCategory(name: string, parentId: string | null) {
    const id = onCreateCategory(name, parentId)
    if (!itemCategoryIds.includes(id)) onChange({ categoryIds: [...itemCategoryIds, id] })
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(item.barcode)
      setCopied(true)
    } catch {
      // Clipboard can be unavailable (permissions, insecure origin) -- the
      // code is on screen to copy by hand either way.
    }
  }

  return (
    <div className={`detail-card ${low ? 'is-low' : ''}`} style={categoryStyle(index, item)}>
      <div className="detail-photo">
        <ItemPhoto item={item} width={640} />
        {low && <span className="tag-card-low detail-low">Заканчивается</span>}
        <button type="button" className="detail-close" onClick={onClose} aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>

      <div className="detail-body">
        <h2 className="detail-title" id="detail-title">
          {item.name}
        </h2>

        <div className="detail-facts">
          <section className="detail-fact">
            <h3 className="detail-label">Ячейка</h3>
            <CellLabel item={item} full />
          </section>
          <section className="detail-fact detail-fact-qty">
            <h3 className="detail-label">Количество</h3>
            <p className="detail-qty">
              <span className="detail-qty-num">{item.qty}</span>
              <span className="detail-qty-unit">шт.</span>
            </p>
            <StockMeter qty={item.qty} />
          </section>
        </div>

        <section className="detail-section">
          <div className="detail-section-head">
            <h3 className="detail-label">Категории</h3>
            <button
              type="button"
              className="detail-link"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
            >
              {pickerOpen ? 'Готово' : 'Изменить'}
            </button>
          </div>
          {itemCategoryIds.length > 0 ? (
            <ul className="detail-chips">
              {itemCategoryIds.map((id, i) => {
                const chain = categoryChain(index, id)
                const leaf = chain[chain.length - 1]
                return (
                  <li
                    key={id}
                    className={`category-chip ${i === 0 ? 'is-primary' : ''}`}
                    title={i === 0 ? 'Основная категория — задаёт цвет карточки' : undefined}
                  >
                    <span className="category-chip-dot" style={{ background: categoryRootHue(index, id) }} />
                    <span className="category-chip-path">
                      {chain.length > 1 && (
                        <span className="category-chip-parents">
                          {chain
                            .slice(0, -1)
                            .map((node) => node.name)
                            .join(' › ')}{' '}
                          ›{' '}
                        </span>
                      )}
                      <b>{leaf.name}</b>
                    </span>
                    <button
                      type="button"
                      className="category-chip-remove"
                      aria-label={`Убрать категорию «${leaf.name}»`}
                      onClick={() => toggleCategory(id)}
                    >
                      <CloseIcon />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="detail-empty">Без категории</p>
          )}
          {pickerOpen && (
            <CategoryPicker
              categories={categories}
              selectedIds={itemCategoryIds}
              onToggle={toggleCategory}
              onCreate={createCategory}
            />
          )}
        </section>

        <section className="detail-section">
          <h3 className="detail-label">Теги</h3>
          <TagEditor tags={item.tags} knownTags={knownTags} onChange={(tags) => onChange({ tags })} />
        </section>
      </div>

      <div className="detail-stub">
        <div className="detail-section-head">
          <h3 className="detail-label">Код</h3>
          <button type="button" className="detail-link detail-copy" onClick={copyCode}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? 'Скопировано' : 'Копировать'}
          </button>
        </div>
        <Barcode value={item.barcode} />
      </div>
    </div>
  )
}

type RadioGroupProps<T extends string> = {
  name: string
  options: { key: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

function RadioGroup<T extends string>({ name, options, value, onChange }: RadioGroupProps<T>) {
  return (
    <div className="radio-list" role="radiogroup">
      {options.map((opt) => (
        <label key={opt.key} className="radio-option">
          <input
            type="radio"
            name={name}
            checked={value === opt.key}
            onChange={() => onChange(opt.key)}
          />
          <span>{opt.label}</span>
        </label>
      ))}
    </div>
  )
}

type CatalogPageProps = {
  theme: Theme
  onToggleTheme: () => void
}

// The search/terminal icon swaps every time this elapses, so each glyph
// stays up for one full interval before flipping back -- see the effect
// in CatalogPage that drives ICON_MORPH.
const ICON_MORPH_INTERVAL_MS = 15000

// Matches .search-dropdown's own opacity/transform transition duration --
// see openDetail for why clearing the query waits this long.
const SEARCH_DROPDOWN_CLOSE_MS = 200

export default function CatalogPage({ theme, onToggleTheme }: CatalogPageProps) {
  const [query, setQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  // Desktop starts with filters open (there's room); mobile starts closed,
  // shown on demand via the floating filters button instead of an inline
  // panel (see .mobile-filters-fab / the >=861px vs <=860px CSS split).
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 860,
  )

  // Re-applies the same per-layout default as the initializer above each
  // time the window crosses the breakpoint. Desktop has no control that can
  // close the sidebar (removed by request), so without this, closing the
  // mobile sheet and then widening the window left sidebarOpen stuck at
  // false with nothing on desktop able to flip it back. The reverse
  // crossing resets to closed so the sheet doesn't pop up over the page
  // just from narrowing the window. Resizes that stay on one side of the
  // breakpoint don't fire this, so the mobile sheet's own open/closed state
  // is left alone.
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 861px)')
    function handleChange(e: MediaQueryListEvent) {
      setSidebarOpen(e.matches)
    }
    desktop.addEventListener('change', handleChange)
    return () => desktop.removeEventListener('change', handleChange)
  }, [])
  const [sort, setSort] = useState<SortKey>('name')
  // 'Все' or a top-level category's id.
  const [category, setCategory] = useState<string>('Все')
  const [stockFilter, setStockFilter] = useState<FilterKey>('all')
  const [view, setView] = useState<ViewMode>('grid')
  // Local only for now (see the draft note) -- edits from the detail card
  // live until reload.
  const [items, setItems] = useState<CatalogItem[]>(ITEMS)
  const [categories, setCategories] = useState<CategoryNode[]>(SEED_CATEGORIES)
  const categoryIndex = useMemo<CategoryIndex>(() => new Map(categories.map((c) => [c.id, c])), [categories])
  const rootCategories = useMemo(() => categories.filter((c) => c.parentId === null), [categories])
  const knownTags = useMemo(() => [...new Set(items.flatMap((item) => item.tags))].sort((a, b) => a.localeCompare(b, 'ru')), [items])
  // An id, not the item itself, so the open card reflects edits made in it.
  const [detailId, setDetailId] = useState<number | null>(null)
  const detailItem = detailId === null ? null : items.find((item) => item.id === detailId) ?? null
  const detailRef = useRef<HTMLDivElement>(null)
  const [detailClosing, setDetailClosing] = useState(false)
  const [iconMorphed, setIconMorphed] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchFocusedRef = useRef(searchFocused)
  searchFocusedRef.current = searchFocused
  const clearQueryTimeoutRef = useRef<ReturnType<typeof setTimeout>>()
  // Portaled to <body> (see the createPortal call below) and positioned
  // from this instead of plain CSS -- .catalog-search-wrap sits inside
  // several ancestors (.catalog-topbar, .catalog-topbar-right) that are
  // position:relative/static with no z-index of their own, and turned out
  // NOT to let the wrap's z-index:16 stacking context win against
  // .catalog-body's sibling content despite the numbers being right
  // (confirmed empirically -- bumping z-index arbitrarily higher didn't
  // help, only actually moving the DOM node did). Portaling sidesteps
  // needing to fully understand why and guarantees it paints on top.
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null)

  const searchActive = searchFocused

  useEffect(() => {
    if (!searchActive) return
    const wrap = searchWrapRef.current
    if (!wrap) return
    function updateRect() {
      const r = wrap!.getBoundingClientRect()
      // Same 5px overlap as before (masks the search field's own focus
      // ring at the seam instead of leaving a gap or a visible border).
      setDropdownRect({ top: r.bottom - 5, left: r.left, width: r.width })
    }
    updateRect()
    // ResizeObserver catches the wrap's own width-expand CSS transition
    // (mobile) frame by frame, not just its start/end state.
    const ro = new ResizeObserver(updateRect)
    ro.observe(wrap)
    window.addEventListener('resize', updateRect)
    window.addEventListener('scroll', updateRect, true)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateRect)
      window.removeEventListener('scroll', updateRect, true)
    }
  }, [searchActive])

  // Deliberately NOT connected to the item grid at all -- this is a
  // standalone quick-find/command-line utility (see the terminal-icon
  // morph below), not a filter control. Picking a result opens the item's
  // detail card instead of narrowing the grid underneath, and the grid's
  // own filtering/sorting only ever reads sort/category/stockFilter.
  // A top-level category in the sidebar matches every item filed anywhere
  // in its branch.
  const filtered = useMemo(() => {
    return items
      .filter((item) => {
        const matchesCategory =
          category === 'Все' || item.categoryIds.some((id) => categoryChain(categoryIndex, id)[0]?.id === category)
        const matchesStock =
          stockFilter === 'all' || (stockFilter === 'low' ? item.qty <= LOW_STOCK_MAX : item.qty > HIGH_STOCK_MIN)
        return matchesCategory && matchesStock
      })
      .sort((a, b) => {
        if (sort === 'qty') return b.qty - a.qty
        if (sort === 'location') return locationPath(a).localeCompare(locationPath(b), 'ru')
        return a.name.localeCompare(b.name, 'ru')
      })
  }, [items, categoryIndex, category, stockFilter, sort])

  const { field: searchField, text: searchText } = useMemo(() => parseSearch(query), [query])

  const searchResults = useMemo(() => {
    if (!searchText) return []
    return items
      .map((item) => ({ item, score: scoreItem(item, searchField, searchText, categoryIndex) }))
      .filter(({ score }) => score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  }, [items, categoryIndex, searchField, searchText])

  function updateItem(id: number, patch: Partial<CatalogItem>) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  // Reuses an existing sibling with the same name (case-insensitive)
  // instead of creating a duplicate next to it.
  function createCategory(name: string, parentId: string | null): string {
    const existing = categories.find(
      (c) => c.parentId === parentId && c.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'),
    )
    if (existing) return existing.id
    const node: CategoryNode = { id: crypto.randomUUID(), name, parentId }
    setCategories((prev) => [...prev, node])
    return node.id
  }

  const bestMatch = searchResults[0]?.item
  const restResults = searchResults.slice(1)

  // Every 15s, swap the search icon for a ">/" glyph, then swap back 15s
  // later -- each stays up for a full interval rather than a brief flash,
  // so there's actually time to register it doubles as a command line, not
  // just item search. Skipped while the field is focused (distracting
  // mid-interaction, and pointless since the user is already looking right
  // at it) -- the swap due while focused is simply skipped, not queued, so
  // it picks back up on the regular 15s cadence once the field blurs.
  useEffect(() => {
    const interval = setInterval(() => {
      if (searchFocusedRef.current) return
      setIconMorphed((v) => !v)
    }, ICON_MORPH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    return () => {
      if (clearQueryTimeoutRef.current) clearTimeout(clearQueryTimeoutRef.current)
    }
  }, [])

  function closeSearch() {
    setSearchFocused(false)
    searchInputRef.current?.blur()
  }

  // Opening a result is the only thing that "selects" a search -- it
  // shows the item's detail card and resets the command line, same as
  // running a command clears the prompt. The query is cleared only after
  // the dropdown has finished fading out (closeSearch fires first), not
  // in the same instant -- clearing it immediately switched the still-
  // visible dropdown's content to the empty-query hint (prefix commands
  // and all) for the length of its own closing fade, flashing that in
  // place of the results the user actually just clicked.
  function openDetail(item: CatalogItem) {
    setDetailClosing(false)
    setDetailId(item.id)
    closeSearch()
    if (clearQueryTimeoutRef.current) clearTimeout(clearQueryTimeoutRef.current)
    clearQueryTimeoutRef.current = setTimeout(() => setQuery(''), SEARCH_DROPDOWN_CLOSE_MS)
  }

  function closeDetail() {
    setDetailClosing(true)
  }

  useEffect(() => {
    if (!detailClosing) return
    const t = setTimeout(() => {
      setDetailId(null)
      setDetailClosing(false)
    }, 220)
    return () => clearTimeout(t)
  }, [detailClosing])

  // Focus moves into the card so Tab starts from inside it.
  useEffect(() => {
    if (detailId !== null) detailRef.current?.focus()
  }, [detailId])

  // Escape closes the card wherever focus happens to be (including on the
  // page behind it, once an inner input has closed and dropped focus).
  // Inputs inside the card that use Escape themselves stop its
  // propagation, so this only fires when nothing inside claimed it.
  useEffect(() => {
    if (detailId === null) return
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setDetailClosing(true)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [detailId])

  function handleSearchWrapBlur(e: FocusEvent<HTMLDivElement>) {
    const related = e.relatedTarget as Node | null
    // The dropdown is portaled to <body> (see dropdownRect above), so it's
    // no longer a DOM descendant of the wrap -- e.currentTarget.contains()
    // alone would say focus left even when it just moved from the input
    // to a result row, closing the dropdown out from under a keyboard
    // (Tab) user before their selection could register.
    if (e.currentTarget.contains(related) || dropdownRef.current?.contains(related)) return
    setSearchFocused(false)
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (bestMatch) openDetail(bestMatch)
      else closeSearch()
    } else if (e.key === 'Escape') {
      closeSearch()
    }
  }

  function handleResultKeyDown(e: KeyboardEvent<HTMLElement>, item: CatalogItem) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openDetail(item)
    }
  }

  return (
    <CategoryIndexContext.Provider value={categoryIndex}>
      <div className="catalog-page">
        <p className="catalog-draft-note">Черновой макет — данные не сохраняются, каталог не подключён к бэкенду</p>

        <header className={`catalog-topbar ${searchActive ? 'search-active' : ''}`}>
          {/* Fixed-width left zone (menu + brand) so its right edge lands on
           * the same x as .catalog-body's sidebar/main divider below --
           * see .catalog-topbar-left in CatalogPage.css. Purely visual
           * symmetry, not an actual layout dependency between the two. On
           * narrow screens this zone (specifically the brand) collapses away
           * while search is active instead, to give the search field room. */}
          <div className="catalog-topbar-left">
            <button type="button" className="icon-btn menu-btn" aria-label="Меню">
              <MenuIcon />
            </button>

            <div className="catalog-brand">
              <span className="catalog-brand-word">Storegizer</span>
              <span className="catalog-brand-tab">каталог</span>
            </div>
          </div>

          <div className="catalog-topbar-right">
            <div className="catalog-search-wrap" ref={searchWrapRef} onBlur={handleSearchWrapBlur}>
              <label className={`catalog-search ${searchActive ? 'is-open' : ''}`}>
                <span className="catalog-search-icon">
                  <span className={`search-icon-face ${!iconMorphed ? 'is-visible' : ''}`}>
                    <SearchIcon />
                  </span>
                  <span className={`search-icon-face ${iconMorphed ? 'is-visible' : ''}`}>
                    <TerminalIcon />
                  </span>
                </span>
                <input
                  ref={searchInputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onFocus={() => setSearchFocused(true)}
                  onKeyDown={handleSearchKeyDown}
                  // Short on purpose -- text-overflow:ellipsis doesn't
                  // reliably engage for an <input>'s placeholder/value in
                  // every engine (it didn't here), so a placeholder long
                  // enough to need truncating on a narrow mobile field just
                  // got hard-clipped mid-word instead. The fuller
                  // explanation (prefixes etc.) lives in the dropdown hint
                  // once focused, not the placeholder itself.
                  placeholder="Найти или команда..."
                  type="search"
                />
              </label>

              {createPortal(
                <div
                  className={`search-dropdown ${searchActive ? 'is-open' : ''}`}
                  ref={dropdownRef}
                  style={
                    dropdownRect
                      ? { top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width }
                      : undefined
                  }
                >
                {!searchText ? (
                  <div className="search-hint">
                    <p>
                      Универсальная строка поиска — по названию, категории, месту, тегам и штрихкоду.
                      Не связана со списком ниже: Enter или клик по результату открывает карточку предмета.
                    </p>
                    <ul>
                      <li>
                        <code>#tags: значение</code> — искать только по тегам
                      </li>
                      <li>
                        <code>#cat: значение</code> — искать только по категории
                      </li>
                      <li>
                        <code>#barcode: значение</code> — искать только по штрихкоду
                      </li>
                    </ul>
                  </div>
                ) : bestMatch ? (
                  <>
                    <div className="search-section-label">Лучшее совпадение</div>
                    <button type="button" className="search-best-match" onClick={() => openDetail(bestMatch)}>
                      <ItemTagCard item={bestMatch} size="lg" />
                    </button>
                    {restResults.length > 0 && (
                      <>
                        <div className="search-section-label">Ещё найдено</div>
                        <ul className="search-result-list">
                          {restResults.map(({ item }) => (
                            <li
                              key={item.id}
                              className="search-result-row"
                              role="button"
                              tabIndex={0}
                              onClick={() => openDetail(item)}
                              onKeyDown={(e) => handleResultKeyDown(e, item)}
                            >
                              <span className="search-result-icon" style={categoryStyle(categoryIndex, item)}>
                                <ItemPhoto item={item} width={64} />
                              </span>
                              <span className="search-result-name">{item.name}</span>
                              <span className="search-result-meta">{primaryCategory(categoryIndex, item)?.name}</span>
                              <span className="item-qty">×{item.qty}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                ) : (
                  <p className="search-empty">Совпадений не найдено.</p>
                )}
                </div>,
                document.body,
              )}
            </div>

            <button
              type="button"
              className="icon-btn theme-toggle-btn"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            >
              {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
            </button>
          </div>
        </header>

        <div className={`search-overlay ${searchActive ? 'is-open' : ''}`} onClick={closeSearch} />

        <div className={`catalog-body ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
          <aside className="catalog-sidebar">
            {/* Fixed-width inner box -- the outer <aside> is what actually
             * animates (width on desktop, height on mobile) and clips this
             * with overflow:hidden, so the panel is revealed/hidden like a
             * wipe instead of its own contents (radio labels etc.) visibly
             * reflowing to a narrower width mid-transition. */}
            <div className="catalog-sidebar-inner">
              <div className="sidebar-section">
                <h2>Сортировка</h2>
                <RadioGroup name="sort" options={SORTS} value={sort} onChange={setSort} />
              </div>

              <div className="sidebar-section">
                <h2>Категории</h2>
                <RadioGroup
                  name="category"
                  options={[{ key: 'Все', label: 'Все' }, ...rootCategories.map((c) => ({ key: c.id, label: c.name }))]}
                  value={category}
                  onChange={setCategory}
                />
              </div>

              <div className="sidebar-section">
                <h2>Фильтры</h2>
                <RadioGroup name="stock" options={STOCK_FILTERS} value={stockFilter} onChange={setStockFilter} />
              </div>
            </div>
          </aside>

          <main className="catalog-main">
            <div className="catalog-main-toolbar">
              <span className="catalog-count">{filtered.length} предметов</span>

              <div className="view-switch" role="radiogroup" aria-label="Вид отображения">
                <button
                  type="button"
                  className={view === 'list' ? 'active' : ''}
                  aria-pressed={view === 'list'}
                  aria-label="Список"
                  onClick={() => setView('list')}
                >
                  <ListViewIcon />
                </button>
                <button
                  type="button"
                  className={view === 'grid' ? 'active' : ''}
                  aria-pressed={view === 'grid'}
                  aria-label="Сетка"
                  onClick={() => setView('grid')}
                >
                  <GridViewIcon />
                </button>
                <button
                  type="button"
                  className={view === 'large' ? 'active' : ''}
                  aria-pressed={view === 'large'}
                  aria-label="Крупные карточки"
                  onClick={() => setView('large')}
                >
                  <LargeViewIcon />
                </button>
              </div>
            </div>

            <div className="catalog-scroll">
              {filtered.length === 0 ? (
                <p className="catalog-empty">Ничего не найдено — попробуйте другой запрос или фильтр.</p>
              ) : (
                <div key={view} className={`catalog-items view-${view}`}>
                  {filtered.map((item) => {
                    if (view === 'large') return <ItemTagCard key={item.id} item={item} size="lg" />
                    if (view === 'list') return <ItemListRow key={item.id} item={item} onOpenDetail={openDetail} />
                    return <ItemTagCard key={item.id} item={item} />
                  })}
                </div>
              )}
            </div>
          </main>
        </div>

        {/* Mobile only (see the <=860px CSS): the inline collapsible sidebar
         * becomes a bottom sheet instead, opened via this floating button
         * rather than the desktop's divider-straddling chevron. */}
        <button
          type="button"
          className="mobile-filters-fab"
          aria-label={sidebarOpen ? 'Скрыть фильтры' : 'Показать фильтры'}
          aria-pressed={sidebarOpen}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <FiltersIcon />
        </button>

        <div
          className={`mobile-filters-overlay ${sidebarOpen ? 'is-open' : ''}`}
          onClick={() => setSidebarOpen(false)}
        />

        {detailItem && (
          <div
            className={`item-detail-overlay ${detailClosing ? 'is-closing' : ''}`}
            onClick={closeDetail}
          >
            <div
              ref={detailRef}
              className={`item-detail-modal ${detailClosing ? 'is-closing' : ''}`}
              role="dialog"
              aria-modal="true"
              aria-labelledby="detail-title"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
            >
              <ItemDetailCard
                item={detailItem}
                categories={categories}
                knownTags={knownTags}
                onChange={(patch) => updateItem(detailItem.id, patch)}
                onCreateCategory={createCategory}
                onClose={closeDetail}
              />
            </div>
          </div>
        )}
      </div>
    </CategoryIndexContext.Provider>
  )
}
