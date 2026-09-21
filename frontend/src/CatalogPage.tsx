import { useMemo, useState } from 'react'
import { BarcodeIcon, BoxIcon, JarIcon, TagIcon } from './LoginPage'
import './CatalogPage.css'

// Draft mock -- there is no /api/items-with-filters backend yet, so this
// page works entirely off a hardcoded list to give a sense of the catalog
// screen's shape (search, category filters, item cards) before any real
// data layer exists.

type Category = 'Кухня' | 'Кладовая' | 'Гараж' | 'Ванная' | 'Разное'

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

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function LogoutIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  )
}

type CatalogPageProps = {
  onLogout: () => void
}

export default function CatalogPage({ onLogout }: CatalogPageProps) {
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<Category | 'Все'>('Все')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return ITEMS.filter((item) => {
      const matchesCategory = activeCategory === 'Все' || item.category === activeCategory
      const matchesQuery = !q || item.name.toLowerCase().includes(q) || item.barcode.includes(q)
      return matchesCategory && matchesQuery
    })
  }, [query, activeCategory])

  return (
    <div className="catalog-page">
      <p className="catalog-draft-note">Черновой макет — данные не сохраняются, каталог не подключён к бэкенду</p>

      <header className="catalog-header">
        <div className="catalog-brand">
          <span className="catalog-brand-word">Storegizer</span>
          <span className="catalog-brand-sub">Каталог</span>
        </div>

        <label className="catalog-search">
          <SearchIcon />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Найти предмет или штрихкод"
            type="search"
          />
        </label>

        <button type="button" className="catalog-logout" onClick={onLogout}>
          <LogoutIcon />
          Выйти
        </button>
      </header>

      <div className="catalog-toolbar">
        <div className="catalog-filters" role="tablist" aria-label="Категории">
          <button
            type="button"
            className={activeCategory === 'Все' ? 'active' : ''}
            onClick={() => setActiveCategory('Все')}
          >
            Все
          </button>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={activeCategory === c ? 'active' : ''}
              onClick={() => setActiveCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="catalog-toolbar-right">
          <span className="catalog-count">{filtered.length} предметов</span>
          <button type="button" className="catalog-add">
            <PlusIcon />
            Добавить
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="catalog-empty">Ничего не найдено — попробуйте другой запрос или категорию.</p>
      ) : (
        <div className="catalog-grid">
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
    </div>
  )
}
