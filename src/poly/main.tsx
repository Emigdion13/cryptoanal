import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { PolyApp } from './PolyApp'
import '../styles.css'
import '../phone/phone.css'
import './poly.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PolyApp />
  </StrictMode>,
)
