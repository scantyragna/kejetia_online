'use client'

import { useState } from 'react'
import { getSupabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

export default function LoginPage() {
  const router = useRouter()
  const [form, setForm] = useState({ email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const sb = getSupabase()
    const { data: loginData, error: loginError } = await sb.auth.signInWithPassword({
      email: form.email,
      password: form.password,
    })

    setLoading(false)

    if (loginError) {
      setError(loginError.message)
      return
    }

    // Let the auth provider pick up the session before navigating.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const session = loginData?.session
    const u = session?.user
    const role = u?.user_metadata?.role || 'buyer'

    if (role !== 'seller') {
      router.push('/')
      router.refresh()
      return
    }

    // Sellers land on their store if one exists, otherwise store onboarding.
    const { data: storeRows } = await sb
      .from('stores')
      .select('id')
      .eq('owner_id', u.id)
      .limit(1)
    if (storeRows?.length) {
      router.push('/dashboard/seller')
    } else {
      router.push('/onboarding')
    }
    router.refresh()
  }

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <div style={styles.topBar}>
          <a href="/" style={styles.brand}>
            <img src="/logo.svg" alt="Kejetia Online" style={styles.brandLogo} />
          </a>
          <Link href="/auth/signup" style={styles.inlineLink}>Create account</Link>
        </div>

        <div style={styles.headerBlock}>
          <p style={styles.eyebrow}>Welcome back</p>
          <h1 style={styles.title}>Log in to your account</h1>
        </div>

        <form onSubmit={handleLogin} style={styles.form}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Email</label>
            <input
              style={styles.input}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
              placeholder="you@example.com"
            />
          </div>

          <div style={styles.fieldGroup}>
            <label style={styles.label}>Password</label>
            <input
              style={styles.input}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required
              placeholder="Enter your password"
            />
          </div>

          {error && <p style={styles.error}>{error}</p>}

          <button type="submit" style={styles.submitBtn} disabled={loading}>
            {loading ? 'Logging in...' : 'Log In'}
          </button>

          <p style={styles.switch}>
            Don&apos;t have an account? <Link href="/auth/signup" style={styles.link}>Sign up</Link>
          </p>
        </form>
      </div>
    </div>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'radial-gradient(800px 420px at 15% -10%, rgba(255,193,7,0.16) 0%, transparent 60%), linear-gradient(135deg, #0b1220 0%, #0f172a 55%, #1e293b 100%)',
    padding: 24,
  },
  card: {
    background: '#fff',
    borderRadius: 24,
    padding: 28,
    maxWidth: 440,
    width: '100%',
    boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  topBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  brand: { display: 'inline-flex', alignItems: 'center', textDecoration: 'none' },
  brandLogo: { height: 40, width: 'auto', display: 'block', borderRadius: 9 },
  inlineLink: { color: 'var(--accent-700)', fontSize: 13, fontWeight: 700, textDecoration: 'none' },
  headerBlock: { marginBottom: 20 },
  eyebrow: { fontSize: 12, color: 'var(--accent-600)', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 800, margin: '0 0 8px' },
  title: { fontSize: 28, fontWeight: 800, margin: 0, color: '#111827' },
  form: { display: 'flex', flexDirection: 'column', gap: 16 },
  fieldGroup: { display: 'flex', flexDirection: 'column' },
  label: { fontSize: 13, fontWeight: 700, marginBottom: 6, color: '#374151' },
  input: {
    padding: '12px 14px',
    border: '1px solid #d1d5db',
    borderRadius: 10,
    fontSize: 15,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    background: '#fff',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
  error: { color: '#b91c1c', fontSize: 14, margin: '0', padding: '10px 12px', background: '#fef2f2', borderRadius: 10, border: '1px solid rgba(185, 28, 28, 0.15)' },
  submitBtn: {
    background: 'var(--accent)',
    color: 'var(--navy)',
    padding: '14px 22px',
    border: 'none',
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
    boxShadow: '0 14px 28px rgba(255, 193, 7, 0.35)',
    transition: 'all 0.2s ease',
  },
  switch: { fontSize: 14, color: '#4b5563', textAlign: 'center', marginTop: 8 },
  link: { color: 'var(--accent-700)', fontWeight: 700 },
}

