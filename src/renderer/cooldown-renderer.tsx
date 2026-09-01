import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CooldownPage } from './pages/CooldownPage';
import './styles/global.css';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <CooldownPage />
    </StrictMode>
  );
}
