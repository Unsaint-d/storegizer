import { useEffect, useRef, useState } from 'react'
import LoginPage, { MoonIcon, SunIcon } from './LoginPage'
import CatalogPage from './CatalogPage'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8081'

type Item = { id: number; barcode: string; name: string }
type ScanEvent = { barcode: string; receivedAt: string }

type Theme = 'light' | 'dark'

const THEME_STORAGE_KEY = 'storegizer-theme'

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // localStorage unavailable (private mode, etc.) -- fall through to system preference
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function DebugDashboard() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'unreachable'>('checking')
  const [items, setItems] = useState<Item[]>([])
  const [scans, setScans] = useState<ScanEvent[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch(`${API_BASE_URL}/api/health`)
      .then((res) => setHealth(res.ok ? 'ok' : 'unreachable'))
      .catch(() => setHealth('unreachable'))

    fetch(`${API_BASE_URL}/api/items`)
      .then((res) => res.json())
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'scan' && typeof data.barcode === 'string') {
          setScans((prev) => [{ barcode: data.barcode, receivedAt: new Date().toLocaleTimeString() }, ...prev].slice(0, 20))
        }
      } catch {
        // ignore malformed messages
      }
    }

    return () => ws.close()
  }, [])

  return (
    <main className="page">
      <h1>Storegizer</h1>
      <p className="status">
        Backend: <span className={`badge ${health}`}>{health}</span>
      </p>

      <section>
        <h2>Предметы</h2>
        {items.length === 0 ? (
          <p className="muted">Пусто — база данных ещё не заполнена.</p>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                {item.name} <code>{item.barcode}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Лента сканирований</h2>
        {scans.length === 0 ? (
          <p className="muted">
            Пока пусто. Отправьте тестовый скан:{' '}
            <code>curl -X POST --data ITEM-0001 {API_BASE_URL}/api/debug/scan</code>
          </p>
        ) : (
          <ul>
            {scans.map((scan, i) => (
              <li key={i}>
                <code>{scan.barcode}</code> <span className="muted">{scan.receivedAt}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

// Trial of the login/catalog mockup -- no routing yet (only these pages
// worth navigating to so far), so a corner link swaps to the old
// backend-debug view instead of losing it.
function App() {
  const [showDebug, setShowDebug] = useState(false)
  const [loggedIn, setLoggedIn] = useState(false)
  const [theme, setTheme] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      // ignore -- theme just won't persist across reloads
    }
  }, [theme])

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  const showingCatalog = !showDebug && loggedIn

  let page = <LoginPage onAuthenticated={() => setLoggedIn(true)} />
  if (showDebug) {
    page = <DebugDashboard />
  } else if (loggedIn) {
    // Catalog gets its own theme toggle inline in the topbar (next to the
    // search field), so the floating corner one below is hidden for it --
    // see the `!showingCatalog` guard.
    page = <CatalogPage theme={theme} onToggleTheme={toggleTheme} />
  }

  return (
    <>
      {page}
      <button type="button" className="debug-toggle" onClick={() => setShowDebug((v) => !v)}>
        {showDebug ? '← Назад' : 'Debug'}
      </button>
      {!showingCatalog && (
        <button
          type="button"
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
        >
          {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
        </button>
      )}
    </>
  )
}

export default App
