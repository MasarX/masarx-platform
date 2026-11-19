/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');

function loadLandingApp({
  url,
  htmlLang = 'en',
  localStorageLang = '',
  runtime = {},
  fetchImpl = null,
  turnstileImpl = null,
  extraHtml = '',
  beforeLoad = null,
} = {}) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const contentPath = path.join(repoRoot, 'docs', 'marketing', 'landing-v2', 'content.js');
  const appPath = path.join(repoRoot, 'docs', 'marketing', 'landing-v2', 'app.js');

  jest.resetModules();

  document.documentElement.lang = htmlLang;
  document.documentElement.dir = htmlLang === 'ar' ? 'rtl' : 'ltr';
  document.body.innerHTML = `<button type="button" data-lang-toggle>AR</button>${extraHtml}`;

  window.MASARX_RUNTIME = runtime;
  window.MASARX_LANDING = undefined;
  const fetchMock = fetchImpl || jest.fn();
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  if (turnstileImpl) window.turnstile = turnstileImpl;
  else delete window.turnstile;

  window.localStorage.clear();
  if (localStorageLang) window.localStorage.setItem('masarx_lang', localStorageLang);

  window.history.replaceState({}, '', url);

  require(contentPath);
  if (beforeLoad) beforeLoad();
  require(appPath);

  return { fetchMock };
}

const LANDING_CONTACT_ENDPOINT_MOCK = "/__landing-contact";

describe('landing app language routing', () => {


  test('hides only duplicate marquee cards from assistive technology', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({
      ok: true, clients: ['A', 'B', 'C'].map((name) => ({ name, logo_url: null })),
    }) });
    loadLandingApp({ url: 'http://localhost/?motion=on', runtime: { clientsEndpoint: '/clients' },
      fetchImpl: fetchMock, extraHtml: '<div data-clients-row></div>' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cards = [...document.querySelectorAll('.client-ref')];
    expect(cards).toHaveLength(6);
    expect(cards.slice(0, 3).every((card) => !card.hasAttribute('aria-hidden'))).toBe(true);
    expect(cards.slice(3).every((card) => card.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  test.each(['contact', 'tenant'])('shows bounded timeout feedback for %s without resetting identity', async (action) => {
    const fetchMock = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { name: 'AbortError' }));
    loadLandingApp({ url: 'http://localhost/', runtime: { contactEndpoint: '/contact', tenantSignupEndpoint: '/tenant' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    if (action === 'tenant') document.querySelector('[data-tenant-signup-submit]').click();
    else document.querySelector('[data-contact-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = document.querySelector(action === 'tenant' ? '[data-tenant-signup-status]' : '[data-contact-status]');
    expect(status.textContent).toMatch(/timed out/i);
    expect(document.querySelector('[name="email"]').value).toBe('qa@example.test');
  });


  test.each(['case-123', '', '<img src=x onerror=alert(1)>'])('tracks returned case reference safely and clears it on reset: %s', async (caseId) => {
    const fetchMock = jest.fn(async (url) => ({
      ok: true,
      text: async () => JSON.stringify(String(url).endsWith('/lookup')
        ? { ok: true, step: 'verify', verification: { phone_digits: 3 } }
        : String(url).endsWith('/verify')
          ? { ok: true, session_token: 'owned-session', tracking: {
            shipment: { tracking_number: 'MX-1', status: 'in_transit' },
            actions: { reschedule: { enabled: true, available_dates: ['2026-09-08'] } },
          } }
          : { ok: true, outcome: 'pending_review', support_case_id: caseId }),
    }));
    loadLandingApp({ url: 'http://localhost/track/', runtime: { trackingEndpoint: '/tracking', turnstileSiteKey: '' },
      fetchImpl: fetchMock, extraHtml: '<main data-public-tracking-page>'
        + '<section data-track-stage="lookup"><form data-track-lookup-form><input name="reference" value="MX-1"><button type="submit">Lookup</button></form></section>'
        + '<section data-track-stage="verify"><form data-track-verify-form><input name="phone_last3" value="123"><button type="submit">Verify</button></form></section>'
        + '<section data-track-stage="results"><div data-track-request-banner hidden><span data-track-request-banner-badge></span><p data-track-request-banner-text></p><p data-track-request-banner-case hidden></p></div>'
        + '<form data-track-reschedule-form><select name="requested_date" data-track-date-select></select><textarea name="notes"></textarea><button type="submit">Send</button></form>'
        + '<p data-track-reschedule-status></p><button type="button" data-track-reset>Reset</button></section></main>' });
    for (const selector of ['[data-track-lookup-form]', '[data-track-verify-form]']) {
      document.querySelector(selector).dispatchEvent(new Event('submit', { cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    document.querySelector('[data-track-date-select]').value = '2026-09-08';
    document.querySelector('[data-track-reschedule-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const reference = document.querySelector('[data-track-request-banner-case]');
    expect(reference.hidden).toBe(!caseId);
    expect(reference.textContent).toBe(caseId ? ' Reference: ' + caseId : '');
    expect(reference.querySelector('img')).toBeNull();
    document.querySelector('[data-track-stage="lookup"]').scrollIntoView = jest.fn();
    document.querySelector('[data-track-reset]').click();
    expect(reference.hidden).toBe(true);
    expect(reference.textContent).toBe('');
  });


  test.each(['request_id', 'id', 'reference', 'request_reference', 'public_reference'])('preserves direct and nested receipt alias %s without exposing token', async (key) => {
    for (const nested of [false, true]) {
      const reference = { [key]: 'actual-reference', application_status_token: 'not-a-reference' };
      const body = { ok: true, ...(nested ? { result: reference } : reference) };
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(body) });
      loadLandingApp({ url: 'http://localhost/', runtime: { contactEndpoint: '/contact' },
        fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
      document.querySelector('[data-contact-form]').dispatchEvent(new Event('submit', { cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const text = document.querySelector('[data-contact-status]').textContent;
      expect(text).toContain('actual-reference');
      expect(text).not.toContain('not-a-reference');
    }
  });

  test.each([
    [{ queue_status: 'approved' }, 'approved'],
    [{ result: { status: 'rejected' } }, 'rejected'],
    [{ status: 'provisioning' }, 'being provisioned'],
    [{ auto_approve_applied: true }, 'approval was applied'],
  ])('renders returned tenant state without inventing invitation delivery (%j)', async (receipt, expected) => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true,
      text: async () => JSON.stringify({ ok: true, request_id: 'state-reference', ...receipt }) });
    loadLandingApp({ url: 'http://localhost/', runtime: { tenantSignupEndpoint: '/tenant' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    document.querySelector('[data-tenant-signup-submit]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const text = document.querySelector('[data-tenant-signup-status]').textContent;
    expect(text).toContain(expected);
    expect(text).toContain('state-reference');
    expect(text).not.toMatch(/invitation.*sent|invite.*sent/i);
  });

  function sharedIntakeHtml() {
    return '<form data-contact-form><input name="full_name" value="Reviewer" required>'
      + '<input type="email" name="email" value="qa@example.test" required>'
      + '<input name="organization_name" value="QA Org" required>'
      + '<input name="request_context" value="partner_review">'
      + '<input name="website_url" value="https://qa.example.test">'
      + '<button type="submit">Contact</button>'
      + '<button type="button" data-tenant-signup-submit>Tenant signup</button>'
      + '<div data-turnstile></div></form>'
      + '<p data-contact-status></p><p data-tenant-signup-status></p>';
  }

  test.each(['localStorage', 'sessionStorage'])('continues when the %s getter is denied', (kind) => {
    let spy;
    try {
      expect(() => loadLandingApp({
        url: 'http://localhost/track/', extraHtml: '<main data-public-tracking-page></main>',
        beforeLoad: () => { spy = jest.spyOn(window, kind, 'get').mockImplementation(() => { throw new Error('denied'); }); },
      })).not.toThrow();
    } finally { spy?.mockRestore(); }
  });

  test.each(['getItem', 'setItem', 'removeItem'])('continues when storage %s throws', (method) => {
    let spy;
    try {
      expect(() => loadLandingApp({
        url: 'http://localhost/track/', extraHtml: '<main data-public-tracking-page></main>',
        beforeLoad: () => { spy = jest.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('denied'); }); },
      })).not.toThrow();
    } finally { spy?.mockRestore(); }
  });

  test('does not route contact into the tenant endpoint', () => {
    const fetchMock = jest.fn();
    loadLandingApp({ url: 'http://localhost/', runtime: { tenantSignupEndpoint: '/tenant' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    document.querySelector('[data-contact-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fetchMock).not.toHaveBeenCalled();
    // Contact keeps its own missing-endpoint copy; the tenant copy reads "Organization signup ...".
    expect(document.querySelector('[data-contact-status]').textContent)
      .toBe('This form is temporarily unavailable. Please try again later.');
  });

  test.each(['en', 'ar'])('explicit tenant action sends required identity/context and an actual receipt (%s)', async (lang) => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true,
      text: async () => JSON.stringify({ ok: true, request_id: 'tenant-receipt-1', status: 'pending' }) });
    loadLandingApp({ url: 'http://localhost/' + (lang === 'ar' ? 'ar/' : ''),
      htmlLang: lang, runtime: { contactEndpoint: '/contact', tenantSignupEndpoint: '/tenant' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    document.querySelector('[data-tenant-signup-submit]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/tenant');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      email: 'qa@example.test', full_name: 'Reviewer', organization_name: 'QA Org',
      page_url: window.location.href, marketing: { request_context: 'partner_review' },
    });
    const status = document.querySelector('[data-tenant-signup-status]').textContent;
    expect(status).toContain('tenant-receipt-1');
    expect(status).not.toMatch(/invite.*sent/i);
    expect(document.querySelector('[data-contact-status]').textContent).toBe('');
  });

  test.each([
    ['en', 'Something went wrong. Please try again.'],
    ['ar', 'حدث خطأ. رجاءً حاول مرة أخرى.'],
  ])('tenant fails closed on ok:true without a backend reference (%s)', async (lang, message) => {
    const turnstile = {
      render: jest.fn((host, options) => {
        host.innerHTML = '<input type="hidden" name="cf-turnstile-response" value="TENANT-TOKEN" />';
        options.callback('TENANT-TOKEN');
        return 'contact-widget';
      }),
      reset: jest.fn(),
      remove: jest.fn(),
    };
    const fetchMock = jest.fn().mockResolvedValue({ ok: true,
      text: async () => JSON.stringify({ ok: true, request_id: null, reference: '  ', result: { id: '' }, status: 'pending' }) });
    loadLandingApp({ url: 'http://localhost/' + (lang === 'ar' ? 'ar/' : ''), htmlLang: lang,
      runtime: { tenantSignupEndpoint: '/tenant', turnstileSiteKey: '1x00000000000000000000AA' },
      fetchImpl: fetchMock, turnstileImpl: turnstile, extraHtml: sharedIntakeHtml() });
    const edits = { full_name: 'Example Person', email: 'edited@example.test', organization_name: 'Edited Org',
      request_context: 'first_tenant', website_url: 'https://edited.example.test' };
    Object.entries(edits).forEach(([name, value]) => { document.querySelector(`[name="${name}"]`).value = value; });
    document.querySelector('[data-tenant-signup-submit]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const status = document.querySelector('[data-tenant-signup-status]');
    expect(status.textContent).toBe(message);
    expect(status.classList.contains('is-error')).toBe(true);
    expect(status.classList.contains('is-success')).toBe(false);
    expect(document.querySelector('[name="full_name"]').value).toBe('Example Person');
    expect(document.querySelector('[name="email"]').value).toBe('edited@example.test');
    expect(document.querySelector('[name="organization_name"]').value).toBe('Edited Org');
    expect(document.querySelector('[name="request_context"]').value).toBe('first_tenant');
    expect(document.querySelector('[name="website_url"]').value).toBe('https://edited.example.test');
    expect(turnstile.reset).toHaveBeenCalledWith('contact-widget');
    expect(document.querySelector('[data-tenant-signup-submit]').disabled).toBe(false);
    expect(document.querySelector('[name="email"]').disabled).toBe(false);
  });

  test.each([
    ['en', 'Reference: nested-tenant-1'],
    ['ar', 'رقم المرجع: nested-tenant-1'],
  ])('tenant accepts a nested result.id reference (%s)', async (lang, receipt) => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true,
      text: async () => JSON.stringify({ ok: true, request_id: null, result: { id: 'nested-tenant-1' } }) });
    loadLandingApp({ url: 'http://localhost/' + (lang === 'ar' ? 'ar/' : ''), htmlLang: lang,
      runtime: { tenantSignupEndpoint: '/tenant' }, fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    document.querySelector('[name="email"]').value = 'edited@example.test';
    document.querySelector('[data-tenant-signup-submit]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = document.querySelector('[data-tenant-signup-status]');
    expect(status.textContent).toContain(receipt);
    expect(status.classList.contains('is-success')).toBe(true);
    // reset() restores the markup default, proving the accepted path still clears edits.
    expect(document.querySelector('[name="email"]').value).toBe('qa@example.test');
  });

  test('shares one in-flight lock across contact and tenant actions', async () => {
    let settle;
    const fetchMock = jest.fn(() => new Promise((resolve) => { settle = resolve; }));
    loadLandingApp({ url: 'http://localhost/', runtime: { contactEndpoint: '/contact', tenantSignupEndpoint: '/tenant' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    document.querySelector('[data-tenant-signup-submit]').click();
    document.querySelector('[data-contact-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    document.querySelector('[data-tenant-signup-submit]').dispatchEvent(new Event('click'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    settle({ ok: true, text: async () => JSON.stringify({ ok: true, request_id: 'one' }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test.each([
    ['missing endpoint', {}, false],
    ['invalid required input', { tenantSignupEndpoint: '/tenant' }, true],
    ['missing antibot token', { tenantSignupEndpoint: '/tenant', turnstileSiteKey: 'configured-key' }, false],
  ])('tenant action fails before transport for %s', (_name, runtime, invalidate) => {
    const fetchMock = jest.fn();
    loadLandingApp({ url: 'http://localhost/', runtime, fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    if (invalidate) document.querySelector('[name="full_name"]').value = '';
    document.querySelector('[data-tenant-signup-submit]').click();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    [false, { ok: false, error: { code: 'disabled' } }],
    [true, { ok: false, error: { code: 'domain_blocked' } }],
    [true, {}],
    [true, null],
  ])('tenant rejects HTTP/business/malformed acceptance (%s, %j)', async (ok, body) => {
    const fetchMock = jest.fn().mockResolvedValue({ ok, text: async () => JSON.stringify(body) });
    loadLandingApp({ url: 'http://localhost/', runtime: { tenantSignupEndpoint: '/tenant' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    document.querySelector('[data-tenant-signup-submit]').click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-tenant-signup-status]').classList.contains('is-error')).toBe(true);
    expect(document.querySelector('[data-tenant-signup-submit]').disabled).toBe(false);
  });

  test('attribute-token fallback is consumed once and cannot be resurrected by reset', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: true, id: 'contact-1' }) });
    loadLandingApp({ url: 'http://localhost/', runtime: { contactEndpoint: '/contact', turnstileSiteKey: 'configured-key' },
      fetchImpl: fetchMock, extraHtml: sharedIntakeHtml() });
    const host = document.querySelector('[data-turnstile]');
    const input = document.createElement('input');
    input.name = 'cf-turnstile-response'; input.value = ''; input.setAttribute('value', 'single-use-token');
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: '' });
    host.appendChild(input);
    const form = document.querySelector('[data-contact-form]');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).turnstile_token).toBe('single-use-token');
    expect(input.getAttribute('value')).toBeNull();
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('driver apply sets initial focus without taking it back from another field', () => {
    jest.useFakeTimers();
    try {
      loadLandingApp({
        url: 'http://localhost/drivers/apply?motion=off',
        extraHtml: '<section id="drivers"><form data-driver-form>'
          + '<input name="full_name"><input name="email" type="email"></form></section>',
        beforeLoad() {
          document.getElementById('drivers').scrollIntoView = jest.fn();
        },
      });
      const form = document.querySelector('[data-driver-form]');
      const initialFocus = document.activeElement;
      const email = form.elements.namedItem('email');

      email.focus();
      jest.runOnlyPendingTimers();

      expect(document.activeElement).toBe(email);
      expect(initialFocus).toBe(form.elements.namedItem('full_name'));
    } finally {
      jest.useRealTimers();
    }
  });

  test('driver receipt keeps request ID distinct from status token and refreshes actual state', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ ok: true,
      text: async () => JSON.stringify({ ok: true, id: 'driver-request-1', application_status_token: 'private-status-token' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ok: true, status: 'approved' }) });
    loadLandingApp({ url: 'http://localhost/', runtime: { driverSignupEndpoint: '/driver', driverSignupEntryKey: 'fixture-driver-entry', driverApplicationStatusEndpoint: '/status' },
      fetchImpl: fetchMock, extraHtml: '<form data-driver-form><input name="email" value="driver@example.test">'
        + '<input name="full_name" value="Driver"><input name="organization_name" value="Driver Org">'
        + '<button type="submit">Apply</button></form><p data-driver-status></p>'
        + '<form data-driver-status-form><input name="status_token"><button type="submit">Status</button></form><p data-driver-status-lookup></p>' });
    document.querySelector('[data-driver-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(['/driver', '/status']);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).page_url).toBe(window.location.href);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).entry_key).toBe('fixture-driver-entry');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: 'private-status-token' });
    const receipt = document.querySelector('[data-driver-status]').textContent;
    expect(receipt).toContain('driver-request-1');
    expect(receipt).not.toContain('private-status-token');
    expect(receipt).toMatch(/approved/i);
  });


  function driverIdentityHtml() {
    return '<form data-driver-form><input name="email" value="driver@example.test">'
      + '<input name="full_name" value="Driver"><input name="organization_name" value="Driver Org">'
      + '<button type="submit">Apply</button></form><p data-driver-status></p>'
      + '<form data-driver-status-form><input name="status_token" value="old-token">'
      + '<button type="submit">Status</button></form><p data-driver-status-lookup></p>'
      + '<form data-driver-documents-form hidden><div data-driver-documents-fields></div>'
      + '<button type="submit">Documents</button></form><p data-driver-documents-status></p>';
  }

  test.each(['status-first', 'signup-first'])('serializes driver identity operations: %s', async (order) => {
    let finishFirst;
    const response = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const accepted = { ok: true, id: 'new-request', application_status_token: 'new-token' };
    const oldStatus = { ok: true, application_state: 'additional_documents_requested', requested_documents: ['identity'] };
    const fetchMock = jest.fn().mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    if (order === 'status-first') fetchMock.mockResolvedValueOnce(response(accepted));
    fetchMock.mockResolvedValueOnce(response({ ok: true, status: 'approved' }));
    loadLandingApp({ url: 'http://localhost/', runtime: { driverSignupEndpoint: '/driver', driverSignupEntryKey: 'fixture-driver-entry',
      driverApplicationStatusEndpoint: '/status', driverApplicationDocumentsEndpoint: '/documents' },
      fetchImpl: fetchMock, extraHtml: driverIdentityHtml() });
    const signup = document.querySelector('[data-driver-form]');
    const status = document.querySelector('[data-driver-status-form]');
    const documents = document.querySelector('[data-driver-documents-form]');
    const submit = (form) => form.dispatchEvent(new Event('submit', { cancelable: true }));
    submit(order === 'status-first' ? status : signup);
    submit(order === 'status-first' ? signup : status);
    submit(documents);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishFirst(response(order === 'status-first' ? oldStatus : accepted));
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (order === 'status-first') {
      expect(documents.hidden).toBe(false);
      submit(signup);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(order === 'status-first'
      ? ['/status', '/driver', '/status'] : ['/driver', '/status']);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)[1].body)).toEqual({ token: 'new-token' });
    expect(status.elements.status_token.value).toBe('new-token');
    expect(documents.hidden).toBe(true);
    const receipt = document.querySelector('[data-driver-status]').textContent;
    expect(receipt).toContain('new-request');
    expect(receipt).toMatch(/approved/i);
    expect(receipt).not.toMatch(/old-token|new-token/);
  });

  test('serializes signup and status behind an owned document readback', async () => {
    const originalEncoder = global.TextEncoder;
    global.TextEncoder = originalEncoder || require('node:util').TextEncoder;
    try {
    let finishDocuments;
    const response = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    const fetchMock = jest.fn().mockResolvedValueOnce(response({ ok: true,
      application_state: 'additional_documents_requested', requested_documents: ['identity'],
      document_return_attempt: { state: 'reserved', retry_key: 'owned-retry' } }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishDocuments = resolve; }));
    loadLandingApp({ url: 'http://localhost/', runtime: { driverSignupEndpoint: '/driver', driverSignupEntryKey: 'fixture-driver-entry',
      driverApplicationStatusEndpoint: '/status', driverApplicationDocumentsEndpoint: '/documents' },
      fetchImpl: fetchMock, extraHtml: driverIdentityHtml() });
    const submit = (selector) => document.querySelector(selector).dispatchEvent(new Event('submit', { cancelable: true }));
    submit('[data-driver-status-form]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    submit('[data-driver-documents-form]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ token: 'old-token', mode: 'readback', retry_key: 'owned-retry' });
    submit('[data-driver-form]');
    submit('[data-driver-status-form]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finishDocuments(response({ ok: true, application_state: 'documents_resubmitted' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-driver-documents-form]').hidden).toBe(true);
    expect(document.querySelector('[data-driver-status]').textContent).not.toContain('new-request');
    } finally {
      if (originalEncoder === undefined) delete global.TextEncoder;
      else global.TextEncoder = originalEncoder;
    }
  });

  test.each([null, {}, { ok: false }])('driver automatic status rejects malformed or rejected response %p', async (body) => {
    const fetchMock = jest.fn().mockResolvedValueOnce({ ok: true,
      text: async () => JSON.stringify({ ok: true, id: 'accepted-request', application_status_token: 'new-token' }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(body) });
    loadLandingApp({ url: 'http://localhost/', runtime: { driverSignupEndpoint: '/driver', driverSignupEntryKey: 'fixture-driver-entry', driverApplicationStatusEndpoint: '/status' },
      fetchImpl: fetchMock, extraHtml: driverIdentityHtml() });
    document.querySelector('[data-driver-form]').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-driver-status-lookup]').classList.contains('is-error')).toBe(true);
    expect(document.querySelector('[data-driver-documents-form]').hidden).toBe(true);
    expect(document.querySelector('[data-driver-status]').textContent).toContain('accepted-request');
    expect(document.querySelector('[data-driver-status]').textContent).not.toMatch(/approved|new-token/);
  });

  test('defers the Turnstile API until load and appends it exactly once', () => {
    document.querySelectorAll('script[data-turnstile-api]').forEach((script) => script.remove());
    const readyState = jest.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
    try {
      loadLandingApp({
        url: 'http://localhost/',
        runtime: { turnstileSiteKey: '1x00000000000000000000AA' },
        extraHtml: [
          '<form data-contact-form>',
          '  <div data-turnstile></div>',
          '</form>',
        ].join(''),
      });

      expect(document.querySelector('script[data-turnstile-api]')).toBeNull();
      readyState.mockReturnValue('complete');
      window.dispatchEvent(new Event('load'));
      window.dispatchEvent(new Event('load'));

      const scripts = document.querySelectorAll('script[data-turnstile-api]');
      expect(scripts).toHaveLength(1);
      expect(scripts[0].src).toBe(
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      );
      expect(scripts[0].async).toBe(true);
      expect(scripts[0].defer).toBe(true);
    } finally {
      readyState.mockRestore();
      document.querySelectorAll('script[data-turnstile-api]').forEach((script) => script.remove());
    }
  });
  test('capture spec targets the current V2 organization field only', () => {
    const captureSource = fs.readFileSync(
      path.resolve(__dirname, '..', 'landing-e2e', 'landing-contact-state-capture.spec.ts'),
      'utf8',
    );

    expect(captureSource).toContain('input[name="organization_name"]');
    expect(captureSource).not.toContain('input[name="company"]');
  });

  test.each([
    ['configured', 2_500, 2_500],
    ['minimum boundary', 1, 1_000],
    ['maximum boundary', 120_000, 60_000],
    ['invalid fallback', 'invalid', 15_000],
  ])('resolves the shared public request timeout from runtime config: %s', (_label, configured, expected) => {
    jest.useFakeTimers();
    const setTimeoutSpy = jest.spyOn(window, 'setTimeout');
    try {
      const fetchMock = jest.fn(() => new Promise(() => {}));
      loadLandingApp({
        url: 'http://localhost/',
        htmlLang: 'en',
        runtime: {
          contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
          publicRequestTimeoutMs: configured,
        },
        fetchImpl: fetchMock,
        extraHtml: [
          '<form data-contact-form>',
          '  <input type="text" name="full_name" value="Landing Reviewer" required />',
          '  <input type="email" name="email" value="lhwmilsokgrmgptsihhuoljt@example.invalid" required />',
          '  <input type="text" name="organization_name" value="MasarX" required />',
          '  <button type="submit">Submit</button>',
          '</form>',
          '<p data-contact-status></p>',
        ].join(''),
      });

      document.querySelector('[data-contact-form]').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls.some((call) => call[1] === expected)).toBe(true);
    } finally {
      jest.clearAllTimers();
      setTimeoutSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('aborts and releases an active tracking request when the page navigates away', () => {
    let requestSignal = null;
    const fetchMock = jest.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    });
    loadLandingApp({
      url: 'http://localhost/track/',
      htmlLang: 'en',
      runtime: {
        trackingEndpoint: '/__landing-tracking',
        turnstileSiteKey: '',
      },
      fetchImpl: fetchMock,
      extraHtml: [
        '<main data-public-tracking-page>',
        '  <section data-track-stage="lookup">',
        '    <form data-track-lookup-form>',
        '      <input name="reference" value="TRK-2026-0001" required />',
        '      <button type="submit">Continue</button>',
        '    </form>',
        '    <p data-track-lookup-status></p>',
        '  </section>',
        '  <section data-track-stage="verify" hidden>',
        '    <form data-track-verify-form><input name="phone_last3" /></form>',
        '    <p data-track-verify-status></p>',
        '  </section>',
        '  <section data-track-stage="results" hidden></section>',
        '  <div data-turnstile></div>',
        '</main>',
      ].join(''),
    });

    const form = document.querySelector('[data-track-lookup-form]');
    const button = form.querySelector('button[type="submit"]');
    const status = document.querySelector('[data-track-lookup-status]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(requestSignal?.aborted).toBe(false);
    expect(status.textContent).toContain('Working on your request');

    window.dispatchEvent(new Event('pagehide'));

    expect(requestSignal?.aborted).toBe(true);
    expect(button.disabled).toBe(false);
    expect(status.textContent).toBe('');
  });

  test('clears owned loading state before language navigation supersedes a tracking request', () => {
    let requestSignal = null;
    const navigate = jest.fn();
    const fetchMock = jest.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    });
    loadLandingApp({
      url: 'http://localhost/track/',
      htmlLang: 'en',
      runtime: {
        navigate,
        trackingEndpoint: '/__landing-tracking',
        turnstileSiteKey: '',
      },
      fetchImpl: fetchMock,
      extraHtml: [
        '<main data-public-tracking-page>',
        '  <section data-track-stage="lookup">',
        '    <form data-track-lookup-form>',
        '      <input name="reference" value="TRK-2026-0001" required />',
        '      <button type="submit">Continue</button>',
        '    </form>',
        '    <p data-track-lookup-status></p>',
        '  </section>',
        '  <section data-track-stage="verify" hidden></section>',
        '  <section data-track-stage="results" hidden></section>',
        '  <div data-turnstile></div>',
        '</main>',
      ].join(''),
    });

    const form = document.querySelector('[data-track-lookup-form]');
    const status = document.querySelector('[data-track-lookup-status]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(status.textContent).toContain('Working on your request');

    document.querySelector('[data-lang-toggle]').click();

    expect(requestSignal?.aborted).toBe(true);
    expect(status.textContent).toBe('');
    expect(navigate).toHaveBeenCalledWith('/ar/track/');
  });

  test('a late superseded completion cannot erase the newest request status', async () => {
    let resolveFirst;
    let resolveSecond;
    let markFirstBodyRead;
    let markSecondBodyRead;
    const firstResponse = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const secondResponse = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    const firstBodyRead = new Promise((resolve) => {
      markFirstBodyRead = resolve;
    });
    const secondBodyRead = new Promise((resolve) => {
      markSecondBodyRead = resolve;
    });
    const fetchMock = jest.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockImplementationOnce(() => secondResponse);
    loadLandingApp({
      url: 'http://localhost/track/',
      htmlLang: 'en',
      runtime: {
        trackingEndpoint: '/__landing-tracking',
        turnstileSiteKey: '',
      },
      fetchImpl: fetchMock,
      extraHtml: [
        '<main data-public-tracking-page>',
        '  <section data-track-stage="lookup">',
        '    <form data-track-lookup-form>',
        '      <input name="reference" required />',
        '      <button type="submit">Continue</button>',
        '    </form>',
        '    <p data-track-lookup-status></p>',
        '  </section>',
        '  <section data-track-stage="verify" hidden></section>',
        '  <section data-track-stage="results" hidden></section>',
        '  <div data-turnstile></div>',
        '</main>',
      ].join(''),
    });

    const form = document.querySelector('[data-track-lookup-form]');
    const input = form.querySelector('input[name="reference"]');
    const status = document.querySelector('[data-track-lookup-status]');
    input.value = 'TRK-2026-0001';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(status.textContent).toContain('Working on your request');

    input.value = 'TRK-2026-0002';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(status.textContent).toBe('');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(status.textContent).toContain('Working on your request');

    const waitForStatus = (expected) => {
      if (status.textContent.includes(expected)) return Promise.resolve();
      return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
          if (!status.textContent.includes(expected)) return;
          observer.disconnect();
          resolve();
        });
        observer.observe(status, { childList: true, characterData: true, subtree: true });
      });
    };

    resolveFirst({
      ok: true,
      text: () => {
        markFirstBodyRead();
        return Promise.resolve(JSON.stringify({ ok: true, step: 'verify' }));
      },
    });
    await firstBodyRead;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(status.textContent).toContain('Working on your request');

    const newestTerminalStatus = waitForStatus('Too many attempts');
    resolveSecond({
      ok: false,
      text: () => {
        markSecondBodyRead();
        return Promise.resolve(JSON.stringify({ ok: false, error: { code: 'rate_limited' } }));
      },
    });
    await Promise.all([secondBodyRead, newestTerminalStatus]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status.textContent).toContain('Too many attempts');
  });

  test('does not reuse a consumed tracking Turnstile token after supersession', () => {
    const turnstile = {
      render: jest.fn((host, options) => {
        host.innerHTML = '<input type="hidden" name="cf-turnstile-response" value="TRACKING-TOKEN-1" />';
        options.callback('TRACKING-TOKEN-1');
        return 'tracking-widget';
      }),
      reset: jest.fn(),
      remove: jest.fn(),
    };
    let requestSignal = null;
    const fetchMock = jest.fn((_url, options) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    });
    loadLandingApp({
      url: 'http://localhost/track/',
      htmlLang: 'en',
      runtime: {
        trackingEndpoint: '/__landing-tracking',
        turnstileSiteKey: '1x00000000000000000000AA',
      },
      fetchImpl: fetchMock,
      turnstileImpl: turnstile,
      extraHtml: [
        '<main data-public-tracking-page>',
        '  <section data-track-stage="lookup">',
        '    <form data-track-lookup-form>',
        '      <input name="reference" value="TRK-2026-0001" required />',
        '      <button type="submit">Continue</button>',
        '    </form>',
        '    <p data-track-lookup-status></p>',
        '  </section>',
        '  <section data-track-stage="verify" hidden></section>',
        '  <section data-track-stage="results" hidden></section>',
        '  <div data-turnstile></div>',
        '</main>',
      ].join(''),
    });

    const form = document.querySelector('[data-track-lookup-form]');
    const input = form.querySelector('input[name="reference"]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);

    input.value = 'TRK-2026-0002';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(requestSignal?.aborted).toBe(true);
    expect(turnstile.reset).toHaveBeenCalledWith('tracking-widget');
    expect(document.querySelector('[data-turnstile] input').value).toBe('');

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-track-lookup-status]').textContent).toContain('anti-spam check');
  });

  test('resets only the Turnstile widget whose token reached the network', async () => {
    const widgetTokens = {
      contact: 'CONTACT-TOKEN',
      driver: 'DRIVER-TOKEN',
    };
    const turnstile = {
      render: jest.fn((host, options) => {
        const key = host.hasAttribute('data-driver-turnstile') ? 'driver' : 'contact';
        const token = widgetTokens[key];
        host.innerHTML = `<input type="hidden" name="cf-turnstile-response" value="${token}" />`;
        options.callback(token);
        return `${key}-widget`;
      }),
      reset: jest.fn(),
      remove: jest.fn(),
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      text: jest.fn().mockResolvedValue(JSON.stringify({ ok: false, error: { code: 'rate_limited' } })),
    });
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: {
        contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK,
        driverSignupEndpoint: '/__driver-signup',
        driverSignupEntryKey: 'fixture-driver-entry',
        turnstileSiteKey: '1x00000000000000000000AA',
      },
      fetchImpl: fetchMock,
      turnstileImpl: turnstile,
      extraHtml: [
        '<form data-contact-form>',
        '  <input name="full_name" value="Landing Reviewer" required />',
        '  <input name="email" type="email" value="reviewer@example.com" required />',
        '  <input name="organization_name" value="MasarX" required />',
        '  <div data-turnstile></div>',
        '  <button type="submit">Submit contact</button>',
        '</form>',
        '<p data-contact-status></p>',
        '<form data-driver-form>',
        '  <input name="full_name" value="Driver Reviewer" required />',
        '  <input name="email" type="email" value="driver@example.com" required />',
        '  <div data-driver-turnstile></div>',
        '  <button type="submit">Submit driver</button>',
        '</form>',
        '<p data-driver-status></p>',
      ].join(''),
    });

    document.querySelector('[data-contact-form]').dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true })
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(turnstile.reset).toHaveBeenCalledTimes(1);
    expect(turnstile.reset).toHaveBeenCalledWith('contact-widget');
    expect(document.querySelector('[data-turnstile] input').value).toBe('');
    expect(document.querySelector('[data-driver-turnstile] input').value).toBe('DRIVER-TOKEN');
  });

  test('prefers URL path over localStorage for initial lang', () => {
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      localStorageLang: 'ar',
    });

    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });

  test('language toggle navigates between / and /ar/', () => {
    const navigate = jest.fn();

    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      localStorageLang: '',
      runtime: { navigate },
    });

    document.querySelector('[data-lang-toggle]').click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toBe('/ar/');
  });

  test('language toggle preserves runtime site base path', () => {
    const navigate = jest.fn();

    loadLandingApp({
      url: 'http://localhost/landing/?utm_source=test',
      htmlLang: 'en',
      localStorageLang: '',
      runtime: {
        navigate,
        siteUrl: 'https://example.com/landing',
      },
    });

    document.querySelector('[data-lang-toggle]').click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate.mock.calls[0][0]).toBe('/landing/ar/?utm_source=test');
  });

  test('lang query param redirects to matching path', () => {
    const replace = jest.fn();

    loadLandingApp({
      url: 'http://localhost/ar/?lang=en&utm_source=test',
      htmlLang: 'ar',
      localStorageLang: '',
      runtime: { replace },
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe('/?utm_source=test');
  });

  test('lang query param redirect preserves runtime site base path', () => {
    const replace = jest.fn();

    loadLandingApp({
      url: 'http://localhost/landing/ar/?lang=en&utm_source=test',
      htmlLang: 'ar',
      localStorageLang: '',
      runtime: {
        replace,
        siteUrl: 'https://example.com/landing',
      },
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toBe('/landing/?utm_source=test');
  });

  test('replaces broken client logos with an accessible fallback label', () => {
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      extraHtml: '<img class="client-logo" data-fallback="MasarX" alt="MasarX logo" src="/missing-logo.png" />',
    });

    const logo = document.querySelector('img.client-logo');
    expect(logo).not.toBeNull();
    logo.dispatchEvent(new Event('error'));

    const fallback = document.querySelector('.client-logo-fallback');
    expect(fallback).not.toBeNull();
    expect(fallback.textContent).toBe('MasarX');
    expect(fallback.getAttribute('aria-label')).toBe('MasarX logo');
  });

  test('localizes monthly volume select options', () => {
    loadLandingApp({
      url: 'http://localhost/ar/',
      htmlLang: 'ar',
      extraHtml: '<select><option data-i18n="form_volume_opt_choose">Select monthly volume</option></select>',
    });

    expect(document.querySelector('option').textContent).toBe('اختر حجم الشحنات الشهري');
  });

  test('loads dynamic client references and falls back to name when logo is missing', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({
        ok: true,
        clients: [
          { name: 'MasarX', logo_url: 'https://cdn.example/masarx.svg' },
          { name: 'No Logo Client', logo_url: null },
        ],
      }),
    });

    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: { clientsEndpoint: '/api/clients' },
      fetchImpl: fetchMock,
      extraHtml: '<div data-clients-row></div>',
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.client-ref').length).toBe(2);
    expect(document.querySelector('img.client-logo')?.getAttribute('src')).toBe('https://cdn.example/masarx.svg');
    expect(document.querySelector('.client-logo-fallback')?.textContent).toBe('No Logo Client');
  });

  test('contact form blocks submit when runtime endpoint is unset', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    });

    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      fetchImpl: fetchMock,
      extraHtml: [
        '<form data-contact-form>',
        '  <input type="text" name="full_name" value="Landing Reviewer" required />',
        '  <input type="email" name="email" value="lhwmilsokgrmgptsihhuoljt@example.invalid" required />',
        '  <input type="text" name="organization_name" value="MasarX" required />',
        '  <button type="submit">Submit</button>',
        '</form>',
        '<p data-contact-status></p>',
      ].join(''),
    });

    const form = document.querySelector('[data-contact-form]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-contact-status]').textContent).toBe('This form is temporarily unavailable. Please try again later.');
  });

  test('prefers contact endpoint over tenant signup endpoint for contact form submit', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    });

    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: {
        contactEndpoint: '/contact-intake',
        tenantSignupEndpoint: '/tenant-signup-intake',
      },
      fetchImpl: fetchMock,
      extraHtml: [
        '<form data-contact-form>',
        '  <input type="text" name="full_name" value="Landing Reviewer" required />',
        '  <input type="email" name="email" value="lhwmilsokgrmgptsihhuoljt@example.invalid" required />',
        '  <input type="text" name="organization_name" value="MasarX" required />',
        '  <button type="submit">Submit</button>',
        '</form>',
        '<p data-contact-status></p>',
      ].join(''),
    });

    const form = document.querySelector('[data-contact-form]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/contact-intake');
  });

  test('the actual contact form POST is accepted by its distinct Example Person route', async () => {
    jest.doMock('../../scripts/utils/load-env', () => ({ loadEnv: jest.fn() }));
    const { Readable } = require('node:stream');
    const { handleLocalIntakeMock } = require('../../scripts/frontend/serve-landing');
    const fetchMock = jest.fn(async (url, options) => {
      const req = Readable.from([Buffer.from(options.body)]);
      Object.assign(req, { url, method: options.method, headers: { ...options.headers, host: 'localhost' } });
      const res = { writeHead: jest.fn(), end: jest.fn() };
      expect(await handleLocalIntakeMock(req, res, { enabled: true, siteUrl: 'http://localhost' })).toBe(true);
      expect(res.writeHead.mock.calls[0][0]).toBe(200);
      return { ok: true, text: async () => res.end.mock.calls[0][0] };
    });
    loadLandingApp({
      url: 'http://localhost/',
      runtime: { contactEndpoint: '/__landing-contact', tenantSignupEndpoint: '/__tenant-signup' },
      fetchImpl: fetchMock,
      extraHtml: '<form data-contact-form><input name="email" type="email" value="local@example.test" required /><input name="organization_name" value="Example" required /><button type="submit">Send</button></form><p data-contact-status></p>',
    });
    document.querySelector('[data-contact-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledWith('/__landing-contact', expect.objectContaining({ method: 'POST', credentials: 'omit' }));
    expect(document.querySelector('[data-contact-status]').classList.contains('is-success')).toBe(true);
  });

  test('includes company payload derived from organization_name for contact intake compatibility', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ ok: true }),
    });

    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: { contactEndpoint: '/contact-intake' },
      fetchImpl: fetchMock,
      extraHtml: [
        '<form data-contact-form>',
        '  <input type="text" name="full_name" value="Landing Reviewer" required />',
        '  <input type="email" name="email" value="lhwmilsokgrmgptsihhuoljt@example.invalid" required />',
        '  <input type="text" name="organization_name" value="MasarX Logistics" required />',
        '  <button type="submit">Submit</button>',
        '</form>',
        '<p data-contact-status></p>',
      ].join(''),
    });

    const form = document.querySelector('[data-contact-form]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body || '{}'));
    expect(payload.company).toBe('MasarX Logistics');
    expect(payload.organization_name).toBe('MasarX Logistics');
  });

  test('blocks submit when turnstile is required but missing token', () => {
    const fetchMock = jest.fn();

    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: { contactEndpoint: LANDING_CONTACT_ENDPOINT_MOCK, turnstileSiteKey: '0x4AAAAAAA' },
      fetchImpl: fetchMock,
      extraHtml: [
        '<form data-contact-form>',
        '  <input type="text" name="full_name" value="Landing Reviewer" required />',
        '  <input type="email" name="email" value="lhwmilsokgrmgptsihhuoljt@example.invalid" required />',
        '  <input type="text" name="organization_name" value="MasarX" required />',
        '  <div data-turnstile></div>',
        '  <button type="submit">Submit</button>',
        '</form>',
        '<p data-contact-status></p>',
      ].join(''),
    });

    const form = document.querySelector('[data-contact-form]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(document.querySelector('[data-contact-status]').textContent).toBe('Please complete the anti-spam check.');
  });

  test('hides runtime app links when appUrl is unset', () => {
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: {},
      extraHtml: '<a href="#" data-runtime-href="appUrl" data-i18n="cta_login">Log in</a>',
    });

    const link = document.querySelector('[data-runtime-href="appUrl"]');
    expect(link.getAttribute('href')).toBe('#');
    expect(link.style.display).toBe('none');
  });

  test('applies runtime appUrl to login CTA when configured', () => {
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: { appUrl: 'https://app.example.com/login' },
      extraHtml: '<a href="#" data-runtime-href="appUrl" data-i18n="cta_login">Log in</a>',
    });

    const link = document.querySelector('[data-runtime-href="appUrl"]');
    expect(link.getAttribute('href')).toBe('https://app.example.com/login');
    expect(link.style.display).not.toBe('none');
  });

  test('hides runtime docs links when docsUrl is unset', () => {
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: {},
      extraHtml: '<a href="#" data-runtime-href="docsUrl" data-i18n="footer_docs">Docs</a>',
    });

    const link = document.querySelector('[data-runtime-href="docsUrl"]');
    expect(link.getAttribute('href')).toBe('#');
    expect(link.style.display).toBe('none');
  });

  test('applies runtime docsUrl when configured', () => {
    loadLandingApp({
      url: 'http://localhost/',
      htmlLang: 'en',
      runtime: { docsUrl: 'https://docs.example.com' },
      extraHtml: '<a href="#" data-runtime-href="docsUrl" data-i18n="footer_docs">Docs</a>',
    });

    const link = document.querySelector('[data-runtime-href="docsUrl"]');
    expect(link.getAttribute('href')).toBe('https://docs.example.com');
    expect(link.style.display).not.toBe('none');
  });

  test.each([
    ['/contact?campaign=one#contact', '', 'en', '/contact/clients?locale=en'],
    ['/contact/#contact', '', 'ar', '/contact/clients?locale=ar'],
    ['/contact?campaign=one', '/feed?campaign=two#clients', 'en', '/feed?campaign=two&locale=en'],
    ['/contact', '/feed?locale=ar', 'en', '/feed?locale=ar'],
  ])('joins derived feed paths before query/fragment without rewriting explicit feeds (%s, %s, %s)',
    (contactEndpoint, clientsEndpoint, lang, expected) => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ ok: true, clients: [] }),
      });
      loadLandingApp({
        url: `http://localhost/${lang === 'ar' ? 'ar/' : ''}`,
        runtime: { contactEndpoint, clientsEndpoint },
        fetchImpl: fetchMock,
        extraHtml: '<div data-clients-row></div>',
      });
      expect(fetchMock.mock.calls[0][0]).toBe(expected);
    });

  test.each(['en', 'ar'])('renders only the public reviewer note as text and clears stale results (%s)', async (lang) => {
    let resolveNext;
    const note = '<img src=x onerror="alert(1)"> Please renew your license.';
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({
        ok: true, status: 'reverification_required', review_reason: note,
        internal_note: 'PRIVATE STAFF NOTE',
      }) })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }));
    loadLandingApp({
      url: `http://localhost/${lang === 'ar' ? 'ar/' : ''}`,
      runtime: { driverApplicationStatusEndpoint: '/driver-status' },
      fetchImpl: fetchMock,
      extraHtml: [
        '<form data-driver-status-form>',
        '<input name="status_token" value="PUBLIC-TOKEN" required>',
        '<button type="submit">Check status</button></form>',
        '<p data-driver-status-lookup></p>',
        '<p data-driver-review-note hidden></p>',
      ].join(''),
    });
    const form = document.querySelector('[data-driver-status-form]');
    const noteNode = document.querySelector('[data-driver-review-note]');
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(noteNode.hidden).toBe(false);
    expect(noteNode.textContent).toBe(`${lang === 'ar' ? 'ملاحظة المراجع' : 'Reviewer note'}: ${note}`);
    expect(noteNode.querySelector('img')).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE STAFF NOTE');

    submit();
    expect(noteNode.hidden).toBe(true);
    expect(noteNode.textContent).toBe('');
    resolveNext({ ok: false, text: async () => JSON.stringify({
      error: { code: 'not_found' }, review_reason: 'MUST NOT DISPLAY',
    }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(noteNode.hidden).toBe(true);
    expect(noteNode.textContent).toBe('');
  });

  test.each([
    ['input', new Event('input', { bubbles: true })],
    ['reset', new Event('reset', { bubbles: true })],
  ])('clears the public reviewer note on form %s', async (_name, event) => {
    loadLandingApp({
      url: 'http://localhost/',
      runtime: { driverApplicationStatusEndpoint: '/driver-status' },
      fetchImpl: jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({
        ok: true, status: 'pending', review_reason: 'Please update the application.',
      }) }),
      extraHtml: '<form data-driver-status-form><input name="status_token" value="TOKEN" required><button type="submit">Check</button></form><p data-driver-status-lookup></p><p data-driver-review-note hidden></p>',
    });
    const form = document.querySelector('[data-driver-status-form]');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-driver-review-note]').hidden).toBe(false);
    form.dispatchEvent(event);
    expect(document.querySelector('[data-driver-review-note]').hidden).toBe(true);
  });

  test.each(['input', 'reset', 'token-change'])('ignores a late old-token status/note after pending %s', async (change) => {
    let resolveOld;
    const fetchMock = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({
        ok: true, status: 'pending', review_reason: 'Current application note',
      }) });
    loadLandingApp({
      url: 'http://localhost/',
      runtime: { driverApplicationStatusEndpoint: '/driver-status' },
      fetchImpl: fetchMock,
      extraHtml: '<form data-driver-status-form><input name="status_token" value="OLD-TOKEN" required><button type="submit">Check</button></form><p data-driver-status-lookup></p><p data-driver-review-note hidden></p>',
    });
    const form = document.querySelector('[data-driver-status-form]');
    const input = form.querySelector('input');
    const submit = () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    submit();
    expect(input.disabled).toBe(true);
    if (change === 'token-change') input.value = 'NEW-TOKEN';
    else form.dispatchEvent(new Event(change, { bubbles: true }));
    resolveOld({ ok: true, text: async () => JSON.stringify({
      ok: true, status: 'rejected', review_reason: 'STALE APPLICATION NOTE',
    }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-driver-review-note]').hidden).toBe(true);
    expect(document.body.textContent).not.toContain('STALE APPLICATION NOTE');
    expect(document.querySelector('[data-driver-status-lookup]').textContent).not.toContain('rejected');
    if (change !== 'token-change') expect(document.querySelector('[data-driver-status-lookup]').textContent).toBe('');
    expect(input.disabled).toBe(false);
    input.value = 'NEW-TOKEN';
    submit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('[data-driver-review-note]').textContent).toContain('Current application note');
  });

  test('does not override an anchor action that was already prevented by its owner', () => {
    const scroll = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      loadLandingApp({ url: 'http://localhost/', extraHtml: '<a href="#owned">Owned action</a><section id="owned"></section>' });
      const link = document.querySelector('a');
      link.addEventListener('click', (event) => event.preventDefault());
      link.click();
      expect(scroll).not.toHaveBeenCalled();
      expect(window.location.hash).toBe('');
    } finally {
      scroll.mockRestore();
    }
  });

  test.each([[false, 'smooth'], [true, 'auto']])('tracking reset focuses synchronously with reduced motion %s', (reducedMotion, behavior) => {
    jest.useFakeTimers();
    const originalMatchMedia = window.matchMedia;
    const originalMotion = document.documentElement.getAttribute('data-motion');
    window.matchMedia = (query) => ({ matches: reducedMotion && query === '(prefers-reduced-motion: reduce)' });
    document.documentElement.removeAttribute('data-motion');
    window.sessionStorage.clear();
    try {
      let offsetAtScroll;
      let focusAtScroll;
      const scrollIntoView = jest.fn(() => {
        offsetAtScroll = document.documentElement.style.getPropertyValue('--scroll-offset');
        focusAtScroll = document.activeElement;
      });
      loadLandingApp({
        url: 'http://localhost/track/',
        extraHtml: '<header class="header"></header><main data-public-tracking-page>'
          + '<section data-track-stage="lookup"><form data-track-lookup-form>'
          + '<input name="reference" value="REF"></form></section>'
          + '<button type="button" data-track-reset>Reset</button><button type="button" id="next">Next</button></main>',
        beforeLoad() {
          Object.defineProperty(document.querySelector('.header'), 'offsetHeight', { value: 64 });
          document.querySelector('[data-track-stage="lookup"]').scrollIntoView = scrollIntoView;
        },
      });
      const reference = document.querySelector('[name="reference"]');
      const reset = document.querySelector('[data-track-reset]');
      const next = document.getElementById('next');
      reset.focus();
      reset.click();
      const focusAfterReset = document.activeElement;
      const selectionAfterReset = [reference.selectionStart, reference.selectionEnd];

      next.focus();
      jest.runOnlyPendingTimers();

      expect(document.activeElement).toBe(next);
      expect(focusAfterReset).toBe(reference);
      expect(selectionAfterReset).toEqual([0, reference.value.length]);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior, block: 'start' });
      expect(offsetAtScroll).toBe('80px');
      expect(focusAtScroll).toBe(reset);
    } finally {
      window.matchMedia = originalMatchMedia;
      if (originalMotion === null) document.documentElement.removeAttribute('data-motion');
      else document.documentElement.setAttribute('data-motion', originalMotion);
      jest.useRealTimers();
    }
  });

  test.each(['en', 'ar'])('Requests links follow lookup, verify, back, results and reset (%s)', async (lang) => {
    window.sessionStorage.clear();
    const scroll = jest.spyOn(window, 'scrollTo').mockImplementation(() => {});
    try {
      loadLandingApp({
        url: `http://localhost/${lang === 'ar' ? 'ar/' : ''}track/`,
        runtime: { trackingEndpoint: '/track' },
        fetchImpl: jest.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify({
          ok: true, session_token: 'SESSION', tracking: {},
        }) }),
        extraHtml: [
          '<a href="#lookup" data-track-requests-link data-i18n="track_nav_lookup">Lookup</a>',
          '<main data-public-tracking-page>',
          '<section id="lookup" data-track-stage="lookup"><form data-track-lookup-form><input name="reference" value="REF" required><button type="submit">Lookup</button></form><p data-track-lookup-status></p></section>',
          '<section data-track-stage="verify" hidden><form data-track-verify-form><input name="phone_last3" value="123" required><button type="submit">Verify</button></form><p data-track-verify-status></p><button data-track-back>Back</button></section>',
          '<section data-track-stage="results" hidden><section id="actions"></section></section>',
          '<a href="#lookup" data-track-reset>Reset</a>',
          '<a href="#lookup" data-track-requests-link data-i18n="track_nav_lookup">Lookup</a></main>',
        ].join(''),
      });
      const lookup = document.querySelector('[data-track-stage="lookup"]');
      lookup.scrollIntoView = jest.fn();
      const expectLinks = (results) => {
        document.querySelectorAll('[data-track-requests-link]').forEach((link) => {
          expect(link.getAttribute('href')).toBe(results ? '#actions' : '#lookup');
          expect(link.textContent).toBe(window.MASARX_LANDING.i18n[results ? 'track_nav_actions' : 'track_nav_lookup'][lang]);
        });
      };
      const submit = async (selector) => {
        document.querySelector(selector).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      };
      expectLinks(false);
      await submit('[data-track-lookup-form]');
      expect(document.querySelector('[data-track-stage="verify"]').hidden).toBe(false);
      expectLinks(false);
      document.querySelector('[data-track-back]').click();
      expect(document.querySelector('[data-track-stage="lookup"]').hidden).toBe(false);
      expectLinks(false);
      await submit('[data-track-lookup-form]');
      document.querySelector('[data-track-requests-link]').click();
      expect(document.querySelector('[data-track-stage="lookup"]').hidden).toBe(false);
      await submit('[data-track-lookup-form]');
      await submit('[data-track-verify-form]');
      expectLinks(true);
      expect(document.querySelector('[data-track-stage="results"]').hidden).toBe(false);
      document.querySelector('[data-track-reset]').click();
      expectLinks(false);
      expect(document.querySelector('[data-track-stage="lookup"]').hidden).toBe(false);
      expect(lookup.scrollIntoView).toHaveBeenCalledWith({ behavior: expect.any(String), block: 'start' });
    } finally {
      scroll.mockRestore();
      window.sessionStorage.clear();
    }
  });

  test('native fragment and scrollIntoView offsets track the actual responsive header height', () => {
    let height = 120;
    let observeResize;
    const originalObserver = window.ResizeObserver;
    const getter = jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function () { return this.classList.contains('header') ? height : 0; });
    window.ResizeObserver = class {
      constructor(callback) { observeResize = callback; }
      observe() {}
    };
    try {
      loadLandingApp({ url: 'http://localhost/#drivers', extraHtml: '<header class="header"></header>' });
      expect(document.documentElement.style.getPropertyValue('--scroll-offset')).toBe('136px');
      height = 160;
      observeResize();
      expect(document.documentElement.style.getPropertyValue('--scroll-offset')).toBe('176px');
      height = 80;
      window.dispatchEvent(new Event('resize'));
      expect(document.documentElement.style.getPropertyValue('--scroll-offset')).toBe('96px');
      const css = fs.readFileSync(path.resolve(__dirname, '../../docs/marketing/landing-v2/app.css'), 'utf8');
      expect(css).toMatch(/scroll-padding-top:\s*var\(--scroll-offset\)/);
      expect(css).toMatch(/@media \(max-width: 768px\)\s*\{\s*\.header-row \{ flex-wrap: wrap; \}/);
      expect(css).toContain('content-visibility: auto');
    } finally {
      getter.mockRestore();
      window.ResizeObserver = originalObserver;
    }
  });
});
