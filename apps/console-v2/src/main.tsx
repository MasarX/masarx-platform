import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadConsoleCatalog, readConsoleLocale } from './lib/i18n-catalog';
import { startTelemetry } from './lib/telemetry';
import './styles/index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

const reactRoot = ReactDOM.createRoot(root);

function CatalogLoadFailed({ error }: { error: unknown }): never {
  throw error instanceof Error ? error : new Error(String(error));
}

// The provider reads the catalog synchronously, so the first language loads before
// mounting. A failed load shows the safe error screen; "Try again" reloads the page.
loadConsoleCatalog(readConsoleLocale()).then(
  () =>
    reactRoot.render(
      <StrictMode>
        <App />
      </StrictMode>
    ),
  (error: unknown) =>
    reactRoot.render(
      <ErrorBoundary onReset={() => window.location.reload()}>
        <CatalogLoadFailed error={error} />
      </ErrorBoundary>
    )
);

// Start telemetry (web-vitals + opt-in Sentry forwarding) once the app has mounted.
startTelemetry();
