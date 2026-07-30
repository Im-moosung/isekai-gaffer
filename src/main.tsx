import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// tokens.css는 index.css가 @import로 먼저 끌어온다(토큰 소스 단일화).
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
