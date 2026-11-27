/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');
const { setImmediate: realSetImmediate } = require('timers');

const landingDir = path.resolve(__dirname, '..', '..', 'docs', 'marketing', 'landing-v2');
const trackMain = fs.readFileSync(path.join(landingDir, 'track.html'), 'utf8').match(/<main[\s\S]*<\/main>/)[0];
const NOW = new Date('2026-11-24T11:00:00Z');
const SESSION_KEY = 'masarx_tracking_session_v1';
const AREA = { south: 24.7, west: 46.67, north: 24.705, east: 46.675 };

let visibility = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => realSetImmediate(resolve));
};

function live(status, extra = {}) {
  return {
    status,
    eta_window_start_at: '2026-11-24T11:20:00Z',
    eta_window_end_at: '2026-11-24T11:50:00Z',
    stops_ahead: 2,
    updated_at: '2026-11-24T10:58:00Z',
    area: status === 'live' ? AREA : null,
    ...extra,
  };
}

function sessionBody(liveDelivery) {
  return {
    ok: true,
    tracking: {
      shipment: {
        tracking_number: 'MX-1',
        status: 'out_for_delivery',
        promised_window_start_at: '2026-11-24T10:00:00Z',
        promised_window_end_at: '2026-11-24T14:00:00Z',
      },
      actions: {},
      live_delivery: liveDelivery,
    },
  };
}

function respond(body, status = 200) {
  return Promise.resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) });
}

function fakeLeaflet() {
  const rects = [];
  const zoomControls = [];
  const any = () => new Proxy({}, { get: (_t, key) => (key === 'then' ? undefined : () => any()) });
  const map = new Proxy({ attributionControl: any(), getZoom: () => 11 }, {
    get: (t, key) => (key in t ? t[key] : key === 'then' ? undefined : () => map),
  });
  return {
    rects,
    zoomControls,
    L: {
      map: () => map,
      control: {
        zoom(options) {
          return {
            addTo(targetMap) {
              zoomControls.push({ map: targetMap, options });
              return this;
            },
          };
        },
      },
      tileLayer: () => any(),
      marker: () => any(),
      divIcon: () => ({}),
      rectangle: (bounds, options) => {
        const rect = { bounds, options, addTo: () => rect, setBounds: (next) => { rect.bounds = next; return rect; } };
        rects.push(rect);
        return rect;
      },
    },
  };
}

async function loadTrackingPage({ lang = 'en', responses, leaflet = null }) {
  jest.resetModules();
  const queue = [...responses];
  const fetchMock = jest.fn(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next() : respond(next);
  });
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.body.innerHTML = `<button type="button" data-lang-toggle>AR</button>${trackMain}`;
  window.MASARX_RUNTIME = { trackingEndpoint: '/tracking', turnstileSiteKey: '', navigate: jest.fn(), replace: jest.fn() };
  window.MASARX_LANDING = undefined;
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  if (leaflet) window.L = leaflet;
  else delete window.L;
  window.sessionStorage.setItem(SESSION_KEY, 'session-token');
  window.history.replaceState({}, '', `http://localhost/${lang === 'ar' ? 'ar/' : ''}track/`);
  require(path.join(landingDir, 'content.js'));
  const i18n = window.MASARX_LANDING.i18n;
  require(path.join(landingDir, 'app.js'));
  await flush();
  const q = (name) => document.querySelector(`[data-track-courier${name ? `-${name}` : ''}]`);
  return { fetchMock, q, t: (key) => i18n[key][lang] };
}

beforeEach(() => {
  visibility = 'visible';
  jest.useFakeTimers({ now: NOW });
  Element.prototype.scrollIntoView = jest.fn();
});

afterEach(() => {
  // Stop this page's poll so the next test's fetch mock sees only its own page.
  document.querySelector('[data-track-stage="results"] [data-track-reset]')?.click();
  jest.clearAllTimers();
  jest.useRealTimers();
  window.sessionStorage.clear();
});

const timeRange = (lang, start, end, options = { hour: 'numeric', minute: '2-digit' }) =>
  new Intl.DateTimeFormat(lang, options).formatRange(new Date(start), new Date(end));

describe.each(['en', 'ar'])('live delivery card (%s)', (lang) => {
  test('live: shows the coarse area, ETA range in bdi and one status region', async () => {
    const leaflet = fakeLeaflet();
    const { q, t } = await loadTrackingPage({ lang, responses: [sessionBody(live('live'))], leaflet: leaflet.L });
    expect(q().hidden).toBe(false);
    expect(q('eta').querySelector('bdi').textContent)
      .toBe(timeRange(lang, '2026-11-24T11:20:00Z', '2026-11-24T11:50:00Z'));
    expect(q('stops').textContent.startsWith(new Intl.NumberFormat(lang).format(2))).toBe(true);
    expect(q('stops').querySelectorAll('.track-courier-stops span')).toHaveLength(3);
    expect(q('updated').querySelector('bdi').textContent)
      .toBe(new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-2, 'minute'));
    expect(q('map-wrap').hidden).toBe(false);
    expect(leaflet.zoomControls).toMatchObject([{ options: { position: lang === 'ar' ? 'topright' : 'topleft' } }]);
    expect(leaflet.rects).toHaveLength(1);
    expect(leaflet.rects[0].bounds).toEqual([[AREA.south, AREA.west], [AREA.north, AREA.east]]);
    expect(leaflet.rects[0].options).toMatchObject({ className: 'track-courier-area', interactive: false });
    const distance = new Intl.NumberFormat(lang, { style: 'unit', unit: 'meter', maximumFractionDigits: 0 }).format(600);
    expect(q('meta-text').querySelector('bdi').textContent).toBe(distance);
    expect(q('map-frame').getAttribute('aria-label')).toBe(t('track_courier_map_aria').replace('{distance}', distance));
    expect(q('status').dataset.status).toBe('live');
    expect(q('status-text').textContent).toBe(t('track_courier_status_live'));
    expect(q('privacy').hidden).toBe(false);
    expect(q('notice').hidden).toBe(true);
    expect(q().querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(q('notice').hasAttribute('aria-live')).toBe(false);
  });

  test.each([
    ['too_far', 'live'],
    ['paused', 'paused'],
    ['hidden', 'hidden'],
  ])('%s: shows the notice instead of a map', async (status, dot) => {
    const { q, t } = await loadTrackingPage({ lang, responses: [sessionBody(live(status))] });
    expect(q().hidden).toBe(false);
    expect(q('map-wrap').hidden).toBe(true);
    expect(q('privacy').hidden).toBe(true);
    expect(q('notice').hidden).toBe(false);
    expect(q('notice-title').textContent).toBe(t(`track_courier_${status}_title`));
    expect(q('notice-text').textContent).toBe(t(`track_courier_${status}_text`));
    expect(q('status').dataset.status).toBe(dot);
    expect(q('meta-text').textContent).toBe(t(status === 'paused' ? 'track_courier_meta_paused' : 'track_courier_meta_poll'));
    expect(q('eta').querySelector('bdi')).not.toBeNull();
  });

  test('live without a usable map falls back to the neutral notice', async () => {
    const { q, t } = await loadTrackingPage({ lang, responses: [sessionBody(live('live'))] });
    expect(q('map-wrap').hidden).toBe(true);
    expect(q('notice-title').textContent).toBe(t('track_courier_hidden_title'));
  });

  test('null: keeps the card hidden', async () => {
    const { q } = await loadTrackingPage({ lang, responses: [sessionBody(null)] });
    expect(q().hidden).toBe(true);
  });

  test('error: keeps the promised window and offers a retry', async () => {
    const { q, t, fetchMock } = await loadTrackingPage({
      lang,
      responses: [sessionBody(live('too_far')), { ok: false, error: { code: 'rate_limited' } }],
    });
    await jest.advanceTimersByTimeAsync(60000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(q('notice-title').textContent).toBe(t('track_courier_error_title'));
    const promised = timeRange(lang, '2026-11-24T10:00:00Z', '2026-11-24T14:00:00Z',
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(q('notice-text').querySelector('bdi').textContent).toBe(promised);
    expect(q('retry').hidden).toBe(false);
    expect(q('reverify').hidden).toBe(true);
    expect(q('status').dataset.status).toBe('offline');
    expect(q('form-status').textContent).toBe(t('track_courier_error_status'));
    expect(q('form-status').hasAttribute('aria-live')).toBe(false);
    q('retry').click();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('expired: asks to verify again and stops polling', async () => {
    const { q, t, fetchMock } = await loadTrackingPage({
      lang,
      responses: [sessionBody(live('paused')), { ok: false, error: { code: 'invalid_session' } }],
    });
    await jest.advanceTimersByTimeAsync(60000);
    await flush();
    expect(q('notice-title').textContent).toBe(t('track_courier_expired_title'));
    expect(q('notice-text').textContent).toBe(t('track_courier_expired_text'));
    expect(q('reverify').hidden).toBe(false);
    expect(q('retry').hidden).toBe(true);
    expect(q('facts').hidden).toBe(true);
    expect(window.sessionStorage.getItem(SESSION_KEY) || '').toBe('');
    await jest.advanceTimersByTimeAsync(180000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

test('polls every minute and pauses while the tab is hidden', async () => {
  const { fetchMock, q } = await loadTrackingPage({
    responses: [sessionBody(live('too_far')), sessionBody(live('too_far', { stops_ahead: 1 }))],
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toMatch(/\/session$/);
  await jest.advanceTimersByTimeAsync(60000);
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ session_token: 'session-token' });
  expect(q('stops').textContent.startsWith('1')).toBe(true);

  await jest.advanceTimersByTimeAsync(20000);
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
  await jest.advanceTimersByTimeAsync(180000);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await jest.advanceTimersByTimeAsync(0);
  await flush();
  // The last fetch is older than a minute, so the page refreshes at once.
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

test('does not re-render an unchanged ETA in its live region', async () => {
  const { q } = await loadTrackingPage({ responses: [sessionBody(live('too_far'))] });
  const before = q('eta').querySelector('bdi');
  await jest.advanceTimersByTimeAsync(60000);
  await flush();
  expect(q('eta').querySelector('bdi')).toBe(before);
});
