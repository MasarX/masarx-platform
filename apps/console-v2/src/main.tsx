import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { startTelemetry } from './lib/telemetry';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

ReactDOM.createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Start telemetry (web-vitals + opt-in Sentry forwarding) once the app has mounted.
startTelemetry();
