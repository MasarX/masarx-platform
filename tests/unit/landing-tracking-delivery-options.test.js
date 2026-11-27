/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');
const { setImmediate: realSetImmediate } = require('timers');

const landingDir = path.resolve(__dirname, '..', '..', 'docs', 'marketing', 'landing-v2');
const trackHtml = fs.readFileSync(path.join(landingDir, 'track.html'), 'utf8');
const trackMain = trackHtml.match(/<main[\s\S]*<\/main>/)[0];
const NOW = new Date('2026-11-24T15:00:00Z');
const SESSION_KEY = 'masarx_tracking_session_v1';

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => realSetImmediate(resolve));
};

function sessionBody({ status = 'in_transit', serviceType = 'delivery', actions = {} } = {}) {
  return {
    ok: true,
    tracking: {
      shipment: { tracking_number: 'MX-1', status, service_type: serviceType },
      actions,
      live_delivery: null,
    },
  };
}

const BRANCHES = [
  {
    id: 'branch-a',
    name: 'Branch A',
    address: { formatted: '1 Example St' },
    opening_hours: { timezone: 'UTC', opens_at: '09:00', closes_at: '21:00' },
    distance_km: 2.1,
  },
  {
    id: 'branch-b',
    name: 'Branch B',
    address: { line1: '4 Example Rd', district: 'North', city: 'Example City' },
    opening_hours: { timezone: 'UTC', opens_at: '10:00', closes_at: '18:00' },
    distance_km: null,
  },
];

function optionsBody(overrides = {}) {
  return {
    ok: true,
    delivery_options: {
      changes_open: true,
      choices: ['home_delivery', 'branch_pickup', 'safe_place'],
      branches: BRANCHES,
      safe_place: { places: ['reception', 'neighbour', 'other'], consent_copy: null },
      ...overrides,
    },
  };
}

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) });

async function loadTrackingPage({
  lang = 'en',
  session = sessionBody(),
  options = optionsBody(),
  request = { ok: true, outcome: 'pending_review' },
  requestStatus = 200,
} = {}) {
  jest.resetModules();
  const fetchMock = jest.fn((url) => {
    const target = String(url);
    if (target.endsWith('/tracking/session')) return json(session);
    if (target.endsWith('/tracking/options')) return typeof options === 'function' ? options() : json(options);
    if (target.endsWith('/tracking/request')) return json(request, requestStatus);
    return json({ ok: false, error: { code: 'not_found' } }, 404);
  });
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.body.innerHTML = `<button type="button" data-lang-toggle>AR</button>${trackMain}`;
  window.MASARX_RUNTIME = { trackingEndpoint: '/tracking', turnstileSiteKey: '', navigate: jest.fn(), replace: jest.fn() };
  window.MASARX_LANDING = undefined;
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  delete window.L;
  window.sessionStorage.setItem(SESSION_KEY, 'session-token');
  window.history.replaceState({}, '', `http://localhost/${lang === 'ar' ? 'ar/' : ''}track/`);
  require(path.join(landingDir, 'content.js'));
  const i18n = window.MASARX_LANDING.i18n;
  require(path.join(landingDir, 'app.js'));
  await flush();
  const q = (name) => document.querySelector(`[data-track-option${name ? `-${name}` : ''}]`);
  const calls = (action) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(`/tracking/${action}`));
  const radios = (name) => [...q('form').querySelectorAll(`input[type="radio"][name="${name}"]`)];
  const pick = (name, value) => radios(name).find((radio) => radio.value === value).click();
  const submit = async () => {
    q('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  };
  const sentPayload = () => JSON.parse(calls('request').at(-1)[1].body);
  return { q, t: (key) => i18n[key][lang], calls, radios, pick, submit, sentPayload };
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  document.querySelector('[data-track-stage="results"] [data-track-reset]')?.click();
  jest.clearAllTimers();
  jest.useRealTimers();
  window.sessionStorage.clear();
});

const km = (lang, value) =>
  new Intl.NumberFormat(lang, { style: 'unit', unit: 'kilometer', maximumFractionDigits: 1 }).format(value);
const hours = (lang, from, to) => new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
  .formatRange(new Date(Date.UTC(2026, 0, 1, from)), new Date(Date.UTC(2026, 0, 1, to)));
const radioLabels = (radios) => radios.map((radio) => radio.closest('label.choice').querySelector('[data-i18n]').textContent);

describe.each(['en', 'ar'])('delivery options card (%s)', (lang) => {
  test('ready: one radiogroup with the allowed options, posted with the session', async () => {
    const { q, t, calls, radios } = await loadTrackingPage({ lang });
    expect(q().hidden).toBe(false);
    expect(q().getAttribute('aria-busy')).toBeNull();
    expect(q('loading').hidden).toBe(true);
    expect(q('notice').hidden).toBe(true);
    expect(q('form').hidden).toBe(false);
    expect(q('choices').getAttribute('role')).toBe('radiogroup');
    expect(radios('option').map((radio) => radio.value)).toEqual(['home_delivery', 'branch_pickup', 'safe_place']);
    expect(radioLabels(radios('option'))).toEqual([
      t('track_option_home_delivery'), t('track_option_branch_pickup'), t('track_option_safe_place'),
    ]);
    expect(radios('option')[2].closest('label').querySelector('small').textContent).toBe(t('track_option_safe_place_hint'));
    expect(radios('option').some((radio) => radio.checked)).toBe(false);
    expect(q('branch').hidden).toBe(true);
    expect(q('branch-select').disabled).toBe(true);
    expect(q('place').hidden).toBe(true);
    expect(calls('options')).toHaveLength(1);
    expect(JSON.parse(calls('options')[0][1].body)).toEqual({ session_token: 'session-token' });
  });

  test('branch pickup: nearest-first list with distance, address and opening hours in bdi', async () => {
    const { q, t, pick } = await loadTrackingPage({ lang });
    pick('option', 'branch_pickup');
    expect(q('branch').hidden).toBe(false);
    expect(q('branch-select').disabled).toBe(false);
    expect([...q('branch-select').options].map((option) => option.textContent)).toEqual([
      t('track_option_branch_option').replace('{name}', 'Branch A').replace('{distance}', km(lang, 2.1)),
      'Branch B',
    ]);
    const detail = q('branch-detail');
    expect(detail.classList.contains('track-definition')).toBe(true);
    expect(detail.querySelector('strong').textContent).toBe('Branch A');
    const [address, open] = detail.querySelectorAll('bdi');
    expect(address.textContent).toBe('1 Example St');
    expect(open.textContent).toBe(hours(lang, 9, 21));
    expect(open.parentElement.textContent).toBe(t('track_option_branch_hours').replace('{hours}', hours(lang, 9, 21)));
    expect(detail.textContent).toContain(t('track_option_branch_id_note'));

    q('branch-select').value = 'branch-b';
    q('branch-select').dispatchEvent(new Event('change', { bubbles: true }));
    expect(detail.querySelector('strong').textContent).toBe('Branch B');
    expect(detail.querySelector('bdi').textContent)
      .toBe(new Intl.ListFormat(lang, { style: 'short', type: 'unit' }).format(['4 Example Rd', 'North', 'Example City']));
  });

  test('loading: skeleton and busy card while the options are fetched', async () => {
    const { q } = await loadTrackingPage({ lang, options: () => new Promise(() => {}) });
    expect(q().hidden).toBe(false);
    expect(q().getAttribute('aria-busy')).toBe('true');
    expect(q('loading').hidden).toBe(false);
    expect(q('form').hidden).toBe(true);
  });

  test('no pickup branches with safe place open: home and safe place plus the notice', async () => {
    const { q, t, radios } = await loadTrackingPage({ lang, options: optionsBody({ branches: [] }) });
    expect(radios('option').map((radio) => radio.value)).toEqual(['home_delivery', 'safe_place']);
    expect(q('notice').hidden).toBe(false);
    expect(q('notice-title').textContent).toBe(t('track_option_no_branches_title'));
    expect(q('notice-text').textContent).toBe(t('track_option_no_branches_text'));
  });

  test('no pickup branches and nothing else to change: the notice alone', async () => {
    const { q, t } = await loadTrackingPage({
      lang,
      options: optionsBody({ choices: ['home_delivery', 'branch_pickup'], branches: [], safe_place: null }),
    });
    expect(q().hidden).toBe(false);
    expect(q('form').hidden).toBe(true);
    expect(q('notice').hidden).toBe(false);
    expect(q('notice-title').textContent).toBe(t('track_option_no_branches_title'));
  });

  test('changes closed: one neutral notice without a form', async () => {
    const { q, t } = await loadTrackingPage({ lang, options: optionsBody({ changes_open: false, choices: [], branches: [], safe_place: null }) });
    expect(q().hidden).toBe(false);
    expect(q('form').hidden).toBe(true);
    expect(q('notice-title').textContent).toBe(t('track_option_closed_title'));
    expect(q('notice-text').textContent).toBe(t('track_option_closed_text'));
  });

  test('changes closed while a reschedule is open: the card stays hidden', async () => {
    const { q } = await loadTrackingPage({
      lang,
      session: sessionBody({ actions: { reschedule: { enabled: true, available_dates: ['2026-11-26'] } } }),
      options: optionsBody({ changes_open: false, choices: [], branches: [], safe_place: null }),
    });
    expect(q().hidden).toBe(true);
  });

  test('COD: safe place is not rendered', async () => {
    const { radios } = await loadTrackingPage({
      lang,
      options: optionsBody({ choices: ['home_delivery', 'branch_pickup'], safe_place: null }),
    });
    expect(radios('option').map((radio) => radio.value)).toEqual(['home_delivery', 'branch_pickup']);
  });

  test('switch back: home delivery is the one choice', async () => {
    const { q, radios, pick, submit, sentPayload } = await loadTrackingPage({
      lang,
      options: optionsBody({ choices: ['home_delivery'], branches: [], safe_place: null }),
    });
    expect(radios('option').map((radio) => radio.value)).toEqual(['home_delivery']);
    expect(q('notice').hidden).toBe(true);
    pick('option', 'home_delivery');
    await submit();
    expect(sentPayload()).toEqual({ session_token: 'session-token', request_type: 'delivery_option', payload: { option: 'home_delivery' } });
  });

  test('safe place: nested place group, counter for somewhere else and tenant consent copy', async () => {
    const { q, t, radios, pick } = await loadTrackingPage({
      lang,
      options: optionsBody({ safe_place: { places: ['reception', 'neighbour', 'other'], consent_copy: { en: 'Tenant consent', ar: 'موافقة المستأجر' } } }),
    });
    pick('option', 'safe_place');
    expect(q('place').hidden).toBe(false);
    expect(q('places').disabled).toBe(false);
    expect(radioLabels(radios('place'))).toEqual([
      t('track_option_place_reception'), t('track_option_place_neighbour'), t('track_option_place_other'),
    ]);
    expect(q('consent-text').textContent).toBe(lang === 'en' ? 'Tenant consent' : 'موافقة المستأجر');
    expect(q('other').hidden).toBe(true);
    expect(q('instruction').disabled).toBe(true);

    pick('place', 'other');
    expect(q('other').hidden).toBe(false);
    expect(q('instruction').disabled).toBe(false);
    expect(q('instruction').maxLength).toBe(120);
    q('instruction').value = 'Side gate';
    q('instruction').dispatchEvent(new Event('input', { bubbles: true }));
    expect(q('counter').textContent)
      .toBe(t('track_option_other_counter').replace('{count}', new Intl.NumberFormat(lang).format(9)));
  });

  test('safe place without consent: alert in the form status, checkbox marked invalid, nothing sent', async () => {
    const { q, t, calls, pick, submit } = await loadTrackingPage({ lang });
    pick('option', 'safe_place');
    pick('place', 'reception');
    expect(q('consent-text').textContent).toBe(t('track_option_consent_default'));
    await submit();
    expect(calls('request')).toHaveLength(0);
    expect(q('submit').disabled).toBe(false);
    expect(q('status').textContent).toBe(t('track_option_consent_required'));
    expect(q('status').getAttribute('role')).toBe('alert');
    expect(q('consent').getAttribute('aria-invalid')).toBe('true');
    expect(q('consent').getAttribute('aria-describedby')).toBe('track-option-status');
    expect(document.activeElement).toBe(q('consent'));

    q('consent').click();
    expect(q('status').getAttribute('role')).toBeNull();
    expect(q('status').getAttribute('aria-live')).toBe('polite');
    expect(q('status').textContent).toBe('');
    expect(q('consent').getAttribute('aria-invalid')).toBeNull();
  });

  test('payloads: branch, safe place and somewhere else; the form resets after a sent request', async () => {
    const { q, t, radios, pick, submit, sentPayload } = await loadTrackingPage({ lang });
    pick('option', 'branch_pickup');
    q('branch-select').value = 'branch-b';
    await submit();
    expect(sentPayload()).toEqual({
      session_token: 'session-token',
      request_type: 'delivery_option',
      payload: { option: 'branch_pickup', branch_id: 'branch-b' },
    });
    expect(q('status').textContent).toBe(t('track_status_request_pending_review'));
    expect(document.querySelector('[data-track-request-banner]').hidden).toBe(false);
    expect(radios('option').some((radio) => radio.checked)).toBe(false);
    expect(q('branch').hidden).toBe(true);
    expect(q('branch-select').disabled).toBe(true);

    pick('option', 'safe_place');
    pick('place', 'neighbour');
    q('consent').click();
    await submit();
    expect(sentPayload().payload).toEqual({ option: 'safe_place', place: 'neighbour', consent: true });

    pick('option', 'safe_place');
    pick('place', 'other');
    q('instruction').value = '  Side gate  ';
    q('consent').click();
    await submit();
    expect(sentPayload().payload).toEqual({ option: 'safe_place', place: 'other', instruction: 'Side gate', consent: true });
    expect(q('instruction').disabled).toBe(true);
  });

  test('home delivery already set: unchanged message and no banner', async () => {
    const { q, t, pick, submit } = await loadTrackingPage({ lang, request: { ok: true, unchanged: true } });
    pick('option', 'home_delivery');
    await submit();
    expect(q('status').textContent).toBe(t('track_option_status_unchanged'));
    expect(document.querySelector('[data-track-request-banner]').hidden).toBe(true);
  });

  test('changes closed on submit: the card switches to the closed notice', async () => {
    const { q, t, pick, submit } = await loadTrackingPage({
      lang,
      request: { ok: false, error: { code: 'changes_closed' } },
      requestStatus: 409,
    });
    pick('option', 'home_delivery');
    await submit();
    expect(q('form').hidden).toBe(true);
    expect(q('notice').hidden).toBe(false);
    expect(q('notice-title').textContent).toBe(t('track_option_closed_title'));
    expect(q('status').textContent).toBe('');
  });

  test('load error: the card stays hidden', async () => {
    const { q } = await loadTrackingPage({ lang, options: { ok: false, error: { code: 'rate_limited' } } });
    expect(q().hidden).toBe(true);
  });

  test.each(['created', 'pending_dispatch'])('server policy decides: a %s delivery gets the card', async (status) => {
    const { q, calls, radios } = await loadTrackingPage({ lang, session: sessionBody({ status }) });
    expect(calls('options')).toHaveLength(1);
    expect(JSON.parse(calls('options')[0][1].body)).toEqual({ session_token: 'session-token' });
    expect(q().hidden).toBe(false);
    expect(q('form').hidden).toBe(false);
    expect(radios('option').map((radio) => radio.value)).toEqual(['home_delivery', 'branch_pickup', 'safe_place']);
  });

  test('not eligible: the server answer shows the closed notice, no form and no error', async () => {
    // The server answers an ineligible shipment the same as closed changes (changes_open false).
    const { q, t, calls } = await loadTrackingPage({
      lang,
      session: sessionBody({ status: 'delivered' }),
      options: optionsBody({ changes_open: false, choices: [], branches: [], safe_place: null }),
    });
    expect(calls('options')).toHaveLength(1);
    expect(q('form').hidden).toBe(true);
    expect(q('notice-title').textContent).toBe(t('track_option_closed_title'));
    expect(q('status').textContent).toBe('');
    expect(q('status').getAttribute('role')).toBeNull();
  });

  test('no options call for a pickup service', async () => {
    const { q, calls } = await loadTrackingPage({ lang, session: sessionBody({ serviceType: 'pickup' }) });
    expect(calls('options')).toHaveLength(0);
    expect(q().hidden).toBe(true);
  });
});
