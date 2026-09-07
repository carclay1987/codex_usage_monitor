import React from 'react';
import { createRoot } from 'react-dom/client';
import '../app/globals.css';
import { UsageDashboard } from '../components/usage-dashboard';

const root = document.getElementById('root');

if (!root) throw new Error('Desktop root element not found');

document.body.classList.add('desktop-shell');

createRoot(root).render(
  <React.StrictMode>
    <div className="desktop-titlebar" aria-hidden="true">
      <span>Codex Usage Monitor</span>
    </div>
    <UsageDashboard />
  </React.StrictMode>,
);
