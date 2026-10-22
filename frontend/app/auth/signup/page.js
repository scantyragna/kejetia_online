'use client'

import { Suspense, useEffect, useState } from 'react'
import { getSupabase } from '@/lib/supabase'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Icon } from '@/components/icons'

export default function SignupPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>}>
      <SignupContent />
    </Suspense>
  )
}

function SignupContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [step, setStep] = useState('role')
  const [role, setRole] = useState('')
  const [form, setForm] = useState({ email: '', password: '', full_name: '', phone: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // /auth/signup?role=seller (used by every "List Your Business" CTA) skips
  // the role picker and goes straight to the account form.
  useEffect(() => {
    if (searchParams.get('role') === 'seller') {
      setRole('seller')
      setStep('form')
    }
  }, [searchParams])

  const chooseRole = (selectedRole) => {
    setRole(selectedRole)
    setStep('form')
    setError('')
  }

  const handleSignup = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const sb = getSupabase()
    const { data: signUpData, error: signUpError } = await sb.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: {
          full_name: form.full_name,
          phone: form.phone,
          role,
        },
      },
    })

    setLoading(false)

    if (signUpError) {
      setError(signUpError.message)
      return
    }

    // Let the auth provider pick up the new session before navigating.
    await new Promise((resolve) => setTimeout(resolve, 150))

    const signedIn = Boolean(signUpData?.session)
    if (role === 'seller') {
      // Sellers go straight into store onboarding.
      router.push(signedIn ? '/onboarding' : '/auth/login?verified=false')
    } else {
      router.push(signedIn ? '/' : '/auth/login?verified=false')
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.authShell} className="ko-auth-shell">
        <aside style={styles.heroPanel} className="ko-auth-hero">
          <div style={styles.headerRow}>
            <div style={styles.logoWrap}>
              <img src="/logo.svg" alt="Kejetia Online" style={styles.brandLogo} />
            </div>
          </div>

          <div style={styles.heroContent} className="ko-auth-hero-content">
            <span style={styles.eyebrow}>Marketplace growth</span>
            <h1 style={styles.heroTitle}>Sell smarter. Reach buyers in the heart of the market.</h1>
            <p style={styles.heroText} className="ko-auth-hero-text">
              List your store, showcase products, and connect with local shoppers in minutes.
            </p>

            <div style={styles.benefitList} className="ko-auth-benefits">
              <div style={styles.benefitItem}><span style={styles.bullet}><Icon name="check" size={12} /></span> List your store in minutes</div>
              <div style={styles.benefitItem}><span style={styles.bullet}><Icon name="check" size={12} /></span> Reach nearby buyers by neighborhood and map</div>
              <div style={styles.benefitItem}><span style={styles.bullet}><Icon name="check" size={12} /></span> Chat directly with customers</div>
            </div>
          </div>
        </aside>

        <main style={styles.formPanel} className="ko-auth-form-panel">
          <div style={styles.formHeader}>
            <div style={styles.stepRow}>
              <span style={{ ...styles.stepPill, ...(step === 'role' ? styles.stepPillActive : {}) }}>1. Role</span>
              <span style={{ ...styles.stepPill, ...(step === 'form' ? styles.stepPillActive : {}) }}>2. Details</span>
            </div>
            <Link href="/auth/login" style={styles.inlineLink}>Already have an account?</Link>
          </div>

          {step === 'role' && (
            <>
              <h2 style={styles.title}>Create your account</h2>
              <p style={styles.subtitle}>Choose how you want to use Kejetia Online.</p>

              <div style={styles.roleGrid}>
                <button type="button" style={styles.roleCard} onClick={() => chooseRole('buyer')}>
                  <span style={styles.roleIcon}>
                    <Icon name="shopping-bag" size={24} color="var(--accent-700)" />
                  </span>
                  <span style={styles.roleTitle}>I&apos;m a Buyer</span>
                  <span style={styles.roleDesc}>Discover products, compare stores, and shop locally.</span>
                </button>

                <button type="button" style={{ ...styles.roleCard, ...styles.roleCardActive }} onClick={() => chooseRole('seller')}>
                  <span style={styles.roleIcon}>
                    <Icon name="storefront" size={24} color="var(--accent-700)" />
                  </span>
                  <span style={styles.roleTitle}>I&apos;m a Seller</span>
                  <span style={styles.roleDesc}>List your store and reach customers in Kejetia.</span>
                </button>
              </div>
            </>
          )}

          {step === 'form' && (
            <form onSubmit={handleSignup} style={styles.form}>
              <div style={styles.headRow}>
                <button type="button" style={styles.backBtn} onClick={() => setStep('role')}>← Back</button>
                <span style={styles.roleBadge}>{role === 'seller' ? 'Seller account' : 'Buyer account'}</span>
              </div>

              <h2 style={styles.formTitle}>
                {role === 'seller' ? 'Create your seller account' : 'Create your buyer account'}
              </h2>

              <div style={styles.fieldGrid} className="ko-auth-fields-2col">
                <div style={styles.fieldGroup}>
                  <label style={styles.label}>Full Name</label>
                  <input
                    style={styles.input}
                    type="text"
                    value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                    required
                    placeholder="Your full name"
                  />
                </div>

                <div style={styles.fieldGroup}>
                  <label style={styles.label}>Phone Number</label>
                  <input
                    style={styles.input}
                    type="tel"
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    required
                    placeholder="020 000 0000"
                  />
                </div>

                <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
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

                <div style={{ ...styles.fieldGroup, gridColumn: '1 / -1' }}>
                  <label style={styles.label}>Password</label>
                  <input
                    style={styles.input}
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    minLength={6}
                    placeholder="At least 6 characters"
                  />
                </div>
              </div>

              {error && <p style={styles.error}>{error}</p>}

              <button type="submit" style={styles.submitBtn} disabled={loading}>
                {loading ? 'Creating account...' : 'Create Account'}
              </button>
            </form>
          )}
        </main>
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
    background: 'radial-gradient(900px 500px at 12% -10%, rgba(255,193,7,0.15) 0%, transparent 60%), linear-gradient(135deg, #0b1220 0%, #0f172a 55%, #1e293b 100%)',
    padding: 24,
  },
  authShell: {
    display: 'grid',
    gridTemplateColumns: 'minmax(300px, 1.1fr) minmax(360px, 560px)',
    maxWidth: 1040,
    width: '100%',
    borderRadius: 28,
    overflow: 'hidden',
    background: '#fff',
    boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
    border: '1px solid rgba(255,255,255,0.06)',
  },
  heroPanel: {
    background: 'linear-gradient(165deg, #111c33 0%, #0f172a 45%, #241a08 130%)',
    color: '#fff',
    padding: '28px 28px 32px',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    position: 'relative',
    overflow: 'hidden',
  },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logoWrap: { display: 'inline-flex', alignItems: 'center', gap: 10 },
  brandLogo: { height: 44, width: 'auto', display: 'block', borderRadius: 9, boxShadow: '0 4px 14px rgba(0,0,0,0.35)' },
  heroContent: { marginTop: 32 },
  eyebrow: {
    display: 'inline-block',
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: '0.13em',
    textTransform: 'uppercase',
    opacity: 0.9,
    marginBottom: 16,
  },
  heroTitle: { fontSize: 36, lineHeight: 1.15, fontWeight: 800, margin: '0 0 16px' },
  heroText: { fontSize: 16, lineHeight: 1.7, color: 'rgba(255,255,255,0.9)', margin: 0 },
  benefitList: { display: 'grid', gap: 14, marginTop: 26 },
  benefitItem: { display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, fontSize: 15 },
  bullet: {
    display: 'inline-flex', width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
    background: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center',
  },
  formPanel: { background: '#fff', padding: '30px 30px 34px', display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  formHeader: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 18 },
  stepRow: { display: 'flex', gap: 10 },
  stepPill: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '7px 12px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: '#4b5563',
    background: '#f3f4f6',
  },
  stepPillActive: { background: 'var(--accent-tint)', color: 'var(--accent-700)' },
  inlineLink: { fontSize: 13, fontWeight: 600, color: 'var(--accent-700)', textDecoration: 'none' },
  title: { fontSize: 28, fontWeight: 800, margin: '0 0 8px', color: '#111827' },
  subtitle: { fontSize: 15, color: '#6b7280', margin: '0 0 24px' },
  roleGrid: { display: 'flex', flexDirection: 'column', gap: 16 },
  roleCard: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
    padding: 22,
    border: '1px solid var(--border)',
    borderRadius: 16,
    cursor: 'pointer',
    background: '#f8fafc',
    transition: 'all 0.25s ease',
    textAlign: 'left',
    boxSizing: 'border-box',
  },
  roleCardActive: {
    background: 'linear-gradient(135deg, rgba(255,193,7,0.10) 0%, rgba(251,191,36,0.16) 100%)',
    borderColor: 'rgba(255, 193, 7, 0.55)',
    boxShadow: '0 10px 22px rgba(255, 193, 7, 0.18)',
  },
  roleIcon: {
    width: 46, height: 46, borderRadius: 14,
    background: 'var(--accent-tint)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  roleTitle: { fontSize: 18, fontWeight: 800, color: '#111827' },
  roleDesc: { fontSize: 14, color: '#4b5563', lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column' },
  headRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  backBtn: { background: 'transparent', border: 'none', color: 'var(--accent-700)', fontWeight: 700, cursor: 'pointer', padding: 0, fontSize: 14 },
  roleBadge: { background: 'var(--accent-tint)', color: 'var(--accent-700)', padding: '6px 10px', borderRadius: 999, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em' },
  formTitle: { fontSize: 24, fontWeight: 800, margin: '0 0 20px', color: '#111827' },
  fieldGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 },
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
  error: { color: '#b91c1c', fontSize: 14, margin: '14px 0 0', padding: '10px 12px', background: '#fef2f2', borderRadius: 10, border: '1px solid rgba(185, 28, 28, 0.15)' },
  submitBtn: {
    background: 'var(--accent)',
    color: 'var(--navy)',
    padding: '14px 22px',
    border: 'none',
    borderRadius: 10,
    fontSize: 16,
    fontWeight: 800,
    cursor: 'pointer',
    marginTop: 22,
    boxShadow: '0 14px 28px rgba(255, 193, 7, 0.35)',
    transition: 'all 0.2s ease',
  },
}

