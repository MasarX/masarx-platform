const {
  parseArgs,
  isStrictEnv,
  requireAbsoluteUrl,
  looksLikeHtml,
  isAuthGatedHtmlSurface,
  splitUrls,
  checkUrlWithRetry,
  run,
} = require('../../../scripts/ops/gates/ui-surface-smoke');

describe('ui-surface-smoke', () => {
  test('parseArgs parses expected flags', () => {
    expect(
      parseArgs([
        '--urls',
        'https://a.example.com,https://b.example.com',
        '--out',
        'tmp/out.json',
        '--timeout-ms',
        '2500',
        '--retries',
        '7',
        '--retry-delay-ms',
        '400',
      ]),
    ).toEqual({
      urls: 'https://a.example.com,https://b.example.com',
      out: 'tmp/out.json',
      timeoutMs: '2500',
      retries: '7',
      retryDelayMs: '400',
      maxAttempts: '',
      retryDelayMs: '400',
    });
  });

  test('parseArgs parses max-attempts retry flags', () => {
    expect(parseArgs(['--max-attempts', '7', '--retry-delay-ms', '4000'])).toEqual({
      urls: '',
      out: '',
      timeoutMs: '',
      retries: '',
      maxAttempts: '7',
      retryDelayMs: '4000',
    });
  });

  test('strict env detection mirrors CI/GitHub Actions', () => {
    expect(isStrictEnv({})).toBe(false);
    expect(isStrictEnv({ CI: 'true' })).toBe(true);
    expect(isStrictEnv({ GITHUB_ACTIONS: '1' })).toBe(true);
  });

  test('requireAbsoluteUrl rejects localhost in strict mode', () => {
    expect(() =>
      requireAbsoluteUrl('https://localhost:3000', 'CONSOLE_BASE_URL', { strict: true }),
    ).toThrow('hosted URL');
    expect(() =>
      requireAbsoluteUrl('https://127.0.0.1:3000', 'CONSOLE_BASE_URL', { strict: true }),
    ).toThrow('hosted URL');
    expect(() =>
      requireAbsoluteUrl('https://console.example.com', 'CONSOLE_BASE_URL', { strict: true }),
    ).not.toThrow();
    expect(() =>
      requireAbsoluteUrl('https://console.example.com/console', 'CONSOLE_BASE_URL', {
        strict: true,
        requireRoot: true,
      }),
    ).toThrow('host-root');
  });

  test('looksLikeHtml accepts html content-type or html body', () => {
    expect(looksLikeHtml({ contentType: 'text/html; charset=utf-8', body: 'ok' })).toBe(true);
    expect(looksLikeHtml({ contentType: '', body: '<!doctype html><html></html>' })).toBe(true);
    expect(looksLikeHtml({ contentType: 'application/json', body: '{"ok":true}' })).toBe(false);
  });

  test('isAuthGatedHtmlSurface only accepts substantial HTML 401/403 responses', () => {
    expect(isAuthGatedHtmlSurface({
      status: 401,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body>sign in</body></html>',
      bytes: 240,
    })).toBe(true);
    expect(isAuthGatedHtmlSurface({
      status: 403,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body>blocked</body></html>',
      bytes: 240,
    })).toBe(true);
    expect(isAuthGatedHtmlSurface({
      status: 401,
      contentType: 'application/json',
      body: '{"error":"unauthorized"}',
      bytes: 32,
    })).toBe(false);
  });

  test('splitUrls splits and trims', () => {
    expect(splitUrls(' https://a, ,https://b ')).toEqual(['https://a', 'https://b']);
  });

  test('run checks default CONSOLE_BASE_URL + PORTAL_BASE_URL', async () => {
    const fetchImpl = async (url) => ({
      status: 200,
      headers: {
        get: (key) => (String(key || '').toLowerCase() === 'content-type' ? 'text/html' : ''),
      },
      text: async () =>
        `<!doctype html><html><body>${url} ok${'x'.repeat(400)}</body></html>`,
    });

    const summary = await run({
      argv: [],
      env: {
        CI: 'true',
        CONSOLE_BASE_URL: 'https://console.example.com',
        PORTAL_BASE_URL: 'https://portal.example.com',
      },
      fetchImpl,
    });

    expect(summary.results.map((r) => r.label)).toEqual(['console', 'portal']);
    expect(summary.results.every((r) => r.ok)).toBe(true);
    expect(summary.retries).toBe(24);
    expect(summary.retry_delay_ms).toBe(5000);
  });

  test('run adds Vercel protection bypass headers for protected preview hosts', async () => {
    const oldBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const oldLegacyBypass = process.env.VERCEL_PROTECTION_BYPASS_SECRET;
    const oldToken = process.env.VERCEL_TOKEN;
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bypass-secret';
    process.env.VERCEL_PROTECTION_BYPASS_SECRET = '';
    process.env.VERCEL_TOKEN = 'ignored-token';

    const seenHeaders = [];
    const fetchImpl = async (url, init) => {
      seenHeaders.push(init && init.headers ? { ...init.headers } : {});
      return {
        status: 200,
        headers: {
          get: (key) => (String(key || '').toLowerCase() === 'content-type' ? 'text/html' : ''),
        },
        text: async () => `<!doctype html><html><body>${url}${'x'.repeat(350)}</body></html>`,
      };
    };

    try {
      await run({
        argv: ['--urls', 'https://wgtvqvlngktphghsguosvjtu.example.invalid'],
        env: { CI: 'true' },
        fetchImpl,
      });
    } finally {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = oldBypass;
      process.env.VERCEL_PROTECTION_BYPASS_SECRET = oldLegacyBypass;
      process.env.VERCEL_TOKEN = oldToken;
    }

    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0]['x-vercel-protection-bypass']).toBe('bypass-secret');
    expect(seenHeaders[0]['x-vercel-set-bypass-cookie']).toBe('true');
    expect(seenHeaders[0].authorization).toBeUndefined();
  });

  test('run falls back to bearer token for Vercel preview when bypass secret is not set', async () => {
    const oldBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const oldLegacyBypass = process.env.VERCEL_PROTECTION_BYPASS_SECRET;
    const oldToken = process.env.VERCEL_TOKEN;
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = '';
    process.env.VERCEL_PROTECTION_BYPASS_SECRET = '';
    process.env.VERCEL_TOKEN = 'vercel-token';

    const seenHeaders = [];
    const fetchImpl = async (url, init) => {
      seenHeaders.push(init && init.headers ? { ...init.headers } : {});
      return {
        status: 200,
        headers: {
          get: (key) => (String(key || '').toLowerCase() === 'content-type' ? 'text/html' : ''),
        },
        text: async () => `<!doctype html><html><body>${url}${'x'.repeat(350)}</body></html>`,
      };
    };

    try {
      await run({
        argv: ['--urls', 'https://kzhoxzzyyvgusxpizwwvmnjt.example.invalid'],
        env: { CI: 'true' },
        fetchImpl,
      });
    } finally {
      process.env.VERCEL_AUTOMATION_BYPASS_SECRET = oldBypass;
      process.env.VERCEL_PROTECTION_BYPASS_SECRET = oldLegacyBypass;
      process.env.VERCEL_TOKEN = oldToken;
    }

    expect(seenHeaders).toHaveLength(1);
    expect(seenHeaders[0].authorization).toBe('Bearer vercel-token');
    expect(seenHeaders[0]['x-vercel-protection-bypass']).toBeUndefined();
  });

  test('run retries transient fetch failures and succeeds within retry budget', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('fetch failed');
      }
      return {
        status: 200,
        headers: {
          get: (key) => (String(key || '').toLowerCase() === 'content-type' ? 'text/html' : ''),
        },
        text: async () => `<!doctype html><html><body>${'x'.repeat(350)}</body></html>`,
      };
    };

    const summary = await run({
      argv: ['--urls', 'https://console.example.com', '--retries', '3', '--retry-delay-ms', '0'],
      env: { CI: 'true' },
      fetchImpl,
    });

    expect(attempts).toBe(3);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].ok).toBe(true);
  });

  test('run accepts redirect-reachable surfaces when fetch follow hits redirect loop', async () => {
    const fetchImpl = async (_url, init = {}) => {
      if (init.redirect === 'follow') {
        throw new Error('fetch failed', { cause: new Error('redirect count exceeded') });
      }
      return {
        status: 302,
        headers: {
          get: (key) => {
            const lower = String(key || '').toLowerCase();
            if (lower === 'location') return '/auth/sign-in';
            if (lower === 'content-type') return 'text/html; charset=utf-8';
            return '';
          },
        },
        text: async () => '',
      };
    };

    const summary = await run({
      argv: ['--urls', 'https://console.example.com', '--retries', '2', '--retry-delay-ms', '0'],
      env: { CI: 'true' },
      fetchImpl,
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].ok).toBe(true);
    expect(summary.results[0].redirect_probe).toBe(true);
    expect(summary.results[0].status).toBe(302);
  });

  test('run accepts auth-gated hosted surfaces that return HTML 401', async () => {
    const fetchImpl = async () => ({
      status: 401,
      headers: {
        get: (key) => (String(key || '').toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : ''),
      },
      text: async () => `<!doctype html><html><body>${'x'.repeat(350)}</body></html>`,
    });

    const summary = await run({
      argv: ['--urls', 'https://console.example.com', '--retries', '2', '--retry-delay-ms', '0'],
      env: { CI: 'true' },
      fetchImpl,
    });

    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].ok).toBe(true);
    expect(summary.results[0].auth_gate).toBe(true);
    expect(summary.results[0].status).toBe(401);
  });

  test('checkUrlWithRetry retries transient failures and succeeds', async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('fetch failed');
      }
      return {
        status: 200,
        headers: {
          get: (key) => (String(key || '').toLowerCase() === 'content-type' ? 'text/html' : ''),
        },
        text: async () => `<!doctype html><html><body>${'x'.repeat(300)}</body></html>`,
      };
    };

    const result = await checkUrlWithRetry({
      label: 'url_1',
      url: 'https://console.example.com',
      timeoutMs: 1000,
      fetchImpl,
      maxAttempts: 4,
      retryDelayMs: 1,
      sleepFn: async () => {},
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(3);
  });

  test('run fails after max attempts for persistent failures', async () => {
    const fetchImpl = async () => {
      throw new Error('fetch failed');
    };

    await expect(
      run({
        argv: [
          '--urls',
          'https://console.example.com',
          '--max-attempts',
          '2',
          '--retry-delay-ms',
          '1',
        ],
        env: {
          CI: 'true',
        },
        fetchImpl,
        sleepFn: async () => {},
      }),
    ).rejects.toThrow('after 2 attempt(s)');
  });
});
