import { useMemo, useState } from 'react'
import { BarcodeIcon, BoxIcon, JarIcon, TagIcon } from './LoginPage'
import './CatalogPage.css'

// Draft mock -- there is no /api/items-with-filters backend yet, so this
// page works entirely off a hardcoded list to give a sense of the catalog
// screen's shape (sidebar sort/category/filter, view modes, item cards)
// before any real data layer exists. Layout follows the wireframe: top bar
// (menu, logo, search) + left sidebar (sort/categories/filters, view
// switcher) + main item grid.

type Category = 'Кухня' | 'Кладовая' | 'Гараж' | 'Ванная' | 'Разное'
type SortKey = 'name' | 'qty' | 'location'
type FilterKey = 'all' | 'low' | 'high'
type ViewMode = 'grid' | 'list' | 'compact'

type CatalogItem = {
  id: number
  name: string
  category: Category
  location: string
  qty: number
  barcode: string
  icon: keyof typeof ITEM_ICONS
}

const ITEM_ICONS = {
  box: BoxIcon,
  tag: TagIcon,
  jar: JarIcon,
  barcode: BarcodeIcon,
}

const CATEGORIES: Category[] = ['Кухня', 'Кладовая', 'Гараж', 'Ванная', 'Разное']

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
  { id: 1, name: 'Консервированные томаты', category: 'Кухня', location: 'Кухонный шкаф, полка 2', qty: 6, barcode: '4607123456781', icon: 'jar' },
  { id: 2, name: 'Туалетная бумага', category: 'Ванная', location: 'Шкаф под раковиной', qty: 12, barcode: '4607123456798', icon: 'box' },
  { id: 3, name: 'Аптечка первой помощи', category: 'Разное', location: 'Прихожая, верхняя полка', qty: 1, barcode: '4607123456804', icon: 'box' },
  { id: 4, name: 'Зимняя резина, комплект', category: 'Гараж', location: 'Стеллаж A', qty: 4, barcode: '4607123456811', icon: 'tag' },
  { id: 5, name: 'Крупа гречневая', category: 'Кухня', location: 'Кладовая, полка 1', qty: 3, barcode: '4607123456828', icon: 'jar' },
  { id: 6, name: 'Лампочки LED E27', category: 'Разное', location: 'Кладовая, ящик 3', qty: 8, barcode: '4607123456835', icon: 'box' },
  { id: 7, name: 'Моторное масло 5W-30', category: 'Гараж', location: 'Стеллаж B', qty: 2, barcode: '4607123456842', icon: 'jar' },
  { id: 8, name: 'Стиральный порошок', category: 'Ванная', location: 'Балкон, шкаф', qty: 1, barcode: '4607123456859', icon: 'box' },
  { id: 9, name: 'Батарейки АА', category: 'Разное', location: 'Кухня, ящик стола', qty: 16, barcode: '4607123456866', icon: 'tag' },
  { id: 10, name: 'Консервы тунец', category: 'Кухня', location: 'Кладовая, полка 2', qty: 5, barcode: '4607123456873', icon: 'jar' },
  { id: 11, name: 'Автомобильные щётки', category: 'Гараж', location: 'Стеллаж A', qty: 2, barcode: '4607123456880', icon: 'tag' },
  { id: 12, name: 'Полотенца банные', category: 'Ванная', location: 'Шкаф, полка 1', qty: 4, barcode: '4607123456897', icon: 'box' },
]

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

function CompactViewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="6" rx="1.2" />
      <rect x="3" y="14" width="18" height="6" rx="1.2" />
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

export default function CatalogPage() {
  const [query, setQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sort, setSort] = useState<SortKey>('name')
  const [category, setCategory] = useState<Category | 'Все'>('Все')
  const [stockFilter, setStockFilter] = useState<FilterKey>('all')
  const [view, setView] = useState<ViewMode>('grid')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ITEMS.filter((item) => {
      const matchesQuery = !q || item.name.toLowerCase().includes(q) || item.barcode.includes(q)
      const matchesCategory = category === 'Все' || item.category === category
      const matchesStock =
        stockFilter === 'all' || (stockFilter === 'low' ? item.qty <= 2 : item.qty > 5)
      return matchesQuery && matchesCategory && matchesStock
    }).sort((a, b) => {
      if (sort === 'qty') return b.qty - a.qty
      if (sort === 'location') return a.location.localeCompare(b.location, 'ru')
      return a.name.localeCompare(b.name, 'ru')
    })
  }, [query, category, stockFilter, sort])

  return (
    <div className="catalog-page">
      <p className="catalog-draft-note">Черновой макет — данные не сохраняются, каталог не подключён к бэкенду</p>

      <header className="catalog-topbar">
        <button type="button" className="icon-btn menu-btn" aria-label="Меню">
          <MenuIcon />
        </button>

        <div className="catalog-brand">
          <span className="catalog-brand-word">Storegizer</span>
          <span className="catalog-brand-tab">каталог</span>
        </div>

        <label className="catalog-search">
          <span className="catalog-search-icon">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти..."
            type="search"
          />
        </label>
      </header>

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
                options={[{ key: 'Все' as const, label: 'Все' }, ...CATEGORIES.map((c) => ({ key: c, label: c }))]}
                value={category}
                onChange={setCategory}
              />
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
                className={view === 'compact' ? 'active' : ''}
                aria-pressed={view === 'compact'}
                aria-label="Компактный список"
                onClick={() => setView('compact')}
              >
                <CompactViewIcon />
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
              {filtered.map((item) => {
                const Icon = ITEM_ICONS[item.icon]
                return (
                  <article key={item.id} className="item-card">
                    <div className="item-icon">
                      <Icon />
                    </div>
                    <div className="item-body">
                      <h3>{item.name}</h3>
                      <p className="item-location">{item.location}</p>
                      <code className="item-barcode">{item.barcode}</code>
                    </div>
                    <span className="item-qty">×{item.qty}</span>
                  </article>
                )
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
