import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { startWorkspace } from './data/workspace'
import './styles.css'

// Settings and layouts load from the workspace file before the first render, so the app never
// opens on a default layout and then jumps.
void startWorkspace().then(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
