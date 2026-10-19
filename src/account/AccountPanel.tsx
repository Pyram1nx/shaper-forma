import { useState, type FormEvent } from 'react'
import { accountsEnabled, getSession, signIn, signOut, signUp, type Session } from './api'

/** "Member since" text for an account, or null when the server did not send a date. */
const memberSince = (s: Session) => (s.createdAt ? new Date(s.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : null)

/**
 * Sign in, create an account, or show the signed-in account with sign out.
 * Shared by the studio's account dialog and the home window's account page.
 */
export default function AccountPanel({ onChange }: { onChange?: (session: Session | null) => void }) {
  const [session, setSession] = useState<Session | null>(() => getSession())
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const update = (s: Session | null) => {
    setSession(s)
    onChange?.(s)
  }

  if (!accountsEnabled()) return <p className="ss-muted">Accounts are not set up in this build.</p>

  if (session) {
    const since = memberSince(session)
    return (
      <div className="account-panel">
        <p>
          Signed in as <strong>{session.email}</strong>.
        </p>
        {since && <p className="ss-muted">Member since {since}.</p>}
        <button
          className="ss-btn"
          onClick={() => {
            signOut()
            update(null)
          }}
        >
          Sign out
        </button>
      </div>
    )
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const s = mode === 'signup' ? await signUp(email, password) : await signIn(email, password)
      setPassword('')
      update(s)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="account-panel" onSubmit={submit}>
      <div className="account-panel__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'signin'} className={'ss-btn' + (mode === 'signin' ? ' ss-btn--primary' : '')} onClick={() => setMode('signin')}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === 'signup'} className={'ss-btn' + (mode === 'signup' ? ' ss-btn--primary' : '')} onClick={() => setMode('signup')}>
          Create account
        </button>
      </div>
      <label className="ss-field">
        <span className="ss-label">email</span>
        <span className="ss-input">
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </span>
      </label>
      <label className="ss-field">
        <span className="ss-label">password</span>
        <span className="ss-input">
          <input
            type="password"
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </span>
      </label>
      {mode === 'signup' && <p className="ss-muted">At least 8 characters.</p>}
      {error && <p className="account-panel__error">{error}</p>}
      <button className="ss-btn ss-btn--primary" type="submit" disabled={busy}>
        {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
    </form>
  )
}
