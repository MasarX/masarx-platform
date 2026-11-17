/**
 * @jest-environment jsdom
 */

const path = require('path');

function loadLandingApp({
  url,
  htmlLang = 'en',
  localStorageLang = '',
  runtime = {},
  fetchImpl = null,
  extraHtml = '',
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

  window.localStorage.clear();
  if (localStorageLang) window.localStorage.setItem('masarx_lang', localStorageLang);

  window.history.replaceState({}, '', url);

  require(contentPath);
  require(appPath);

  return { fetchMock };
}

const LANDING_CONTACT_ENDPOINT_MOCK = "/__landing-contact";

describe('landing app language routing', () => {
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
    expect(document.querySelector('[data-contact-status]').textContent).toBe('Contact endpoint is not configured.');
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
});
