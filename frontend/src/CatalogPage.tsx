import { useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react'
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

type CatalogItem = {
  id: number
  name: string
  category: string
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

// Per docs/scanning-grammar.md, a category (like a tag) only ever comes
// into being as part of creating/editing an item -- there's no standalone
// "manage categories" entry point. This page has no item-creation flow
// yet, so the list is just a fixed seed for now rather than editable here.
const CATEGORIES = ['Лекарства', 'Пайка', 'Монтажное', 'Дроновое', 'Еда', 'Гигиена', 'Авто', 'Разное']

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

// One muted hue per category, picked to sit well on both themes' warm
// surfaces. Used for fills (spine, meter, tints), never as text color.
const CATEGORY_HUES: Record<string, string> = {
  Лекарства: '#df7a6c',
  Пайка: '#c27ab8',
  Монтажное: '#d9a24e',
  Дроновое: '#a484d8',
  Еда: '#8fb35a',
  Гигиена: '#4fb0a5',
  Авто: '#6f95d6',
  Разное: '#9a8f80',
}

// Categories are created from item cards (see CATEGORIES), so new ones
// won't be in the map above -- they get a stable hue from their name.
const FALLBACK_HUES = ['#d98a5a', '#5fa3c9', '#b7a24a', '#8b9bd9', '#c97f95', '#6fb58a']

function categoryHue(category: string): string {
  const known = CATEGORY_HUES[category]
  if (known) return known
  let hash = 0
  for (const ch of category) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return FALLBACK_HUES[Math.abs(hash) % FALLBACK_HUES.length]
}

function categoryStyle(item: CatalogItem): CSSProperties {
  return { '--cat': categoryHue(item.category) } as CSSProperties
}

function photoUrl(id: string, width: number): string {
  return `https://images.unsplash.com/photo-${id}?w=${width}&q=70&auto=format&fit=crop`
}

const ITEMS: CatalogItem[] = [
  { id: 1, name: 'Консервированные томаты', category: 'Еда', location: ['Кухня', 'Кухонный шкаф', 'Полка 2'], qty: 6, barcode: '4607123456781', tags: ['консервы', 'еда'], icon: 'jar', photo: '1612204103209-fb81a3384c78' },
  { id: 2, name: 'Туалетная бумага', category: 'Гигиена', location: ['Ванная', 'Левый шкаф', 'Нижняя дверца', 'Верхняя полка'], qty: 12, barcode: '4607123456798', tags: ['гигиена', 'расходники'], icon: 'box', photo: '1584556812952-905ffd0c611a' },
  { id: 3, name: 'Аптечка первой помощи', category: 'Лекарства', location: ['Прихожая', 'Верхняя полка'], qty: 1, barcode: '4607123456804', tags: ['медицина', 'экстренное'], icon: 'box', photo: '1563260324-5ebeedc8af7c' },
  { id: 4, name: 'Зимняя резина, комплект', category: 'Авто', location: ['Гараж', 'Стеллаж A'], qty: 4, barcode: '4607123456811', tags: ['шины', 'сезонное'], icon: 'tag', photo: '1571335746824-742511d49bce' },
  { id: 5, name: 'Крупа гречневая', category: 'Еда', location: ['Кухня', 'Кладовая', 'Полка 1'], qty: 3, barcode: '4607123456828', tags: ['крупы', 'еда'], icon: 'jar', photo: '1719060038791-012d4a471d91' },
  { id: 6, name: 'Лампочки LED E27', category: 'Монтажное', location: ['Кладовая', 'Ящик 3'], qty: 8, barcode: '4607123456835', tags: ['электрика', 'освещение'], icon: 'box', photo: '1552862750-746b8f6f7f25' },
  { id: 7, name: 'Моторное масло 5W-30', category: 'Авто', location: ['Гараж', 'Стеллаж B'], qty: 2, barcode: '4607123456842', tags: ['автохимия', 'жидкости'], icon: 'jar', photo: '1590227763209-821c686b932f' },
  { id: 8, name: 'Стиральный порошок', category: 'Гигиена', location: ['Балкон', 'Шкаф'], qty: 1, barcode: '4607123456859', tags: ['гигиена', 'стирка'], icon: 'box', photo: '1582735689369-4fe89db7114c' },
  { id: 9, name: 'Батарейки АА', category: 'Дроновое', location: ['Кухня', 'Ящик стола'], qty: 16, barcode: '4607123456866', tags: ['электрика', 'расходники'], icon: 'tag', photo: '1576834975354-ee694be1f0d1' },
  { id: 10, name: 'Консервы тунец', category: 'Еда', location: ['Кладовая', 'Полка 2'], qty: 5, barcode: '4607123456873', tags: ['консервы', 'еда'], icon: 'jar', photo: '1590769383363-5681e57ff10f' },
  { id: 11, name: 'Автомобильные щётки', category: 'Авто', location: ['Гараж', 'Стеллаж A'], qty: 2, barcode: '4607123456880', tags: ['уход', 'автохимия'], icon: 'tag', photo: '1508786250378-b165238d6e8b' },
  { id: 12, name: 'Полотенца банные', category: 'Гигиена', location: ['Ванная', 'Верхняя полка'], qty: 4, barcode: '4607123456897', tags: ['текстиль', 'гигиена'], icon: 'box', photo: '1523471826770-c437b4636fe6' },
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

function scoreItem(item: CatalogItem, field: SearchField, text: string): number {
  if (!text) return 0
  if (field === 'tags') {
    return item.tags.reduce((best, tag) => Math.max(best, fuzzyScore(text, tag)), -1)
  }
  if (field === 'category') {
    return fuzzyScore(text, item.category)
  }
  if (field === 'barcode') {
    return fuzzyScore(text, item.barcode)
  }
  const candidates = [
    boost(fuzzyScore(text, item.name), 300),
    item.barcode.includes(text) ? 250 : -1,
    fuzzyScore(text, item.category),
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
function CellLabel({ item }: { item: CatalogItem }) {
  const parents = locationParents(item)
  return (
    <p className="cell-label" title={locationPath(item)}>
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
// roomier variant for the large view, the search best match and the
// detail modal (adds the tags). At <=860px the grid view restyles this
// same markup into a compact square tile (see .view-grid in the CSS), which
// is what .item-tile-meta is for.
function ItemTagCard({ item, size = 'md' }: { item: CatalogItem; size?: 'md' | 'lg' }) {
  const low = isLowStock(item)
  return (
    <article className={`tag-card tag-card-${size} ${low ? 'is-low' : ''}`} style={categoryStyle(item)}>
      <div className="tag-card-photo">
        <ItemPhoto item={item} width={size === 'lg' ? 520 : 360} />
        <span className="tag-card-category">{item.category}</span>
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
  const low = isLowStock(item)
  const topTags = item.tags.slice(0, 3).join(', ')
  return (
    <article className={`item-row ${low ? 'is-low' : ''}`} style={categoryStyle(item)}>
      <div className="item-row-photo">
        <ItemPhoto item={item} width={180} />
      </div>
      <div className="item-row-body">
        <div className="item-row-heading">
          <h3>{item.name}</h3>
          <span className="item-row-category">{item.category}</span>
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
  const [category, setCategory] = useState<string>('Все')
  const [stockFilter, setStockFilter] = useState<FilterKey>('all')
  const [view, setView] = useState<ViewMode>('grid')
  const [detailItem, setDetailItem] = useState<CatalogItem | null>(null)
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
  const filtered = useMemo(() => {
    return ITEMS.filter((item) => {
      const matchesCategory = category === 'Все' || item.category === category
      const matchesStock =
        stockFilter === 'all' || (stockFilter === 'low' ? item.qty <= LOW_STOCK_MAX : item.qty > HIGH_STOCK_MIN)
      return matchesCategory && matchesStock
    }).sort((a, b) => {
      if (sort === 'qty') return b.qty - a.qty
      if (sort === 'location') return locationPath(a).localeCompare(locationPath(b), 'ru')
      return a.name.localeCompare(b.name, 'ru')
    })
  }, [category, stockFilter, sort])

  const { field: searchField, text: searchText } = useMemo(() => parseSearch(query), [query])

  const searchResults = useMemo(() => {
    if (!searchText) return []
    return ITEMS.map((item) => ({ item, score: scoreItem(item, searchField, searchText) }))
      .filter(({ score }) => score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  }, [searchField, searchText])

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
    setDetailItem(item)
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
      setDetailItem(null)
      setDetailClosing(false)
    }, 220)
    return () => clearTimeout(t)
  }, [detailClosing])

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
                            <span className="search-result-icon" style={categoryStyle(item)}>
                              <ItemPhoto item={item} width={64} />
                            </span>
                            <span className="search-result-name">{item.name}</span>
                            <span className="search-result-meta">{item.category}</span>
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
                options={[{ key: 'Все', label: 'Все' }, ...CATEGORIES.map((c) => ({ key: c, label: c }))]}
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
            className={`item-detail-modal ${detailClosing ? 'is-closing' : ''}`}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="item-detail-modal-header">
              <span className="search-section-label">Карточка предмета</span>
              <button type="button" className="item-detail-close" onClick={closeDetail} aria-label="Закрыть">
                <CloseIcon />
              </button>
            </div>
            <ItemTagCard item={detailItem} size="lg" />
            <p className="item-detail-note">
              Плейсхолдер — полноценная карточка предмета (редактирование, история операций и т.д.) будет
              реализована позже.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
