'use client'

import { usePathname } from 'next/navigation'
import { useAuth } from '@/context/auth-context'
import { Icon } from '@/components/icons'

// Bottom tab bar shown on phones, matching public/ui-reference.jpeg.
export default function MobileTabBar() {
  const pathname = usePathname()
  const { user, profile } = useAuth()

  const accountHref = !user
    ? '/auth/login'
    : profile?.role === 'seller'
      ? '/dashboard/seller'
      : '/chat'

  const tabs = [
    { label: 'Home', href: '/', icon: 'home' },
    { label: 'Categories', href: '/search', icon: 'shopping-bag' },
    { label: 'Dealers', href: '/search?view=map', icon: 'storefront' },
    { label: 'Deals', href: '/search?q=deals', icon: 'sparkles' },
    { label: 'Account', href: accountHref, icon: 'user' },
  ]

  // Highlight purely on pathname — the two /search variants (map, deals) share
  // the path with Categories, so only Categories lights up there.
  const isActive = (href) => pathname === href.split('?')[0]

  return (
    <nav className="ko-tabbar" aria-label="Primary mobile">
      {tabs.map((t) => (
        <a
          key={t.label}
          href={t.href}
          className={`ko-tab${isActive(t.href) ? ' active' : ''}`}
          aria-current={isActive(t.href) ? 'page' : undefined}
        >
          <span className="ko-tab-ico">
            <Icon name={t.icon} size={20} />
          </span>
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  )
}
