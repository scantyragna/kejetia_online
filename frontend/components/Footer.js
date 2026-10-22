import { Icon } from '@/components/icons'

// Hand-drawn brand marks (real vector drawings, no emoji / unicode glyphs).
const SOCIALS = [
  {
    label: 'Facebook',
    node: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z" />
      </svg>
    ),
  },
  {
    label: 'X (Twitter)',
    node: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <path d="M5 5l14 14M19 5L5 19" />
      </svg>
    ),
  },
  {
    label: 'Instagram',
    node: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="4.6" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.4" cy="6.6" r="0.4" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    label: 'WhatsApp',
    node: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.68-1.62-.93-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.3 1.27.49 1.7.63.72.23 1.37.2 1.88.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z" />
        <path d="M12.05 2a9.9 9.9 0 0 0-8.42 15.1L2 22l5-1.3A9.9 9.9 0 1 0 12.05 2zm0 18.2a8.3 8.3 0 0 1-4.23-1.16l-.3-.18-3.06.8.82-2.99-.2-.32a8.3 8.3 0 1 1 6.97 3.85z" />
      </svg>
    ),
  },
  {
    label: 'YouTube',
    node: (
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
        <rect x="2.4" y="6" width="19.2" height="12" rx="3.4" />
        <path d="M10.2 9.8l5 2.2-5 2.2z" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
]

export default function Footer() {
  return (
    <footer style={styles.footer}>
      <div className="container ko-footer-grid">
        <div style={styles.brandCol}>
          <a href="/" style={styles.brand}>
            <img src="/logo.svg" alt="Kejetia Online" style={styles.logo} />
          </a>
          <p style={styles.tagline}>
            Discover Kumasi — the largest open-air market. Find trusted shops and deals around Kumasi, Ghana.
          </p>
          <div style={styles.socials}>
            {SOCIALS.map((s) => (
              <span key={s.label} style={styles.social} title={s.label} aria-label={s.label}>
                {s.node}
              </span>
            ))}
          </div>
        </div>

        <div style={styles.col}>
          <h4 style={styles.heading}>Quick Links</h4>
          <a href="/" style={styles.link}>Home</a>
          <a href="/search" style={styles.link}>Find Dealers</a>
          <a href="/search?q=deals" style={styles.link}>Today&apos;s Deals</a>
          <a href="/directions" style={styles.link}>Directions</a>
        </div>

        <div style={styles.col}>
          <h4 style={styles.heading}>For Customers</h4>
          <a href="/search" style={styles.link}>Browse Categories</a>
          <a href="/search?view=map" style={styles.link}>Explore Map</a>
          <a href="/chat" style={styles.link}>Messages</a>
          <a href="/auth/login" style={styles.link}>Sign in</a>
        </div>

        <div style={styles.col}>
          <h4 style={styles.heading}>For Dealers</h4>
          <a href="/auth/signup?role=seller" style={styles.link}>List Your Business</a>
          <a href="/dashboard/seller" style={styles.link}>Dealer Dashboard</a>
          <a href="/studio" style={styles.link}>Map Studio</a>
          <a href="/auth/login" style={styles.link}>Owner Login</a>
        </div>

        <div style={styles.col}>
          <h4 style={styles.heading}>Contact Us</h4>
          <p style={styles.contact}><Icon name="phone" size={13} color="var(--accent)" /> +233 20 000 0001</p>
          <p style={styles.contact}><Icon name="mail" size={13} color="var(--accent)" /> hello@kejetiaonline.com</p>
          <p style={styles.contact}><Icon name="map-pin" size={13} color="var(--accent)" /> Kejetia Market, Kumasi</p>
          <p style={styles.contact}>Ashanti Region, Ghana</p>
          <a
            className="ko-btn ko-btn-whatsapp"
            style={styles.waBtn}
            href="https://wa.me/233200000001?text=Hello%20KejetiaOnline!"
            target="_blank"
            rel="noreferrer"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.5 14.4c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.68-1.62-.93-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.5 0 1.47 1.07 2.9 1.22 3.1.15.2 2.1 3.2 5.1 4.49.71.3 1.27.49 1.7.63.72.23 1.37.2 1.88.12.58-.09 1.76-.72 2.01-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z" />
              <path d="M12.05 2a9.9 9.9 0 0 0-8.42 15.1L2 22l5-1.3A9.9 9.9 0 1 0 12.05 2zm0 18.2a8.3 8.3 0 0 1-4.23-1.16l-.3-.18-3.06.8.82-2.99-.2-.32a8.3 8.3 0 1 1 6.97 3.85z" />
            </svg>
            Chat on WhatsApp
          </a>
        </div>
      </div>

      <div style={styles.bottom}>
        <div className="container" style={styles.bottomInner}>
          <p style={styles.copyright}>© {new Date().getFullYear()} KejetiaOnline. All rights reserved.</p>
          <p style={styles.madeWith}>
            Made with <Icon name="heart" size={12} color="#fb7185" /> in Kumasi
          </p>
        </div>
      </div>
    </footer>
  )
}

const styles = {
  footer: {
    background: 'var(--navy)',
    color: 'rgba(226,232,240,0.75)',
    borderTop: '4px solid var(--accent)',
  },

  brandCol: {},
  brand: { display: 'inline-flex', alignItems: 'center', textDecoration: 'none', marginBottom: 16 },
  logo: { height: 42, width: 'auto', display: 'block', borderRadius: 10 },

  tagline: {
    fontSize: 14,
    lineHeight: 1.75,
    color: 'rgba(226,232,240,0.6)',
    maxWidth: 300,
    marginBottom: 20,
  },
  socials: { display: 'flex', gap: 10 },
  social: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.08)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.85)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 14,
    fontWeight: 700,
    cursor: 'default',
    transition: 'all 0.2s ease',
  },
  col: { minWidth: 0 },
  heading: {
    fontSize: 14,
    fontWeight: 800,
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 18,
  },
  link: {
    display: 'block',
    fontSize: 14,
    color: 'rgba(226,232,240,0.65)',
    marginBottom: 11,
    textDecoration: 'none',
    transition: 'color 0.2s ease',
  },
  contact: {
    fontSize: 14,
    color: 'rgba(226,232,240,0.65)',
    marginBottom: 8,
    lineHeight: 1.5,
    display: 'flex',
    alignItems: 'center',
    gap: 9,
  },
  madeWith: {
    fontSize: 13,
    color: 'rgba(226,232,240,0.5)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
  },
  waBtn: {
    marginTop: 10,
    padding: '10px 16px',
    fontSize: 13.5,
    borderRadius: 999,
  },
  bottom: {
    borderTop: '1px solid rgba(255,255,255,0.08)',
    padding: '20px 0',
  },
  bottomInner: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 16,
    flexWrap: 'wrap',
  },
  copyright: { fontSize: 13, color: 'rgba(226,232,240,0.5)' },

}
