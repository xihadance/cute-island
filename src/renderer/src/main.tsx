import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './island.css'

if (!window.island) document.body.dataset.surface = 'web'

const root = document.getElementById('root')
if (!root) throw new Error('缺少 #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
)
