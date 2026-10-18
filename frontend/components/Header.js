'use client'

import { useState } from 'react'

export default function Header({ user, profile, onSignOut }) {
  const [open, setOpen] = useState(false)

  const storeUrl = '/search'
  const dashUrl = profile?.role === 'seller' ? '/dashboard/seller' : '/chat'

  return (
    <header style={styles.header}>
      <div className="container ko-header-inner" style={styles.inner}>
        <a href="/" style={styles.logoWrap} aria-label="Kejetia Online home">
          <img src="/logo.svg" alt="Kejetia Online" style={styles.logo} />
        </a>

        <nav style={styles.nav} className="ko-header-nav" aria-label="Primary">
          <a href="/" style={styles.navLink}>Home</a>
          <a href={storeUrl} style={styles.navLink}>Stores</a>
          <a href="/directions" style={styles.navLink}>Directions</a>
          {user && (
            <a href="/studio" style={styles.navLink}>
              Map Studio
            </a>
          )}
          {user && profile?.is_admin && (
            <a href="/admin/map" style={styles.navLink}>
              Map Admin
            </a>
          )}
          {user && (
            <a href={dashUrl} style={styles.navLink}>
              {profile?.role === 'seller' ? 'Dashboard' : 'Messages'}
            </a>
          )}
        </nav>

        <div style={styles.actions}>
          {user ? (
            <>
              <a href={dashUrl} style={styles.avatarLink} className="ko-header-avatar" title={user.email || 'Account'}>
                {(profile?.full_name || user.email || 'U').charAt(0).toUpperCase()}
              </a>
              <button onClick={onSignOut} style={styles.signOutBtn} className="ko-header-signout" aria-label="Sign out">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </>
          ) : (
            <>
              <a href="/auth/login" style={styles.signIn} className="ko-header-signin">Sign in</a>
              <a href="/auth/signup" className="ko-btn ko-btn-accent ko-header-cta" style={styles.cta}>
                Get Started
              </a>
            </>
          )}
          <button style={styles.hamburger} className="ko-header-burger" onClick={() => setOpen(!open)} aria-label="Toggle menu" aria-expanded={open}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              {open ? <path d="M18 6 6 18M6 6l12 12" /> : <path d="M3 6h18M3 12h18M3 18h18" />}
            </svg>
          </button>
        </div>
      </div>

      <div style={styles.mobileMenu} className={`ko-header-menu${open ? ' open' : ''}`}>
          <a href="/" style={styles.mobileLink} onClick={() => setOpen(false)}>Home</a>
          <a href={storeUrl} style={styles.mobileLink} onClick={() => setOpen(false)}>Stores</a>
          <a href="/directions" style={styles.mobileLink} onClick={() => setOpen(false)}>Directions</a>
          {user ? (
            <>
              <a href="/studio" style={styles.mobileLink} onClick={() => setOpen(false)}>Map Studio</a>
              {profile?.is_admin && (
                <a href="/admin/map" style={styles.mobileLink} onClick={() => setOpen(false)}>Map Admin</a>
              )}
              <a href={dashUrl} style={styles.mobileLink} onClick={() => setOpen(false)}>
                {profile?.role === 'seller' ? 'Dashboard' : 'Messages'}
              </a>
              <button
                style={styles.mobileCta}
                onClick={() => {
                  setOpen(false)
                  if (onSignOut) onSignOut()
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <>
              <a href="/auth/login" style={styles.mobileLink} onClick={() => setOpen(false)}>Sign in</a>
              <a href="/auth/signup" style={styles.mobileCta} onClick={() => setOpen(false)}>Get Started</a>
            </>
          )}
      </div>
    </header>
  )
}

const styles = {
  header: {
    background: 'var(--navy)',
    borderBottom: '1px solid rgba(255,255,255,0.07)',
    position: 'sticky',
    top: 0,
    zIndex: 1000,
    boxShadow: '0 2px 12px rgba(15, 23, 42, 0.18)',
  },
  inner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 72,
    gap: 16,
  },
  logoWrap: {
    display: 'flex',
    alignItems: 'center',
    textDecoration: 'none',
    flexShrink: 0,
  },
  logo: {
    height: 47,
    width: 'auto',
    display: 'block',
    borderRadius: 11,
    boxShadow: '0 3px 10px rgba(0,0,0,0.22)',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    gap: 28,
    marginLeft: 40,
  },
  navLink: {
    fontSize: 15,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.82)',
    textDecoration: 'none',
    transition: 'color 0.2s ease',
    cursor: 'pointer',
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
    marginLeft: 'auto',
  },
  signIn: {
    fontSize: 15,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.85)',
    textDecoration: 'none',
    cursor: 'pointer',
    transition: 'color 0.2s ease',
  },
  cta: {
    padding: '10px 22px',
    fontSize: 15,
    borderRadius: 999,
  },
  avatarLink: {
    width: 38,
    height: 38,
    borderRadius: '50%',
    background: 'var(--navy-3)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    fontWeight: 800,
    textDecoration: 'none',
    cursor: 'pointer',
    border: '2px solid var(--accent)',
  },
  signOutBtn: {
    width: 38,
    height: 38,
    borderRadius: '50%',
    border: '1px solid rgba(255,255,255,0.2)',
    background: 'transparent',
    color: 'rgba(255,255,255,0.75)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  hamburger: {
    display: 'none',
    background: 'transparent',
    border: 'none',
    color: '#fff',
    cursor: 'pointer',
    padding: 8,
    borderRadius: 8,
  },
  mobileMenu: {
    flexDirection: 'column',
    padding: '8px 24px 20px',
    gap: 4,
    background: 'var(--navy)',
    borderTop: '1px solid rgba(255,255,255,0.07)',
  },
  mobileLink: {
    fontSize: 16,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.85)',
    padding: '12px 0',
    textDecoration: 'none',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  mobileCta: {
    display: 'block',
    width: '100%',
    textAlign: 'center',
    marginTop: 14,
    padding: '13px 0',
    borderRadius: 999,
    background: 'var(--accent)',
    color: 'var(--navy)',
    fontSize: 16,
    fontWeight: 800,
    textDecoration: 'none',
    border: 'none',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },
}
