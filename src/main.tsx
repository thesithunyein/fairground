import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { Boundary } from './App';
import './styles/fairground.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
