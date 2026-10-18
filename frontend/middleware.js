import { NextResponse } from 'next/server'

// Session cookie name — must match lib/auth-server.js
const SESSION_COOKIE = 'kj_session'

export async function middleware(request) {
  // Mock mode (no real backend) has no cookies — let the client-side auth
  // provider handle gating, exactly like the old Supabase-less behavior.
  if (process.env.NEXT_PUBLIC_DB_MODE !== 'postgres') {
    return NextResponse.next({ request })
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value
  const isSignedIn = Boolean(token)

  const protectedPaths = ['/dashboard', '/chat', '/onboarding', '/studio']
  const isProtected = protectedPaths.some((p) =>
    request.nextUrl.pathname.startsWith(p)
  )

  if (isProtected && !isSignedIn) {
    const url = request.nextUrl.clone()
    url.pathname = '/auth/login'
    return NextResponse.redirect(url)
  }

  if (
    isSignedIn &&
    (request.nextUrl.pathname.startsWith('/auth/login') ||
      request.nextUrl.pathname.startsWith('/auth/signup'))
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return NextResponse.next({ request })
}

export const config = {
  matcher: ['/((?!_next/|api/|favicon.ico|logo.svg).*)'],
}