import { useEffect, useState, type FormEvent } from 'react'
import './LoginPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

// Matches the .field-group grid-template-rows transition duration in
// LoginPage.css -- the submit button should only pick up its enabled
// (yellow) look once the login/password fields have finished collapsing,
// not the instant anonymous mode is selected.
const FIELD_COLLAPSE_MS = 350

// Matches the modal-overlay/modal exit animation duration below -- the
// error modal stays mounted for this long after closing so it can fade
// and scale out instead of vanishing on the frame the user clicks "Понятно".
const MODAL_CLOSE_MS = 220

type Mode = 'key' | 'eye'

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="7.5" cy="12" r="3.5" />
      <path d="M10.8 12H21M17 12v3M20 12v2" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

// Exported so CatalogPage can reuse the same storage-item glyphs for its
// item cards instead of drawing its own set.
export function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="4" />
    </svg>
  )
}

export function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="3,4 14,4 21,12 14,20 3,20" />
    </svg>
  )
}

export function JarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="7" width="12" height="15" rx="3" />
      <rect x="9" y="2" width="6" height="5" rx="1.5" />
    </svg>
  )
}

export function BarcodeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="2" y="4" width="2" height="16" />
      <rect x="6" y="4" width="1" height="16" />
      <rect x="9" y="4" width="3" height="16" />
      <rect x="14" y="4" width="1" height="16" />
      <rect x="17" y="4" width="2" height="16" />
      <rect x="21" y="4" width="1" height="16" />
    </svg>
  )
}

// Exported so App (the global fixed toggle) and CatalogPage (its inline
// topbar toggle) share the same glyphs instead of each drawing their own.
export function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 2.5v2.5M12 19v2.5M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2.5 12H5M19 12h2.5M4.2 19.8l1.8-1.8M18 6l1.8-1.8" />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  )
}

// Cycled across the floaters below so the background reads as a loose mix
// of storage-adjacent items (box, tag, jar, barcode) instead of plain dots.
const FLOATER_ICONS = [BoxIcon, TagIcon, JarIcon, BarcodeIcon]

// `top` starts most floaters below the visible panel (>100%) so they drift
// up INTO view before rising out through the top, rather than popping in
// already on screen. `delay` is negative so each floater's infinite
// float-rise loop starts already mid-flight, staggering them from the
// first frame instead of every floater launching from the bottom at once.
const FLOATERS = [
  { size: 120, top: '100%', left: '15%', delay: '-3s', duration: '18s', color: 'var(--accent)', icon: 0 },
  { size: 80, top: '115%', left: '8%', delay: '-9s', duration: '15s', color: 'var(--add)', icon: 1 },
  { size: 150, top: '110%', left: '55%', delay: '-6s', duration: '21s', color: 'var(--remove)', icon: 2 },
  { size: 70, top: '115%', left: '60%', delay: '-2s', duration: '13.5s', color: 'var(--accent)', icon: 3 },
  { size: 100, top: '110%', left: '75%', delay: '-11s', duration: '19.5s', color: 'var(--add)', icon: 0 },
  { size: 60, top: '115%', left: '30%', delay: '-4s', duration: '12s', color: 'var(--remove)', icon: 1 },
  { size: 90, top: '104%', left: '45%', delay: '-13s', duration: '16.5s', color: 'var(--accent)', icon: 2 },
  { size: 65, top: '110%', left: '88%', delay: '-7s', duration: '13.5s', color: 'var(--add)', icon: 3 },
  { size: 110, top: '112%', left: '20%', delay: '-2s', duration: '21s', color: 'var(--remove)', icon: 0 },
  { size: 75, top: '120%', left: '70%', delay: '-14s', duration: '15s', color: 'var(--accent)', icon: 1 },
  { size: 55, top: '112%', left: '4%', delay: '-8s', duration: '12s', color: 'var(--add)', icon: 2 },
  { size: 95, top: '113%', left: '38%', delay: '-13s', duration: '18s', color: 'var(--remove)', icon: 3 },
]

type LoginPageProps = {
  onAuthenticated?: () => void
}

export default function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [mode, setMode] = useState<Mode>('key')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [modalClosing, setModalClosing] = useState(false)
  const [readerEntered, setReaderEntered] = useState(false)
  const [eyeModeReady, setEyeModeReady] = useState(false)

  useEffect(() => {
    if (mode !== 'eye') {
      setEyeModeReady(false)
      return
    }
    const t = setTimeout(() => setEyeModeReady(true), FIELD_COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [mode])

  useEffect(() => {
    if (!modalClosing) return
    const t = setTimeout(() => {
      setError(null)
      setModalClosing(false)
    }, MODAL_CLOSE_MS)
    return () => clearTimeout(t)
  }, [modalClosing])

  function closeErrorModal() {
    if (error) setModalClosing(true)
  }

  function showError(message: string) {
    setModalClosing(false)
    setError(message)
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setModalClosing(false)
    setError(null)

    if (mode === 'key') {
      if (!login.trim() || !password.trim()) {
        showError('Введите логин и пароль.')
        return
      }
      setSubmitting(true)
      try {
        const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login, password }),
        })
        if (!res.ok) {
          throw new Error()
        }
        onAuthenticated?.()
      } catch {
        showError('Не удалось войти. Проверьте логин и пароль.')
      } finally {
        setSubmitting(false)
      }
    } else {
      setSubmitting(true)
      try {
        const res = await fetch(`${API_BASE_URL}/api/auth/reader`, { method: 'POST' })
        if (!res.ok) {
          throw new Error()
        }
        setReaderEntered(true)
        onAuthenticated?.()
      } catch {
        // No reader-auth endpoint exists yet either -- fall through to a
        // local demo state so the anonymous path still has something to show.
        setReaderEntered(true)
        onAuthenticated?.()
      } finally {
        setSubmitting(false)
      }
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card-top">
          <h1>
            <span className="headline-main">Добро пожаловать</span>
            <span className="headline-sub">в систему домашнего складского учёта!</span>
          </h1>
        </div>

        <div className="login-card-bottom">
          <p className="subtitle">Авторизуйтесь, чтобы продолжить</p>

          <div className="mode-toggle" role="radiogroup" aria-label="Способ входа">
            <div className="mode-toggle-track">
              <span className={`mode-toggle-thumb ${mode === 'eye' ? 'is-eye' : ''}`} aria-hidden="true" />
              <button
                type="button"
                className={mode === 'key' ? 'active' : ''}
                aria-pressed={mode === 'key'}
                onClick={() => {
                  setMode('key')
                  closeErrorModal()
                  setReaderEntered(false)
                }}
              >
                <KeyIcon />
              </button>
              <button
                type="button"
                className={mode === 'eye' ? 'active' : ''}
                aria-pressed={mode === 'eye'}
                onClick={() => {
                  setMode('eye')
                  closeErrorModal()
                  setReaderEntered(false)
                }}
              >
                <EyeIcon />
              </button>
            </div>
            <span className="mode-label">
              {mode === 'key' ? 'вход в учётную запись' : 'вход анонимно (только просмотр)'}
            </span>
          </div>

          <form onSubmit={handleSubmit}>
            <div className={`field-group ${mode === 'key' ? 'is-open' : ''}`}>
              <div className="field-group-inner">
                <input
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  placeholder="Логин"
                  autoComplete="username"
                  tabIndex={mode === 'key' ? undefined : -1}
                />
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="Пароль"
                  autoComplete="current-password"
                  tabIndex={mode === 'key' ? undefined : -1}
                />
              </div>
            </div>

            <button
              type="submit"
              className="submit"
              disabled={
                submitting || (mode === 'key' ? !login.trim() || !password.trim() : !eyeModeReady)
              }
            >
              {submitting ? 'Входим…' : 'Войти'}
            </button>
          </form>

          {readerEntered && (
            <p className="reader-note reader-note-in">Вы вошли как читатель (демо, каталог ещё не подключён).</p>
          )}
        </div>
      </div>

      <div className="brand-panel" aria-hidden="true">
        <div className="floaters">
          {FLOATERS.map((f, i) => {
            const Icon = FLOATER_ICONS[f.icon]
            return (
              <span
                key={i}
                className="floater"
                style={{
                  width: f.size,
                  height: f.size,
                  top: f.top,
                  left: f.left,
                  color: f.color,
                  animationDelay: f.delay,
                  animationDuration: f.duration,
                }}
              >
                <Icon />
              </span>
            )
          })}
        </div>
        <div className="brand-mark">
          <span className="brand-word">Storegizer</span>
          <span className="brand-barcode">
            {[60, 100, 45, 80, 30, 100, 55, 90, 40, 70].map((h, i) => (
              <span key={i} style={{ height: `${h}%` }} />
            ))}
          </span>
        </div>
      </div>

      {error && (
        <div className={`modal-overlay ${modalClosing ? 'is-closing' : ''}`} onClick={closeErrorModal}>
          <div
            className={`modal ${modalClosing ? 'is-closing' : ''}`}
            role="alertdialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Не получилось</h2>
            <p>{error}</p>
            <button type="button" onClick={closeErrorModal}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
