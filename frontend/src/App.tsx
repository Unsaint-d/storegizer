import { useEffect, useRef, useState } from 'react'
import LoginPage from './LoginPage'
import './App.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8081'

type Item = { id: number; barcode: string; name: string }
type ScanEvent = { barcode: string; receivedAt: string }

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

// Trial of the login page mockup -- no routing yet (only one page worth
// navigating to so far), so a corner link swaps to the old backend-debug
// view instead of losing it.
function App() {
  const [showDebug, setShowDebug] = useState(false)

  return (
    <>
      {showDebug ? <DebugDashboard /> : <LoginPage />}
      <button type="button" className="debug-toggle" onClick={() => setShowDebug((v) => !v)}>
        {showDebug ? '← Вход' : 'Debug'}
      </button>
    </>
  )
}

export default App
