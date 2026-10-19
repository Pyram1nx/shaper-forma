import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-sans-condensed/500.css'
import './styles/tokens.css'
import './styles/components.css'
import './index.css'
import App from './App'
import HomeApp from './home/HomeApp'
import LoadingScreen from './ui/LoadingScreen'

// The home window (?view=home) lists saved designs and the account. Everything else is the studio.
const isHome = new URLSearchParams(window.location.search).get('view') === 'home'

// Temporary: hold the domino loading screen for 5s before revealing the app (test).
function Bootstrap() {
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 5000)
    return () => clearTimeout(t)
  }, [])
  if (loading) return <LoadingScreen />
  return isHome ? <HomeApp /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>,
)
