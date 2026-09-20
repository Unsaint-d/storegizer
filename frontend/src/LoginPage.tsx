import { useState, type FormEvent } from 'react'
import './LoginPage.css'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8080'

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

const FLOATERS = [
  { size: 120, top: '10%', left: '15%', delay: '0s', duration: '14s', color: 'var(--accent)' },
  { size: 80, top: '55%', left: '8%', delay: '2s', duration: '11s', color: 'var(--add)' },
  { size: 150, top: '30%', left: '55%', delay: '1s', duration: '16s', color: 'var(--remove)' },
  { size: 70, top: '70%', left: '60%', delay: '3.5s', duration: '10s', color: 'var(--accent)' },
  { size: 100, top: '15%', left: '75%', delay: '0.5s', duration: '13s', color: 'var(--add)' },
  { size: 60, top: '80%', left: '30%', delay: '2.5s', duration: '9s', color: 'var(--remove)' },
]

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('key')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [readerEntered, setReaderEntered] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    if (mode === 'key') {
      if (!login.trim() || !password.trim()) {
        setError('Введите логин и пароль.')
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
        // TODO: once the backend auth endpoint exists, redirect into the admin panel here.
      } catch {
        setError('Не удалось войти. Проверьте логин и пароль.')
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
      } catch {
        // No reader-auth endpoint exists yet either -- fall through to a
        // local demo state so the anonymous path still has something to show.
        setReaderEntered(true)
      } finally {
        setSubmitting(false)
      }
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>
          <span className="headline-main">Добро пожаловать</span>
          <span className="headline-sub">в систему домашнего складского учёта!</span>
        </h1>
        <p className="subtitle">Авторизуйтесь в систему, чтобы продолжить</p>

        <div className="mode-toggle" role="radiogroup" aria-label="Способ входа">
          <button
            type="button"
            className={mode === 'key' ? 'active' : ''}
            aria-pressed={mode === 'key'}
            onClick={() => {
              setMode('key')
              setError(null)
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
              setError(null)
              setReaderEntered(false)
            }}
          >
            <EyeIcon />
          </button>
          <span className="mode-label">
            {mode === 'key' ? 'вход в учётную запись' : 'вход анонимно (только просмотр)'}
          </span>
        </div>

        <form onSubmit={handleSubmit}>
          {mode === 'key' && (
            <>
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="Логин"
                autoComplete="username"
              />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                type="password"
                placeholder="Пароль"
                autoComplete="current-password"
              />
            </>
          )}

          <button type="submit" className="submit" disabled={submitting}>
            {submitting ? 'Входим…' : 'Войти'}
          </button>
        </form>

        {readerEntered && (
          <p className="reader-note">Вы вошли как читатель (демо, каталог ещё не подключён).</p>
        )}
      </div>

      <div className="brand-panel" aria-hidden="true">
        <div className="floaters">
          {FLOATERS.map((f, i) => (
            <span
              key={i}
              className="floater"
              style={{
                width: f.size,
                height: f.size,
                top: f.top,
                left: f.left,
                background: f.color,
                animationDelay: f.delay,
                animationDuration: f.duration,
              }}
            />
          ))}
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
        <div className="modal-overlay" onClick={() => setError(null)}>
          <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>Не получилось</h2>
            <p>{error}</p>
            <button type="button" onClick={() => setError(null)}>
              Понятно
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
