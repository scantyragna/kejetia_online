import './globals.css'
import './motion.css'
import { AuthProvider } from '@/context/auth-context'
import ModeBanner from '@/components/ModeBanner'
import PageTransition from '@/components/PageTransition'
import SplashScreen from '@/components/SplashScreen'
import MobileTabBar from '@/components/MobileTabBar'

export const metadata = {
  title: 'KEJETIA ONLINE — Find Anything in Kejetia Market',
  description: 'Connect with every shop in Kejetia Market, Kumasi. Search products, compare prices, find stores on the map.',
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <ModeBanner />
          <SplashScreen />
          <PageTransition>
            {children}
          </PageTransition>
          <MobileTabBar />
        </AuthProvider>
      </body>
    </html>
  )
}
