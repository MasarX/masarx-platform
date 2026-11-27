/**
 * @jest-environment jsdom
 */

const fs = require('fs');
const path = require('path');
const { setImmediate: realSetImmediate } = require('timers');

const landingDir = path.resolve(__dirname, '..', '..', 'docs', 'marketing', 'landing-v2');
const trackHtml = fs.readFileSync(path.join(landingDir, 'track.html'), 'utf8');
const trackMain = trackHtml.match(/<main[\s\S]*<\/main>/)[0];
const proofOverlay = trackHtml.match(/<div class="track-map-overlay" data-track-proof-overlay[\s\S]*?\r?\n    <\/div>/)[0];
const NOW = new Date('2026-11-24T15:00:00Z');
const SESSION_KEY = 'masarx_tracking_session_v1';
const CAPTURED_AT = '2026-11-24T11:22:00Z';
const UNTIL = '2026-11-25T11:22:00Z';
const fileUrl = (id) => `/functions/v1/public-shipment-tracking/proof/file?artifact=${id}&expires=1&signature=${'a'.repeat(64)}`;

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => realSetImmediate(resolve));
};

function sessionBody({ status = 'delivered', completion = null } = {}) {
  return {
    ok: true,
    tracking: {
      shipment: { tracking_number: 'MX-1', status, delivery_completion: completion },
      actions: {},
      live_delivery: null,
    },
  };
}

function proofBody(proof) {
  return { ok: true, proof: { state: 'available', available_until: UNTIL, recipient_name: 'S******', artifacts: [], ...proof } };
}

const PHOTO = { kind: 'photo', captured_at: CAPTURED_AT, url: fileUrl('photo-1') };
const SIGNATURE = { kind: 'signature', captured_at: CAPTURED_AT, url: fileUrl('sig-1') };

const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const image = (status = 200) => Promise.resolve({
  ok: status < 400,
  status,
  blob: async () => new Blob(['img'], { type: 'image/png' }),
});

async function loadTrackingPage({ lang = 'en', session = sessionBody(), proof = proofBody({ artifacts: [PHOTO, SIGNATURE] }), file = () => image() }) {
  jest.resetModules();
  const fetchMock = jest.fn((url) => {
    const target = String(url);
    if (target.endsWith('/tracking/session')) return json(session);
    if (target.endsWith('/tracking/proof')) return typeof proof === 'function' ? proof() : json(proof);
    if (target.includes('/proof/file?')) return file(target);
    return json({ ok: false, error: { code: 'not_found' } }, 404);
  });
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.body.innerHTML = `<button type="button" data-lang-toggle>AR</button>${trackMain}${proofOverlay}`;
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
  const q = (name) => document.querySelector(`[data-track-proof${name ? `-${name}` : ''}]`);
  const fileCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/proof/file?'));
  const proofCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/tracking/proof'));
  return { fetchMock, q, t: (key) => i18n[key][lang], fileCalls, proofCalls };
}

let blobCount = 0;

beforeEach(() => {
  blobCount = 0;
  jest.useFakeTimers({ now: NOW });
  Element.prototype.scrollIntoView = jest.fn();
  URL.createObjectURL = jest.fn(() => `blob:http://localhost/${(blobCount += 1)}`);
  URL.revokeObjectURL = jest.fn();
});

afterEach(() => {
  document.querySelector('[data-track-stage="results"] [data-track-reset]')?.click();
  jest.clearAllTimers();
  jest.useRealTimers();
  window.sessionStorage.clear();
});

const time = (lang, value, options = { hour: 'numeric', minute: '2-digit' }) =>
  new Intl.DateTimeFormat(lang, options).format(new Date(value));
const tiles = (q) => [...q('grid').querySelectorAll('.pod-thumb')];

describe.each(['en', 'ar'])('proof of delivery card (%s)', (lang) => {
  test('delivered: one tile per artifact, times and masked name in bdi, files posted with the session', async () => {
    const { q, t, fileCalls } = await loadTrackingPage({ lang });
    expect(q().hidden).toBe(false);
    expect(q('plain').hidden).toBe(true);
    expect(q('lock').textContent).toBe(t('track_masked_pill'));
    const [photo, signature] = tiles(q);
    expect(tiles(q)).toHaveLength(2);
    expect(photo.tagName).toBe('BUTTON');
    expect(photo.getAttribute('aria-haspopup')).toBe('dialog');
    expect(photo.getAttribute('aria-label')).toBe(t('track_pod_open_photo').replace('{time}', time(lang, CAPTURED_AT)));
    expect(photo.querySelector('img').getAttribute('aria-hidden')).toBe('true');
    expect(photo.querySelector('img').getAttribute('src')).toMatch(/^blob:/);
    expect(photo.querySelector('bdi').textContent).toBe(time(lang, CAPTURED_AT));
    expect(signature.getAttribute('aria-label')).toBe(t('track_pod_open_signature'));
    expect(signature.querySelector('.pod-tile').classList.contains('is-signature')).toBe(true);
    expect(signature.querySelector('bdi').textContent).toBe('S******');
    expect(q('meta').hidden).toBe(false);
    expect(q('meta').querySelector('bdi').textContent)
      .toBe(time(lang, UNTIL, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    expect(q('notice').hidden).toBe(true);
    expect(q('partial').hidden).toBe(true);
    expect(q('status').textContent).toBe('');
    expect(q('status').getAttribute('role')).toBeNull();
    expect(q('status').getAttribute('aria-live')).toBeNull();
    expect(q('reload').hidden).toBe(true);
    expect(fileCalls()).toHaveLength(2);
    const [url, init] = fileCalls()[0];
    expect(url).toBe(`http://localhost${fileUrl('photo-1')}`);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(JSON.parse(init.body)).toEqual({ session_token: 'session-token' });
  });

  test('photo only: one tile and no signature placeholder', async () => {
    const { q, t } = await loadTrackingPage({ lang, proof: proofBody({ artifacts: [PHOTO], recipient_name: null }) });
    expect(tiles(q)).toHaveLength(1);
    expect(tiles(q)[0].querySelector('strong').textContent).toBe(t('track_pod_photo'));
  });

  test('signature only: one tile with the plain caption when no name is given', async () => {
    const { q, t } = await loadTrackingPage({ lang, proof: proofBody({ artifacts: [SIGNATURE], recipient_name: null }) });
    expect(tiles(q)).toHaveLength(1);
    expect(tiles(q)[0].querySelector('span:last-child').textContent).toBe(t('track_pod_signature_caption_plain'));
  });

  test('partial delivery: box counts in the lock and the remaining-boxes note', async () => {
    const completion = { completion_kind: 'partial', box_count: 2, delivered_box_count: 1, remaining_box_count: 1 };
    const { q, t, proofCalls } = await loadTrackingPage({ lang, session: sessionBody({ status: 'partially_delivered', completion }) });
    expect(proofCalls()).toHaveLength(1);
    const number = new Intl.NumberFormat(lang);
    expect(q('lock').textContent)
      .toBe(t('track_pod_boxes').replace('{delivered}', number.format(1)).replace('{total}', number.format(2)));
    expect(q('partial').hidden).toBe(false);
    expect(q('partial').textContent).toBe(t('track_pod_partial_note'));
  });

  test('window ended: a notice replaces the tiles and no file is fetched', async () => {
    const { q, t, fileCalls } = await loadTrackingPage({
      lang,
      proof: proofBody({ state: 'expired', recipient_name: null, artifacts: [] }),
    });
    expect(q().hidden).toBe(false);
    expect(tiles(q)).toHaveLength(0);
    expect(q('notice').hidden).toBe(false);
    expect(q('notice-title').textContent).toBe(t('track_pod_expired_title'));
    expect(q('notice-text').textContent).toBe(t('track_pod_expired_text'));
    expect(q('meta').hidden).toBe(true);
    expect(fileCalls()).toHaveLength(0);
  });

  test.each([
    ['unavailable', proofBody({ state: 'unavailable', recipient_name: null }), 200],
    ['hidden by ops', proofBody({ artifacts: [] }), 200],
    ['proof_unavailable', { ok: false, error: { code: 'proof_unavailable' } }, 404],
  ])('%s: no proof section, only the plain copy', async (_name, body, status) => {
    const { q, t } = await loadTrackingPage({ lang, proof: () => json(body, status) });
    expect(q().hidden).toBe(true);
    expect(q('plain').hidden).toBe(false);
    expect(q('plain').textContent).toBe(t('track_pod_unavailable'));
  });

  test('not delivered: proof is not fetched', async () => {
    const { q, proofCalls } = await loadTrackingPage({ lang, session: sessionBody({ status: 'in_transit' }) });
    expect(proofCalls()).toHaveLength(0);
    expect(q().hidden).toBe(true);
    expect(q('plain').hidden).toBe(true);
  });

  test('expired session: asks to verify again and clears the session', async () => {
    const { q, t, fileCalls } = await loadTrackingPage({
      lang,
      proof: () => json({ ok: false, error: { code: 'invalid_session' } }, 401),
    });
    expect(q('notice-title').textContent).toBe(t('track_pod_session_title'));
    expect(q('reverify').hidden).toBe(false);
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();
    expect(fileCalls()).toHaveLength(0);
  });

  test('loading: skeleton tiles and the loading form status', async () => {
    let release;
    const { q, t } = await loadTrackingPage({
      lang,
      proof: () => new Promise((resolve) => { release = resolve; }),
    });
    expect(q().hidden).toBe(false);
    expect(q('grid').querySelectorAll('.pod-skel[aria-hidden="true"]')).toHaveLength(2);
    expect(q('status').textContent).toBe(t('track_pod_loading'));
    expect(q('status').classList.contains('is-error')).toBe(false);
    release({ ok: true, status: 200, text: async () => JSON.stringify(proofBody({ artifacts: [PHOTO] })) });
    await flush();
    expect(tiles(q)).toHaveLength(1);
    expect(q('status').textContent).toBe('');
  });

  test('error: a file that fails shows a missing tile and Reload gets new links', async () => {
    let failSignature = true;
    const { q, t, proofCalls } = await loadTrackingPage({
      lang,
      file: (url) => (failSignature && url.includes('sig-1') ? image(404) : image()),
    });
    const [photo, signature] = tiles(q);
    expect(photo.tagName).toBe('BUTTON');
    expect(signature.tagName).toBe('DIV');
    expect(signature.querySelector('.pod-missing strong').textContent).toBe(t('track_pod_signature_missing'));
    expect(signature.querySelector('.pod-missing').textContent).toContain(t('track_pod_missing_hint'));
    expect(q('status').textContent).toBe(t('track_pod_error_status'));
    expect(q('status').classList.contains('is-error')).toBe(true);
    expect(q('reload').hidden).toBe(false);

    failSignature = false;
    q('reload').click();
    await flush();
    expect(proofCalls()).toHaveLength(2);
    expect(tiles(q).every((tile) => tile.tagName === 'BUTTON')).toBe(true);
    expect(q('reload').hidden).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/1');
  });

  test('error: a failed proof request offers Reload without tiles', async () => {
    const { q, t } = await loadTrackingPage({ lang, proof: () => json({ ok: false, error: { code: 'internal' } }, 500) });
    expect(tiles(q)).toHaveLength(0);
    expect(q('status').textContent).toBe(t('track_pod_error_status'));
    expect(q('reload').hidden).toBe(false);
  });

  test('a file link on another origin never receives the session token', async () => {
    const foreign = { ...PHOTO, url: 'https://files.example.test/proof/file?artifact=x' };
    const { q, fileCalls } = await loadTrackingPage({ lang, proof: proofBody({ artifacts: [foreign] }) });
    expect(fileCalls()).toHaveLength(0);
    expect(tiles(q)[0].tagName).toBe('DIV');
  });

  test('dialog: opens from a tile, traps focus, steps with Next and returns focus on Escape', async () => {
    const { q, t } = await loadTrackingPage({ lang });
    const overlay = q('overlay');
    const [photo] = tiles(q);
    photo.click();
    expect(overlay.hidden).toBe(false);
    expect(overlay.querySelector('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect(document.body.classList.contains('track-map-overlay-open')).toBe(true);
    expect(document.activeElement).toBe(q('close'));
    expect(q('dialog-title').textContent).toBe(t('track_pod_photo'));
    expect(q('dialog-image').getAttribute('alt')).toBe(t('track_pod_photo_alt').replace('{time}', time(lang, CAPTURED_AT)));
    expect(q('dialog-image').getAttribute('src')).toBe(photo.querySelector('img').getAttribute('src'));
    const number = new Intl.NumberFormat(lang);
    const position = (index) => t('track_pod_position').replace('{index}', number.format(index)).replace('{total}', number.format(2));
    expect(q('dialog-meta').textContent.endsWith(position(1))).toBe(true);
    expect(q('dialog-meta').querySelector('bdi')).not.toBeNull();

    const key = (name, shiftKey = false) => overlay.dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }));
    q('next').focus();
    key('Tab');
    expect(document.activeElement).toBe(q('close'));
    key('Tab', true);
    expect(document.activeElement).toBe(q('next'));

    q('next').click();
    expect(q('dialog-title').textContent).toBe(t('track_pod_signature'));
    expect(q('dialog-image').getAttribute('alt')).toBe(t('track_pod_signature_alt'));
    expect(q('dialog-meta').textContent.endsWith(position(2))).toBe(true);

    key('Escape');
    expect(overlay.hidden).toBe(true);
    expect(document.body.classList.contains('track-map-overlay-open')).toBe(false);
    expect(document.activeElement).toBe(tiles(q)[1]);
  });

  test('reset revokes the file links and hides the card', async () => {
    const { q } = await loadTrackingPage({ lang });
    document.querySelector('[data-track-stage="results"] [data-track-reset]').click();
    expect(q().hidden).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
