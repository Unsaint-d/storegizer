import { useMemo, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent } from 'react'
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
  icon: keyof typeof ITEM_ICONS
}

const ITEM_ICONS = {
  box: BoxIcon,
  tag: TagIcon,
  jar: JarIcon,
  barcode: BarcodeIcon,
}

// Seed list only -- categories can be created freely from the sidebar (see
// the add-category form below), same spirit as the admin-panel category
// creation described in docs/scanning-grammar.md (just without the
// session/rollback machinery, since this page has no backend yet).
const DEFAULT_CATEGORIES = ['Лекарства', 'Пайка', 'Монтажное', 'Дроновое', 'Еда', 'Гигиена', 'Авто', 'Разное']

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'По названию' },
  { key: 'qty', label: 'По количеству' },
  { key: 'location', label: 'По местоположению' },
]

const STOCK_FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'Любой остаток' },
  { key: 'low', label: 'Мало (≤ 2 шт.)' },
  { key: 'high', label: 'Много (> 5 шт.)' },
]

const ITEMS: CatalogItem[] = [
  { id: 1, name: 'Консервированные томаты', category: 'Еда', location: ['Кухня', 'Кухонный шкаф', 'Полка 2'], qty: 6, barcode: '4607123456781', tags: ['консервы', 'еда'], icon: 'jar' },
  { id: 2, name: 'Туалетная бумага', category: 'Гигиена', location: ['Ванная', 'Левый шкаф', 'Нижняя дверца', 'Верхняя полка'], qty: 12, barcode: '4607123456798', tags: ['гигиена', 'расходники'], icon: 'box' },
  { id: 3, name: 'Аптечка первой помощи', category: 'Лекарства', location: ['Прихожая', 'Верхняя полка'], qty: 1, barcode: '4607123456804', tags: ['медицина', 'экстренное'], icon: 'box' },
  { id: 4, name: 'Зимняя резина, комплект', category: 'Авто', location: ['Гараж', 'Стеллаж A'], qty: 4, barcode: '4607123456811', tags: ['шины', 'сезонное'], icon: 'tag' },
  { id: 5, name: 'Крупа гречневая', category: 'Еда', location: ['Кухня', 'Кладовая', 'Полка 1'], qty: 3, barcode: '4607123456828', tags: ['крупы', 'еда'], icon: 'jar' },
  { id: 6, name: 'Лампочки LED E27', category: 'Монтажное', location: ['Кладовая', 'Ящик 3'], qty: 8, barcode: '4607123456835', tags: ['электрика', 'освещение'], icon: 'box' },
  { id: 7, name: 'Моторное масло 5W-30', category: 'Авто', location: ['Гараж', 'Стеллаж B'], qty: 2, barcode: '4607123456842', tags: ['автохимия', 'жидкости'], icon: 'jar' },
  { id: 8, name: 'Стиральный порошок', category: 'Гигиена', location: ['Балкон', 'Шкаф'], qty: 1, barcode: '4607123456859', tags: ['гигиена', 'стирка'], icon: 'box' },
  { id: 9, name: 'Батарейки АА', category: 'Дроновое', location: ['Кухня', 'Ящик стола'], qty: 16, barcode: '4607123456866', tags: ['электрика', 'расходники'], icon: 'tag' },
  { id: 10, name: 'Консервы тунец', category: 'Еда', location: ['Кладовая', 'Полка 2'], qty: 5, barcode: '4607123456873', tags: ['консервы', 'еда'], icon: 'jar' },
  { id: 11, name: 'Автомобильные щётки', category: 'Авто', location: ['Гараж', 'Стеллаж A'], qty: 2, barcode: '4607123456880', tags: ['уход', 'автохимия'], icon: 'tag' },
  { id: 12, name: 'Полотенца банные', category: 'Гигиена', location: ['Ванная', 'Верхняя полка'], qty: 4, barcode: '4607123456897', tags: ['текстиль', 'гигиена'], icon: 'box' },
]

function locationPath(item: CatalogItem): string {
  return item.location.join(':')
}

// ---------- search: prefix parsing + fuzzy matching ----------
//
// Real (if simple) matching rather than a plain .includes(): exact ->
// prefix -> substring -> ordered-subsequence fuzzy, each tier scored so
// results can be ranked instead of just included/excluded. `#tags:` and
// `#cat`/`#categ`/`#category` restrict which field is searched; anything
// else searches name/category/location/tags/barcode together.

type SearchField = 'all' | 'tags' | 'category'

function parseSearch(raw: string): { field: SearchField; text: string } {
  const trimmed = raw.trim()
  const prefixMatch = trimmed.match(/^#(tags?|category|categ|cat)\b:?\s*/i)
  if (!prefixMatch) return { field: 'all', text: trimmed }
  const word = prefixMatch[1].toLowerCase()
  const field: SearchField = word.startsWith('tag') ? 'tags' : 'category'
  return { field, text: trimmed.slice(prefixMatch[0].length).trim() }
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

function CollapseIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? <path d="M15 6l-6 6 6 6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  )
}

function ItemIcon({ icon }: { icon: CatalogItem['icon'] }) {
  const Icon = ITEM_ICONS[icon]
  return <Icon />
}

// Shared "large card" template: used both for the catalog's large-card
// view mode and the search dropdown's best-match slot, per the request
// that they follow the same layout (its real visual design comes later --
// this is just the informative shell for now).
function ItemLargeCard({ item }: { item: CatalogItem }) {
  return (
    <article className="item-card-large">
      <div className="item-card-large-media">
        <ItemIcon icon={item.icon} />
      </div>
      <div className="item-card-large-body">
        <div className="item-card-large-heading">
          <h3>{item.name}</h3>
          <span className="item-qty">×{item.qty}</span>
        </div>
        <p className="item-location">{locationPath(item)}</p>
        <div className="item-card-large-meta">
          <span className="item-category-pill">{item.category}</span>
          {item.tags.map((tag) => (
            <span key={tag} className="item-tag-pill">
              {tag}
            </span>
          ))}
        </div>
        <code className="item-barcode">{item.barcode}</code>
      </div>
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

export default function CatalogPage({ theme, onToggleTheme }: CatalogPageProps) {
  const [query, setQuery] = useState('')
  // What the item grid actually filters/sorts by -- only replaced on
  // Enter or picking a dropdown result (see commitSearch), so typing
  // alone only drives the live preview dropdown, not the grid underneath.
  const [appliedQuery, setAppliedQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sort, setSort] = useState<SortKey>('name')
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES)
  const [newCategory, setNewCategory] = useState('')
  const [category, setCategory] = useState<string>('Все')
  const [stockFilter, setStockFilter] = useState<FilterKey>('all')
  const [view, setView] = useState<ViewMode>('grid')
  const searchInputRef = useRef<HTMLInputElement>(null)
  // Both cancelSearch and commitSearch below blur the input programmatically
  // once they've already decided what `query` should end up as -- without
  // this, the resulting blur event still reaches handleSearchWrapBlur,
  // which would try to revert `query` a second time using its OWN (by then
  // stale) closure over `appliedQuery` from before this render's update,
  // clobbering a just-applied commit back to the previous search.
  const suppressBlurRevert = useRef(false)

  const { field: searchField, text: searchText } = useMemo(() => parseSearch(query), [query])
  const { field: appliedField, text: appliedText } = useMemo(() => parseSearch(appliedQuery), [appliedQuery])
  const searchActive = searchFocused

  const filtered = useMemo(() => {
    return ITEMS.map((item) => ({ item, score: scoreItem(item, appliedField, appliedText) }))
      .filter(({ score, item }) => {
        if (score <= -1) return false
        const matchesCategory = category === 'Все' || item.category === category
        const matchesStock =
          stockFilter === 'all' || (stockFilter === 'low' ? item.qty <= 2 : item.qty > 5)
        return matchesCategory && matchesStock
      })
      .sort((a, b) => {
        if (appliedText && b.score !== a.score) return b.score - a.score
        if (sort === 'qty') return b.item.qty - a.item.qty
        if (sort === 'location') return locationPath(a.item).localeCompare(locationPath(b.item), 'ru')
        return a.item.name.localeCompare(b.item.name, 'ru')
      })
      .map(({ item }) => item)
  }, [appliedField, appliedText, category, stockFilter, sort])

  // Independent of the sidebar's category/stock filters on purpose -- a
  // quick global search shouldn't be silently narrowed by whatever the
  // filters happen to be set to right now. Driven by the live (not yet
  // applied) query, since this dropdown IS the live preview.
  const searchResults = useMemo(() => {
    if (!searchText) return []
    return ITEMS.map((item) => ({ item, score: scoreItem(item, searchField, searchText) }))
      .filter(({ score }) => score > -1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
  }, [searchField, searchText])

  const bestMatch = searchResults[0]?.item
  const restResults = searchResults.slice(1)

  function cancelSearch() {
    suppressBlurRevert.current = true
    setQuery(appliedQuery)
    setSearchFocused(false)
    searchInputRef.current?.blur()
  }

  function commitSearch() {
    suppressBlurRevert.current = true
    setAppliedQuery(query)
    setSearchFocused(false)
    searchInputRef.current?.blur()
  }

  function handleSearchWrapBlur(e: FocusEvent<HTMLDivElement>) {
    if (suppressBlurRevert.current) {
      suppressBlurRevert.current = false
      return
    }
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setQuery(appliedQuery)
      setSearchFocused(false)
    }
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitSearch()
    } else if (e.key === 'Escape') {
      // type="search" clears itself natively on Escape as the keydown's
      // default action -- without preventDefault that fires right after
      // cancelSearch's own setQuery(appliedQuery), clobbering the revert
      // back to an empty string.
      e.preventDefault()
      cancelSearch()
    }
  }

  function handleResultKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commitSearch()
    }
  }

  function addCategory(e: FormEvent) {
    e.preventDefault()
    const name = newCategory.trim()
    if (!name) return
    setCategories((prev) => (prev.includes(name) ? prev : [...prev, name]))
    setCategory(name)
    setNewCategory('')
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
          <div className="catalog-search-wrap" onBlur={handleSearchWrapBlur}>
            <label className={`catalog-search ${searchActive ? 'is-open' : ''}`}>
              <span className="catalog-search-icon">
                <SearchIcon />
              </span>
              <input
                ref={searchInputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setSearchFocused(true)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Найти... (например, #tags: гигиена)"
                type="search"
              />
            </label>

            <div className={`search-dropdown ${searchActive ? 'is-open' : ''}`}>
              {!searchText ? (
                <div className="search-hint">
                  <p>Начните вводить запрос и нажмите Enter — поиск идёт по названию, категории, месту и тегам.</p>
                  <ul>
                    <li>
                      <code>#tags: значение</code> — искать только по тегам
                    </li>
                    <li>
                      <code>#cat: значение</code> — искать только по категории
                    </li>
                  </ul>
                </div>
              ) : bestMatch ? (
                <>
                  <div className="search-section-label">Лучшее совпадение</div>
                  <button type="button" className="search-best-match" onClick={commitSearch}>
                    <ItemLargeCard item={bestMatch} />
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
                            onClick={commitSearch}
                            onKeyDown={handleResultKeyDown}
                          >
                            <span className="search-result-icon">
                              <ItemIcon icon={item.icon} />
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
            </div>
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

      <div className={`search-overlay ${searchActive ? 'is-open' : ''}`} onClick={cancelSearch} />

      <div className={`catalog-body ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        <button
          type="button"
          className="sidebar-collapse-btn"
          aria-label={sidebarOpen ? 'Скрыть панель фильтров' : 'Показать панель фильтров'}
          aria-pressed={!sidebarOpen}
          onClick={() => setSidebarOpen((v) => !v)}
        >
          <CollapseIcon open={sidebarOpen} />
        </button>

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
                options={[{ key: 'Все', label: 'Все' }, ...categories.map((c) => ({ key: c, label: c }))]}
                value={category}
                onChange={setCategory}
              />
              <form className="add-category-form" onSubmit={addCategory}>
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="Новая категория"
                  aria-label="Название новой категории"
                />
                <button type="submit" aria-label="Добавить категорию" disabled={!newCategory.trim()}>
                  +
                </button>
              </form>
            </div>

            <div className="sidebar-section">
              <h2>Фильтры</h2>
              <RadioGroup name="stock" options={STOCK_FILTERS} value={stockFilter} onChange={setStockFilter} />
            </div>

            <div className="sidebar-view-switch" role="radiogroup" aria-label="Вид отображения">
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
        </aside>

        <main className="catalog-main">
          <div className="catalog-main-toolbar">
            <span className="catalog-count">{filtered.length} предметов</span>
          </div>

          {filtered.length === 0 ? (
            <p className="catalog-empty">Ничего не найдено — попробуйте другой запрос или фильтр.</p>
          ) : (
            <div className={`catalog-items view-${view}`}>
              {filtered.map((item) =>
                view === 'large' ? (
                  <ItemLargeCard key={item.id} item={item} />
                ) : (
                  <article key={item.id} className="item-card">
                    <div className="item-icon">
                      <ItemIcon icon={item.icon} />
                    </div>
                    <div className="item-body">
                      <h3>{item.name}</h3>
                      <p className="item-location">{locationPath(item)}</p>
                      <code className="item-barcode">{item.barcode}</code>
                    </div>
                    <span className="item-qty">×{item.qty}</span>
                  </article>
                ),
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
