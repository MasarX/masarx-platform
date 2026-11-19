// server.ts — vitest-side MSW node server. Wired up in src/test/setup.ts so
// every test gets the same baseline handlers; per-test overrides go through
// `server.use(...handler)` in the relevant `describe` block.
import { setupServer } from 'msw/node';
import { handlers } from './handlers';

export const server = setupServer(...handlers);
