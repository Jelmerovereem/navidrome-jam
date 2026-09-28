import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import UpdatePrompt from './components/UpdatePrompt.jsx'
import { NavidromeProvider } from './contexts/NavidromeContext.jsx'
import { JamProvider } from './contexts/JamContext.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <NavidromeProvider>
        <JamProvider>
          <App />
          <UpdatePrompt />
        </JamProvider>
      </NavidromeProvider>
    </ErrorBoundary>
  </StrictMode>,
)
