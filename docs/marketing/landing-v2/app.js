(() => {
  const CLIENT_FETCH_TIMEOUT_MS = 10_000;
  const DRIVER_STATUS_TOKEN_STORAGE_KEY = 'masarx_driver_status_token_v1';

  const cfg = window.MASARX_LANDING;
  if (!cfg || !cfg.i18n) return;

  const root = document.documentElement;
  root.classList.add('js');
  const i18n = cfg.i18n;
  const runtime = window.MASARX_RUNTIME || {};

  function resolveRuntimeDurationMs(value, policy) {
    const fallback = Number(policy?.default);
    const min = Number(policy?.min);
    const max = Number(policy?.max);
    if (![fallback, min, max].every(Number.isFinite) || min <= 0 || min > fallback || fallback > max) {
      throw new Error('invalid_landing_runtime_duration_policy');
    }
    const requested = value == null || String(value).trim() === '' ? fallback : Number(value);
    const normalized = Number.isFinite(requested) ? Math.round(requested) : fallback;
    return Math.max(min, Math.min(max, normalized));
  }

  const PUBLIC_REQUEST_TIMEOUT_MS = resolveRuntimeDurationMs(
    runtime.publicRequestTimeoutMs,
    cfg.runtimePolicy?.publicRequestTimeoutMs
  );

  function navigateTo(href) {
    invalidateTrackingRequests();
    if (typeof runtime.navigate === 'function') {
      runtime.navigate(href);
      return;
    }
    window.location.assign(href);
  }

  function replaceTo(href) {
    if (typeof runtime.replace === 'function') {
      runtime.replace(href);
      return;
    }
    window.location.replace(href);
  }

  const query = new URLSearchParams(window.location.search);
  const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Same key and values as packages/ui/src/theme.tsx: "light" or "dark" is an
  // explicit choice; no stored value means follow the OS (system mode).
  const THEME_STORAGE_KEY = 'masarx-ui-theme';
  const LEGACY_THEME_STORAGE_KEY = 'masarx_theme';
  const colorSchemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const knownMotions = new Set(['on', 'off']);
  const knownThemes = new Set(['light', 'dark']);
  const knownLangs = new Set(['en', 'ar']);

  function normalizeBasePath(value) {
    const raw = String(value || '').trim();
    if (!raw || raw === '/') return '/';
    const withLeading = raw.startsWith('/') ? raw : `/${raw}`;
    return withLeading.replace(/\/+$/g, '');
  }

  function resolveSiteBasePath() {
    const runtimeSiteUrl = typeof runtime.siteUrl === 'string' ? runtime.siteUrl.trim() : '';
    if (!runtimeSiteUrl) return '/';
    try {
      return normalizeBasePath(new URL(runtimeSiteUrl).pathname || '/');
    } catch {
      return '/';
    }
  }

  const siteBasePath = resolveSiteBasePath();

  function buildLangPath(lang) {
    const base = siteBasePath === '/' ? '' : siteBasePath;
    if (lang === 'ar') return `${base}/ar/`;
    return base ? `${base}/` : '/';
  }

  function getPathSubpath() {
    const pathname = window.location.pathname || '/';
    const base = siteBasePath === '/' ? '' : siteBasePath;
    let next = pathname;

    if (base && next.startsWith(base)) {
      next = next.slice(base.length) || '/';
    }

    if (!next.startsWith('/')) next = `/${next}`;
    if (next === '/ar') return '';
    if (next.startsWith('/ar/')) next = next.slice(3) || '/';
    if (next === '/') return '';
    return next.replace(/^\/+|\/+$/g, '');
  }

  function buildTrackHref(lang) {
    const base = siteBasePath === '/' ? '' : siteBasePath;
    const prefix = knownLangs.has(lang) && lang === 'ar' ? `${base}/ar` : base;
    return `${prefix || ''}/track/`.replace(/\/{2,}/g, '/');
  }

  function buildHomeHref(lang) {
    return buildLangPath(lang);
  }

  function getPathLang() {
    const pathname = normalizeBasePath(window.location.pathname || '/');
    const arPath = normalizeBasePath(buildLangPath('ar'));
    if (pathname === arPath || pathname.startsWith(`${arPath}/`)) return 'ar';
    return 'en';
  }

  function buildLangHref(lang) {
    const next = knownLangs.has(lang) ? lang : 'en';
    const url = new URL(window.location.href);
    const subpath = getPathSubpath();
    url.searchParams.delete('lang');
    if (!subpath) {
      url.pathname = buildLangPath(next);
    } else {
      const prefix = buildLangPath(next).replace(/\/+$/g, '');
      url.pathname = `${prefix}/${subpath}/`.replace(/\/{2,}/g, '/');
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  const requestedLang = query.get('lang');
  const requestedKnownLang = requestedLang && knownLangs.has(requestedLang) ? requestedLang : '';
  const pathLang = getPathLang();
  if (requestedKnownLang && requestedKnownLang !== pathLang) {
    replaceTo(buildLangHref(requestedKnownLang));
    return;
  }

  function resolveLocalizedContentPath(pathname, lang) {
    const normalizedPath = normalizeBasePath(pathname || '/');
    const localizedBase = normalizeBasePath(buildLangPath(lang));

    if (localizedBase === '/') return normalizedPath || '/';
    if (normalizedPath === localizedBase) return '/';
    if (normalizedPath.startsWith(`${localizedBase}/`)) {
      return normalizeBasePath(normalizedPath.slice(localizedBase.length) || '/');
    }
    return normalizedPath;
  }

  function decodePathSegment(value) {
    try {
      return decodeURIComponent(String(value || '').trim());
    } catch {
      return String(value || '').trim();
    }
  }

  function resolveDriverRoute() {
    const relativePath = resolveLocalizedContentPath(window.location.pathname || '/', pathLang);
    const queryToken = String(query.get('token') || '').trim();

    if (relativePath === '/drivers' || relativePath === '/drivers/apply') {
      return { mode: 'apply', token: queryToken };
    }

    if (relativePath === '/drivers/status') {
      return { mode: 'status', token: queryToken };
    }

    if (relativePath.startsWith('/drivers/status/')) {
      return {
        mode: 'status',
        token: decodePathSegment(relativePath.slice('/drivers/status/'.length)) || queryToken,
      };
    }

    return { mode: 'default', token: queryToken };
  }

  const driverRoute = resolveDriverRoute();

  const langToggle = document.querySelector('[data-lang-toggle]');
  const themeToggle = document.querySelector('[data-theme-toggle]');
  const heroSection = document.querySelector('.hero');
  const tiltEls = [...document.querySelectorAll('[data-tilt]')];
  const navToggle = document.querySelector('.nav-toggle');
  const navEl = document.querySelector('#nav-primary');
  const navLinks = [...document.querySelectorAll('.nav a[href^="#"]')];
  const runtimeHrefEls = [...document.querySelectorAll('[data-runtime-href]')];
  const trackHrefEls = [...document.querySelectorAll('[data-track-href]')];
  const homeHrefEls = [...document.querySelectorAll('[data-home-href]')];
  const clientsRow = document.querySelector('[data-clients-row]');
  const contactForm = document.querySelector('[data-contact-form]');
  const contactStatus = document.querySelector('[data-contact-status]');
  const tenantSignupStatus = document.querySelector('[data-tenant-signup-status]');
  const tenantSignupBtn = contactForm?.querySelector('[data-tenant-signup-submit]');
  const turnstileHost = document.querySelector('[data-turnstile]');
  const contactSubmitBtn = contactForm ? contactForm.querySelector('button[type="submit"]') : null;
  const driverForm = document.querySelector('[data-driver-form]');
  const driverStatus = document.querySelector('[data-driver-status]');
  const driverTurnstileHost = document.querySelector('[data-driver-turnstile]');
  const driverSubmitBtn = driverForm ? driverForm.querySelector('button[type="submit"]') : null;
  const driverStatusForm = document.querySelector('[data-driver-status-form]');
  const driverStatusLookup = document.querySelector('[data-driver-status-lookup]');
  const driverReviewNote = document.querySelector('[data-driver-review-note]');
  const driverStatusTokenNote = document.querySelector('[data-driver-status-token-note]');
  const driverStatusSubmitBtn = driverStatusForm ? driverStatusForm.querySelector('button[type="submit"]') : null;
  const trackingPage = document.querySelector('[data-public-tracking-page]');
  const lookupStage = document.querySelector('[data-track-stage="lookup"]');
  const verifyStage = document.querySelector('[data-track-stage="verify"]');
  const resultsStage = document.querySelector('[data-track-stage="results"]');
  const trackLookupForm = document.querySelector('[data-track-lookup-form]');
  const trackVerifyForm = document.querySelector('[data-track-verify-form]');
  const trackRescheduleForm = document.querySelector('[data-track-reschedule-form]');
  const trackLocationForm = document.querySelector('[data-track-location-form]');
  const trackLookupSubmitBtn = trackLookupForm ? trackLookupForm.querySelector('button[type="submit"]') : null;
  const trackVerifySubmitBtn = trackVerifyForm ? trackVerifyForm.querySelector('button[type="submit"]') : null;
  const trackLookupStatus = document.querySelector('[data-track-lookup-status]');
  const trackVerifyStatus = document.querySelector('[data-track-verify-status]');
  const trackRescheduleStatus = document.querySelector('[data-track-reschedule-status]');
  const trackLocationStatus = document.querySelector('[data-track-location-status]');
  const trackBackBtn = document.querySelector('[data-track-back]');
  const trackResetEls = [...document.querySelectorAll('[data-track-reset]')];
  const trackRequestsLinks = [...document.querySelectorAll('[data-track-requests-link]')];
  const trackDateSelect = document.querySelector('[data-track-date-select]');
  const trackRescheduleSubmitBtn = trackRescheduleForm ? trackRescheduleForm.querySelector('button[type="submit"]') : null;
  const trackLocationSubmitBtn = trackLocationForm ? trackLocationForm.querySelector('button[type="submit"]') : null;
  const trackTimeline = document.querySelector('[data-track-timeline]');
  const trackShipmentReference = document.querySelector('[data-track-shipment-reference]');
  const trackShipmentTracking = document.querySelector('[data-track-shipment-tracking]');
  const trackShipmentClientRef = document.querySelector('[data-track-shipment-client-ref]');
  const trackShipmentCarrierRef = document.querySelector('[data-track-shipment-carrier-ref]');
  const trackShipmentStatus = document.querySelector('[data-track-shipment-status]');
  const trackShipmentService = document.querySelector('[data-track-shipment-service]');
  const trackShipmentPromise = document.querySelector('[data-track-shipment-promise]');
  const trackShipmentCreated = document.querySelector('[data-track-shipment-created]');
  const trackRecipientName = document.querySelector('[data-track-recipient-name]');
  const trackRecipientPhone = document.querySelector('[data-track-recipient-phone]');
  const trackRecipientEmail = document.querySelector('[data-track-recipient-email]');
  const trackAddressCity = document.querySelector('[data-track-address-city]');
  const trackAddressDistrict = document.querySelector('[data-track-address-district]');
  const trackAddressShort = document.querySelector('[data-track-address-short]');
  const trackRequestBanner = document.querySelector('[data-track-request-banner]');
  const trackRequestBannerBadge = document.querySelector('[data-track-request-banner-badge]');
  const trackRequestBannerText = document.querySelector('[data-track-request-banner-text]');
  const trackRequestBannerCase = document.querySelector('[data-track-request-banner-case]');
  const trackMapPicker = document.querySelector('[data-track-map-picker]');
  const trackMapDialogPicker = document.querySelector('[data-track-map-picker-expanded]');
  const trackMapValue = document.querySelector('[data-track-map-value]');
  const trackMapStatus = document.querySelector('[data-track-map-status]');
  const trackMapOverlay = document.querySelector('[data-track-map-overlay]');
  const trackMapExpandEls = [...document.querySelectorAll('[data-track-map-expand]')];
  const trackMapConfirmEls = [...document.querySelectorAll('[data-track-map-confirm]')];
  const trackMapCenterEls = [...document.querySelectorAll('[data-track-map-center]')];
  const trackMapLocateEls = [...document.querySelectorAll('[data-track-map-locate]')];
  const trackMapClearEls = [...document.querySelectorAll('[data-track-map-clear]')];
  const trackMapCloseEls = [...document.querySelectorAll('[data-track-map-close]')];

  const intakeForms = {
    tenant: { form: contactForm, status: tenantSignupStatus, submitBtn: tenantSignupBtn },
    contact: {
      form: contactForm,
      status: contactStatus,
      turnstileHost: contactForm ? turnstileHost : null,
      submitBtn: contactSubmitBtn,
    },
    driver: {
      form: driverForm,
      status: driverStatus,
      turnstileHost: driverTurnstileHost,
      submitBtn: driverSubmitBtn,
    },
  };

  const turnstileConfigs = {
    contact: {
      turnstileHost: contactForm ? turnstileHost : null,
    },
    driver: {
      turnstileHost: driverTurnstileHost,
    },
    tracking: {
      turnstileHost: trackingPage ? turnstileHost : null,
    },
  };

  const state = {
    turnstile: {
      contact: { widgetId: null, token: '' },
      driver: { widgetId: null, token: '' },
      tracking: { widgetId: null, token: '' },
    },
    latestClients: [],
    clientsStateKey: '',
    contactInFlight: false,
    driverSignupInFlight: false,
    driverStatusLookupInFlight: false,
    driverReceiptReference: '',
    driverStatusLookupGeneration: 0,
    driverReviewNote: '',
    trackingStage: 'lookup',
    trackingReference: '',
    trackingSessionToken: '',
    trackingPayload: null,
    trackingLookupInFlight: false,
    trackingVerifyInFlight: false,
    trackingRequestInFlight: {
      reschedule_date: false,
      location_change: false,
    },
    trackingRequestSequence: 0,
    trackingRequestSlots: {
      session: null,
      lookup: null,
      verify: null,
      reschedule_date: null,
      location_change: null,
    },
    mapPin: null,
    mapPinConfirmed: false,
    mapOverlayTrigger: null,
    mapLocateInFlight: false,
    mapLocateSeq: 0,
  };

  function getIntakeConfig(formKey) {
    return intakeForms[formKey] || null;
  }

  function getTurnstileConfig(formKey) {
    return turnstileConfigs[formKey] || null;
  }

  function resolveDefaultTurnstileKey() {
    if (trackingPage) return 'tracking';
    if (driverForm && !contactForm) return 'driver';
    return 'contact';
  }

  function getTurnstileState(formKey) {
    return state.turnstile[formKey] || null;
  }

  function releaseTrackingRequest(request) {
    if (!request || request.released) return;
    request.released = true;
    if (typeof request.release === 'function') request.release();
  }

  function finalizeTrackingRequestTurnstile(request) {
    if (!request || request.turnstileFinalized) return;
    request.turnstileFinalized = true;
    if (request.turnstileKey && request.turnstileToken) {
      finalizeTurnstileSubmission(request.turnstileKey, request.turnstileToken);
    }
  }

  function clearTrackingRequestLoadingStatus(request) {
    const statusEl = request?.statusEl;
    if (!statusEl || statusEl.dataset.trackingRequestOwner !== request.id) return;
    delete statusEl.dataset.trackingRequestOwner;
    setTrackingStatus(statusEl, '');
  }

  function claimTrackingRequestLoadingStatus(request) {
    if (!isCurrentTrackingRequest(request) || !request.statusEl) return;
    request.statusEl.dataset.trackingRequestOwner = request.id;
    setTrackingStatus(request.statusEl, 'track_status_loading');
  }

  function setOwnedTrackingRequestStatus(request, key, tone) {
    if (!isCurrentTrackingRequest(request) || !request.statusEl) return;
    if (request.statusEl.dataset.trackingRequestOwner === request.id) {
      delete request.statusEl.dataset.trackingRequestOwner;
    }
    setTrackingStatus(request.statusEl, key, tone);
  }

  function invalidateTrackingRequests(requestKeys = Object.keys(state.trackingRequestSlots)) {
    const keys = Array.isArray(requestKeys) ? requestKeys : [requestKeys];
    keys.forEach((requestKey) => {
      const request = state.trackingRequestSlots[requestKey];
      if (!request) return;
      state.trackingRequestSlots[requestKey] = null;
      clearTrackingRequestLoadingStatus(request);
      try {
        request.controller.abort();
      } catch {
        // ignore
      }
      finalizeTrackingRequestTurnstile(request);
      releaseTrackingRequest(request);
    });
  }

  function beginTrackingRequest(requestKey, {
    release,
    statusEl,
    supersedeKeys = [requestKey],
    turnstileKey = '',
    turnstileToken = '',
  } = {}) {
    invalidateTrackingRequests(supersedeKeys);
    state.trackingRequestSequence += 1;
    const request = {
      controller: new AbortController(),
      id: `${state.trackingRequestSequence}:${requestKey}`,
      key: requestKey,
      release,
      released: false,
      statusEl,
      turnstileFinalized: false,
      turnstileKey,
      turnstileToken,
    };
    state.trackingRequestSlots[requestKey] = request;
    return request;
  }

  function isCurrentTrackingRequest(request) {
    return Boolean(
      request
      && state.trackingRequestSlots[request.key] === request
    );
  }

  function hasTrackingMutationInFlight() {
    return Object.values(state.trackingRequestInFlight).some(Boolean);
  }

  function lockMutableControls(forms) {
    const controls = Array.from(new Set(
      forms
        .filter(Boolean)
        .flatMap((form) => [...form.querySelectorAll(
          'input:not([type="hidden"]):not([type="submit"]), select, textarea, button[type="button"]'
        )])
    )).map((control) => ({
      control,
      wasDisabled: Boolean(control.disabled),
    }));

    controls.forEach(({ control }) => {
      control.disabled = true;
    });

    return () => {
      controls.forEach(({ control, wasDisabled }) => {
        control.disabled = wasDisabled;
      });
    };
  }

  function finishTrackingRequest(request) {
    if (!request) return false;
    const isCurrent = isCurrentTrackingRequest(request);
    if (state.trackingRequestSlots[request.key] === request) {
      state.trackingRequestSlots[request.key] = null;
    }
    finalizeTrackingRequestTurnstile(request);
    clearTrackingRequestLoadingStatus(request);
    releaseTrackingRequest(request);
    return isCurrent;
  }

  function isMotionOn() {
    return root.dataset.motion !== 'off';
  }

  function isDarkTheme() {
    return root.dataset.theme === 'dark';
  }

  function getText(key, lang) {
    const entry = i18n[key];
    if (!entry) return '';
    return entry[lang] ?? entry.en ?? '';
  }

  function readStorageValue(kind, key) {
    try { return String(window[kind]?.getItem(key) || '').trim(); } catch { return ''; }
  }

  function writeStorageValue(kind, key, value) {
    try {
      if (value) window[kind]?.setItem(key, value);
      else window[kind]?.removeItem(key);
    } catch { /* Storage can be unavailable; keep the current in-memory state. */ }
  }

  let themeMode = 'system';

  function resolveSystemTheme() {
    return colorSchemeQuery && colorSchemeQuery.matches ? 'dark' : 'light';
  }

  function setTheme(mode) {
    themeMode = knownThemes.has(mode) ? mode : 'system';
    writeStorageValue('localStorage', THEME_STORAGE_KEY, themeMode === 'system' ? '' : themeMode);
    applyTheme(themeMode === 'system' ? resolveSystemTheme() : themeMode);
  }

  function applyTheme(next) {
    root.dataset.theme = next;

    const lang = root.lang || 'en';
    if (themeToggle) {
      const labelKey = next === 'dark' ? 'theme_light' : 'theme_dark';
      themeToggle.textContent = getText(labelKey, lang);
      themeToggle.setAttribute('aria-pressed', String(next === 'dark'));
    }

    refreshTurnstileTheme();
  }

  function setMotion(mode) {
    const next = knownMotions.has(mode) ? mode : (prefersReducedMotion ? 'off' : 'on');
    root.dataset.motion = next;
    writeStorageValue('localStorage', 'masarx_motion', next);

    if (next === 'off') {
      document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-inview'));
      tiltEls.forEach((el) => {
        el.style.removeProperty('--rx');
        el.style.removeProperty('--ry');
      });
    }
  }

  function applyRuntimeLinks() {
    if (!runtimeHrefEls.length) return;
    runtimeHrefEls.forEach((el) => {
      const key = el.dataset.runtimeHref;
      const value = key && runtime[key];
      const next = typeof value === 'string' ? value.trim() : '';
      const hideWhenEmpty = el.dataset.runtimeHideEmpty === '1';

      if (!next) {
        if (hideWhenEmpty) el.hidden = true;
        return;
      }
      el.setAttribute('href', next);
      if (hideWhenEmpty) el.hidden = false;
    });
  }

  function applyTrackLinks() {
    const lang = root.lang || 'en';
    const href = buildTrackHref(lang);
    trackHrefEls.forEach((el) => {
      el.setAttribute('href', href);
    });
  }

  function applyHomeLinks() {
    const lang = root.lang || 'en';
    const href = buildHomeHref(lang);
    homeHrefEls.forEach((el) => {
      el.setAttribute('href', href);
    });
  }

  // --- Client logos ---

  function installClientLogoFallbacks(scope = document) {
    const logoEls = [...scope.querySelectorAll('img.client-logo')];
    if (!logoEls.length) return;

    const lang = root.lang || 'en';
    const logoSuffix = getText('logos_logo_suffix', lang) || 'logo';

    logoEls.forEach((img) => {
      if (img.dataset.fallbackBound === '1') return;
      img.dataset.fallbackBound = '1';

      img.addEventListener('error', () => {
        const fallbackLabel = String(
          img.dataset.fallback
          || img.alt
          || 'Client'
        )
          .replace(/\s+logo$/i, '')
          .trim() || 'Client';

        const fallback = document.createElement('div');
        fallback.className = 'client-logo client-logo-fallback';
        fallback.setAttribute('role', 'img');
        fallback.setAttribute('aria-label', `${fallbackLabel} ${logoSuffix}`.trim());
        fallback.textContent = fallbackLabel;

        img.replaceWith(fallback);
      }, { once: true });
    });
  }

  function normalizeClientLogoUrl(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (!raw) return '';
    if (raw.startsWith('/')) return raw;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {
      // ignore
    }
    return '';
  }

  function parseClientRecords(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];

    value.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const name = String(item.name || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);

      out.push({
        name,
        logoUrl: normalizeClientLogoUrl(item.logo_url || item.logoUrl),
      });
    });

    return out;
  }

  function renderClientsState(key) {
    if (!clientsRow) return;
    state.clientsStateKey = key;
    clientsRow.innerHTML = '';

    const pill = document.createElement('div');
    pill.className = 'logo-pill logos-state';
    pill.textContent = getText(key, root.lang || 'en') || '';
    clientsRow.appendChild(pill);
  }

  function buildClientCard(client, hidden = false) {
    const card = document.createElement('article');
    card.className = 'client-ref';
    card.setAttribute('title', client.name);
    if (hidden) card.setAttribute('aria-hidden', 'true');

    if (client.logoUrl) {
      const img = document.createElement('img');
      img.className = 'client-logo';
      img.src = client.logoUrl;
      img.alt = `${client.name} logo`;
      img.dataset.fallback = client.name;
      img.loading = 'lazy';
      img.decoding = 'async';
      card.appendChild(img);
    } else {
      const fallback = document.createElement('div');
      fallback.className = 'client-logo client-logo-fallback';
      fallback.setAttribute('role', 'img');
      fallback.setAttribute('aria-label', `${client.name} ${(getText('logos_logo_suffix', root.lang || 'en') || 'logo')}`.trim());
      fallback.textContent = client.name;
      card.appendChild(fallback);
    }

    return card;
  }

  function renderClientsRow(clients) {
    if (!clientsRow) return;
    clientsRow.innerHTML = '';

    if (!Array.isArray(clients) || !clients.length) {
      renderClientsState('logos_unavailable');
      return;
    }

    // C6: Build as infinite marquee when enough clients
    if (clients.length >= 3 && isMotionOn()) {
      const marquee = document.createElement('div');
      marquee.className = 'logos-marquee';
      const track = document.createElement('div');
      track.className = 'logos-track';
      // Duration scales with number of items
      const dur = Math.max(20, clients.length * 5);
      track.style.setProperty('--marquee-dur', `${dur}s`);

      // Duplicate cards for seamless loop
      for (let copy = 0; copy < 2; copy++) {
        clients.forEach((client) => track.appendChild(buildClientCard(client, copy > 0)));
      }

      marquee.appendChild(track);
      clientsRow.appendChild(marquee);
    } else {
      const frag = document.createDocumentFragment();
      clients.forEach((client) => frag.appendChild(buildClientCard(client)));
      clientsRow.appendChild(frag);
    }

    installClientLogoFallbacks(clientsRow);
  }

  function refreshClientsUiForLang() {
    if (!clientsRow) return;
    if (state.latestClients.length) {
      renderClientsRow(state.latestClients);
      return;
    }
    if (state.clientsStateKey) renderClientsState(state.clientsStateKey);
  }

  function resolveClientsEndpoint() {
    const explicit = typeof runtime.clientsEndpoint === 'string' ? runtime.clientsEndpoint.trim() : '';
    if (explicit) return explicit;

    const contactEndpoint = resolveContactEndpoint();
    if (!contactEndpoint) return '';

    if (contactEndpoint.startsWith('/')) {
      const pathname = contactEndpoint.split(/[?#]/, 1)[0];
      return `${pathname.replace(/\/+$/g, '')}/clients`;
    }
    try {
      const url = new URL(contactEndpoint);
      url.pathname = `${url.pathname.replace(/\/+$/g, '')}/clients`;
      return url.toString();
    } catch {
      return '';
    }
  }

  function resolveClientsRequestUrl(endpoint, lang) {
    try {
      const url = endpoint.startsWith('http') ? new URL(endpoint) : new URL(endpoint, window.location.origin);
      if (!url.searchParams.has('locale')) url.searchParams.set('locale', lang);
      if (!endpoint.startsWith('http') && endpoint.startsWith('/')) return `${url.pathname}${url.search}`;
      return url.toString();
    } catch {
      return endpoint;
    }
  }

  async function readJsonSafe(res) {
    if (!res) return null;
    try {
      const text = await res.text();
      if (!text) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function resolvePublicApiKey() {
    const direct = typeof runtime.supabaseAnonKey === 'string' ? runtime.supabaseAnonKey.trim() : '';
    if (direct) return direct;
    const fallback = typeof runtime.publicApiKey === 'string' ? runtime.publicApiKey.trim() : '';
    return fallback || '';
  }

  function withPublicEdgeHeaders(baseHeaders) {
    const headers = { ...(baseHeaders || {}) };
    const apiKey = resolvePublicApiKey();
    if (!apiKey) return headers;
    headers.apikey = apiKey;
    headers.authorization = `Bearer ${apiKey}`;
    return headers;
  }

  async function loadClients() {
    if (!clientsRow) return;

    const endpoint = resolveClientsEndpoint();
    if (!endpoint) {
      state.latestClients = [];
      renderClientsState('logos_unavailable');
      return;
    }

    renderClientsState('logos_loading');

    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), CLIENT_FETCH_TIMEOUT_MS);

    try {
      const lang = root.lang || 'en';
      const response = await fetch(resolveClientsRequestUrl(endpoint, lang), {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        headers: withPublicEdgeHeaders({
          accept: 'application/json',
        }),
        signal: ctrl.signal,
      });

      if (!response.ok) {
        state.latestClients = [];
        renderClientsState('logos_unavailable');
        return;
      }

      const payload = await readJsonSafe(response);
      const clients = parseClientRecords(payload?.clients);
      state.latestClients = clients;
      renderClientsRow(clients);
    } catch {
      state.latestClients = [];
      renderClientsState('logos_unavailable');
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  // --- Contact form ---

  function getMarketingParams() {
    const params = {};
    [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'msclkid',
    ].forEach((key) => {
      const value = query.get(key);
      if (value) params[key] = value;
    });
    return params;
  }

  function setIntakeStatus(formKey, key, tone) {
    const config = getIntakeConfig(formKey);
    if (!config || !config.status) return;
    const lang = root.lang || 'en';
    config.status.textContent = key ? (getText(key, lang) || '') : '';
    config.status.classList.toggle('is-success', tone === 'success');
    config.status.classList.toggle('is-error', tone === 'error');
  }

  function resolveIntakeErrorKey(code, prefix) {
    const c = typeof code === 'string' ? code.trim() : '';
    if (!c) return `${prefix}_status_error`;
    if (c === 'turnstile_required' || c === 'turnstile_invalid') {
      const hasSiteKey = typeof runtime.turnstileSiteKey === 'string' && runtime.turnstileSiteKey.trim().length > 0;
      return hasSiteKey
        ? `${prefix}_status_turnstile_required`
        : `${prefix}_status_turnstile_misconfigured`;
    }
    if (c === 'invalid_email' || c === 'email_required') return `${prefix}_status_invalid_email`;
    if (c === 'full_name_required') return `${prefix}_status_full_name_required`;
    if (c === 'organization_required' || c === 'company_required') {
      return `${prefix}_status_organization_required`;
    }
    if (c === 'domain_not_allowed') return `${prefix}_status_domain_not_allowed`;
    if (c === 'domain_blocked') return `${prefix}_status_domain_blocked`;
    if (c === 'rate_limited') return `${prefix}_status_rate_limited`;
    if (c === 'disabled' || c === 'public_intake_not_allowed') return `${prefix}_status_disabled`;
    return `${prefix}_status_error`;
  }

  function resolveContactErrorKey(code) {
    return resolveIntakeErrorKey(code, 'form');
  }

  function resolveContactEndpoint() {
    return typeof runtime.contactEndpoint === 'string' ? runtime.contactEndpoint.trim() : '';
  }

  function resolveIntakeReceiptReference(data) {
    for (const entry of [data, data?.result]) {
      for (const key of ['request_id', 'id', 'reference', 'request_reference', 'public_reference']) {
        if (typeof entry?.[key] === 'string' && entry[key].trim()) return entry[key].trim();
      }
    }
    return '';
  }

  function appendBackendReference(element, reference) {
    if (!element || !reference) return;
    const label = getText('intake_receipt_reference', root.lang || 'en');
    element.textContent += ' ' + label.replace('{reference}', reference);
  }

  function contactReceiptStatus(data, deduped) {
    const value = (key) => data?.[key] ?? data?.result?.[key];
    const status = String(value('queue_status') || value('status') || '').trim().toLowerCase();
    if (status === 'rejected' || status === 'declined') return 'form_status_rejected';
    if (value('auto_approve_applied') === true) return 'form_status_auto_approve_applied';
    if (status === 'provisioning') return 'form_status_provisioning';
    if (status === 'approved') return 'form_status_approved';
    return deduped ? 'form_status_deduped' : 'form_status_under_review';
  }


  const driverDocumentsForm = document.querySelector('[data-driver-documents-form]');
  const driverDocumentsFields = document.querySelector('[data-driver-documents-fields]');
  const driverDocumentsStatus = document.querySelector('[data-driver-documents-status]');
  let driverDocumentsToken = '';
  let driverDocumentsReview = '';
  let driverDocumentsEpoch = 0;
  let driverDocumentsRetry = '';
  let driverDocumentsPending = false;
  let driverDocumentsPayload = null;
  let driverDocumentsInFlight = false;

  function setDriverDocumentsStatus(key) {
    if (driverDocumentsStatus) driverDocumentsStatus.textContent = getText(key, root.lang || 'en') || '';
  }
  function lockDriverDocumentPayload() {
    const abandon = driverDocumentsForm?.querySelector('[data-driver-documents-abandon]');
    if (abandon) abandon.hidden = !driverDocumentsPending;
    for (const input of driverDocumentsForm?.querySelectorAll('input, textarea') || []) {
      input.disabled = driverDocumentsPending || Boolean(driverDocumentsPayload);
    }
  }
  function clearDriverDocuments() {
    driverDocumentsEpoch += 1;
    driverDocumentsToken = '';
    driverDocumentsReview = '';
    driverDocumentsRetry = '';
    driverDocumentsPending = false;
    driverDocumentsPayload = null;
    if (driverDocumentsForm) { driverDocumentsForm.hidden = true; driverDocumentsForm.reset(); }
    if (driverDocumentsFields) driverDocumentsFields.replaceChildren();
    setDriverDocumentsStatus('');
  }
  function showDriverDocuments(data, token) {
    if (!driverDocumentsForm || !driverDocumentsFields) return;
    if (data.application_state !== 'additional_documents_requested') { clearDriverDocuments(); return; }
    const types = [...new Set(Array.isArray(data.requested_documents) ? data.requested_documents : [])]
      .filter(type => typeof type === 'string' && type.trim());
    const review = JSON.stringify([data.document_review_revision, data.reviewed_at, types]);
    if (driverDocumentsToken === token && driverDocumentsReview === review) return;
    clearDriverDocuments();
    driverDocumentsToken = token;
    driverDocumentsReview = review;
    driverDocumentsForm.hidden = false;
    const addFile = (type, index) => {
      const label = document.createElement('label');
      const title = document.createElement('span');
      title.textContent = type || getText('driver_documents_file', root.lang || 'en');
      const input = document.createElement('input');
      input.type = 'file'; input.name = 'document_file_' + index; input.id = 'driver-return-file-' + index;
      input.required = true; input.dataset.documentType = type;
      input.accept = 'image/jpeg,image/png,application/pdf,application/json';
      label.htmlFor = input.id; label.append(title, input); driverDocumentsFields.append(label);
    };
    types.forEach(addFile);
    if (!types.length) {
      const label = document.createElement('label');
      const title = document.createElement('span');
      title.textContent = getText('driver_documents_type', root.lang || 'en');
      const input = document.createElement('input');
      input.name = 'document_type'; input.id = 'driver-return-type'; input.required = true; input.maxLength = 100;
      label.htmlFor = input.id; label.append(title, input); driverDocumentsFields.append(label);
      addFile('', 0);
    }
    // The token-authorized status response recovers a durable attempt after page reload.
    if (data.document_return_attempt?.state === 'reserved' && typeof data.document_return_attempt.retry_key === 'string') {
      driverDocumentsRetry = data.document_return_attempt.retry_key;
      driverDocumentsPending = true;
      setDriverDocumentsStatus('driver_documents_pending');
    }
    lockDriverDocumentPayload();
  }
  async function submitDriverDocuments(mode = 'submit') {
    if (!driverDocumentsForm || driverDocumentsInFlight || state.driverSignupInFlight || state.driverStatusLookupInFlight || !driverDocumentsToken) return;
    if (mode === 'abandon' && !driverDocumentsPending) return;
    const endpoint = typeof runtime.driverApplicationDocumentsEndpoint === 'string' ? runtime.driverApplicationDocumentsEndpoint.trim() : '';
    if (!endpoint) { setDriverDocumentsStatus('driver_status_missing_endpoint'); return; }
    if (!driverDocumentsPending && !driverDocumentsPayload && !driverDocumentsForm.reportValidity()) return;
    const submittedToken = driverDocumentsToken;
    const submittedEpoch = driverDocumentsEpoch;
    const stillCurrent = () => submittedToken === driverDocumentsToken && submittedEpoch === driverDocumentsEpoch;
    // Snapshot all mutable form data before the first asynchronous file read.
    const files = [...driverDocumentsForm.querySelectorAll('input[type="file"]')].map(input => ({
      file: input.files?.[0],
      type: input.dataset.documentType || driverDocumentsForm.elements.document_type?.value?.trim(),
    }));
    const note = driverDocumentsForm.elements.note?.value?.trim() || null;
    driverDocumentsInFlight = true;
    const release = lockMutableControls([driverDocumentsForm, driverStatusForm]);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PUBLIC_REQUEST_TIMEOUT_MS);
    setDriverDocumentsStatus('driver_documents_sending');
    try {
      if (!driverDocumentsPending && !driverDocumentsPayload) {
        if (files.length > 12 || files.some(({ file }) => !file || file.size > 10 * 1024 * 1024)) {
          setDriverDocumentsStatus('driver_documents_limits'); return;
        }
        const documents = [];
        for (const { file, type } of files) {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
            reader.onerror = reject; reader.readAsDataURL(file);
          });
          if (!stillCurrent() || controller.signal.aborted) return;
          documents.push({ type, file_name: file.name, content_type: file.type || 'application/octet-stream', base64 });
        }
        driverDocumentsRetry = crypto.randomUUID();
        driverDocumentsPayload = { documents, note };
      }
      if (!stillCurrent()) return;
      const body = JSON.stringify({ token: submittedToken, retry_key: driverDocumentsRetry,
        mode: mode === 'abandon' ? 'abandon' : driverDocumentsPending ? 'readback' : 'submit',
        ...(driverDocumentsPending ? {} : driverDocumentsPayload) });
      if (new TextEncoder().encode(body).byteLength > 16 * 1024 * 1024) {
        driverDocumentsRetry = ''; driverDocumentsPayload = null;
        setDriverDocumentsStatus('driver_documents_limits'); return;
      }
      driverDocumentsPending = true;
      const response = await fetch(endpoint, { method: 'POST', mode: 'cors', credentials: 'omit',
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body, signal: controller.signal });
      const data = await readJsonSafe(response);
      if (!stillCurrent()) return;
      if (response.ok && data?.ok === true && data.application_state === 'documents_resubmitted') {
        clearDriverDocuments();
        setDriverStatusLookup('driver_documents_submitted', 'success');
      } else if (response.status === 404 && data?.state === 'not_found') {
        driverDocumentsPending = false;
        if (!driverDocumentsPayload) driverDocumentsRetry = '';
        setDriverDocumentsStatus('driver_documents_retry');
      } else if (response.status === 202 || response.status >= 500 || response.ok) {
        // A malformed HTTP 200 is not success or proof that application did not commit.
        setDriverDocumentsStatus('driver_documents_pending');
      } else {
        // Definite rejection: editable corrections must create a new payload, not replay old bytes.
        driverDocumentsPending = false; driverDocumentsRetry = ''; driverDocumentsPayload = null;
        setDriverDocumentsStatus('driver_documents_failed');
      }
    } catch {
      if (stillCurrent()) setDriverDocumentsStatus(driverDocumentsPending ? 'driver_documents_pending' : 'driver_documents_failed');
    } finally {
      window.clearTimeout(timeout); release(); driverDocumentsInFlight = false; lockDriverDocumentPayload();
    }
  }

  function resolveDriverSignupEndpoint() {
    const explicit = typeof runtime.driverSignupEndpoint === 'string'
      ? runtime.driverSignupEndpoint.trim()
      : '';
    return explicit;
  }

  function resolveDriverStatusEndpoint() {
    const explicit = typeof runtime.driverApplicationStatusEndpoint === 'string'
      ? runtime.driverApplicationStatusEndpoint.trim()
      : '';
    return explicit;
  }

  function setDriverStatusLookup(key, tone) {
    if (!driverStatusLookup) return;
    const lang = root.lang || 'en';
    driverStatusLookup.textContent = key ? (getText(key, lang) || '') : '';
    driverStatusLookup.classList.toggle('is-success', tone === 'success');
    driverStatusLookup.classList.toggle('is-error', tone === 'error');
  }

  function setDriverReviewNote(note) {
    state.driverReviewNote = typeof note === 'string' ? note.trim() : '';
    if (!driverReviewNote) return;
    driverReviewNote.hidden = !state.driverReviewNote;
    driverReviewNote.textContent = state.driverReviewNote
      ? `${getText('driver_status_review_note', root.lang || 'en')}: ${state.driverReviewNote}`
      : '';
  }

  function persistDriverStatusToken(token) {
    const normalized = String(token || '').trim();
    if (!normalized) return;
    try {
      writeStorageValue('localStorage', DRIVER_STATUS_TOKEN_STORAGE_KEY, normalized);
    } catch {
      // ignore
    }
    if (driverStatusForm) {
      const input = driverStatusForm.querySelector('input[name="status_token"]');
      if (input) input.value = normalized;
    }
    if (driverStatusTokenNote) {
      const lang = root.lang || 'en';
      driverStatusTokenNote.textContent = getText('driver_status_token_saved', lang) || normalized;
    }
  }

  function hydrateDriverStatusToken() {
    try {
      const saved = readStorageValue('localStorage', DRIVER_STATUS_TOKEN_STORAGE_KEY);
      if (!saved || !driverStatusForm) return;
      const input = driverStatusForm.querySelector('input[name="status_token"]');
      if (input && !input.value) input.value = saved;
    } catch {
      // ignore
    }
  }

  function resolveDriverStatusKey(data) {
    const status = typeof data?.application_state === 'string' ? data.application_state.trim() : (typeof data?.status === 'string' ? data.status.trim() : '');
    if (status === 'additional_documents_requested') return 'driver_documents_requested';
    if (status === 'documents_resubmitted') return 'driver_documents_submitted';
    if (status === 'compliance_denied') return 'driver_status_compliance_denied';
    if (status === 'pending_review') return 'driver_status_pending';
    if (status === 'pending') return 'driver_status_pending';
    if (status === 'approved') return 'driver_status_approved';
    if (status === 'rejected') return 'driver_status_rejected';
    if (status === 'reverification_required') return 'driver_status_reverification';
    return 'driver_status_unknown';
  }

  function getDriverStatusInput() {
    if (!driverStatusForm) return null;
    return driverStatusForm.querySelector('input[name="status_token"]');
  }

  function revealDriverSection(options = {}) {
    const driverSection = document.getElementById('drivers');
    if (!driverSection) return;

    const focusStatus = Boolean(options.focusStatus);
    const focusTarget = focusStatus
      ? getDriverStatusInput()
      : (driverForm ? driverForm.querySelector('input[name="full_name"]') : null);

    driverSection.scrollIntoView({
      behavior: isMotionOn() ? 'smooth' : 'auto',
      block: 'start',
    });
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus({ preventScroll: true });
    }
  }

  async function applyDriverRoute() {
    if (driverRoute.mode === 'default') return;

    const isStatusRoute = driverRoute.mode === 'status';
    revealDriverSection({ focusStatus: isStatusRoute });

    if (!isStatusRoute) return;

    const input = getDriverStatusInput();
    const token = String(driverRoute.token || '').trim();
    if (!input || !token) return;

    input.value = token;
    persistDriverStatusToken(token);
    await submitDriverStatusLookup();
  }

  // --- Turnstile ---

  function hasTurnstile(formKey = resolveDefaultTurnstileKey()) {
    const config = getTurnstileConfig(formKey);
    return Boolean(config && config.turnstileHost && runtime.turnstileSiteKey);
  }

  function getTurnstileResponseInput(formKey = resolveDefaultTurnstileKey()) {
    const config = getTurnstileConfig(formKey);
    if (!config || !config.turnstileHost) return null;
    return config.turnstileHost.querySelector('input[name="cf-turnstile-response"]');
  }

  function clearTurnstileToken(formKey = resolveDefaultTurnstileKey()) {
    const turnstileState = getTurnstileState(formKey);
    if (turnstileState) turnstileState.token = '';
    const input = getTurnstileResponseInput(formKey);
    if (input && typeof input.value === 'string') input.value = '';
    input?.removeAttribute('value');
  }

  function getTurnstileToken(formKey = resolveDefaultTurnstileKey()) {
    const turnstileState = getTurnstileState(formKey);
    const token = typeof turnstileState?.token === 'string' ? turnstileState.token.trim() : '';
    if (token) return token;
    const input = getTurnstileResponseInput(formKey);
    const inputValue = input && typeof input.value === 'string' ? input.value.trim() : '';
    return inputValue || String(input?.getAttribute('value') || '').trim();
  }

  function setTurnstileVisibility(formKey = resolveDefaultTurnstileKey()) {
    const config = getTurnstileConfig(formKey);
    if (!config || !config.turnstileHost) return;
    config.turnstileHost.style.display = hasTurnstile(formKey) ? '' : 'none';
  }

  function renderTurnstile(formKey = resolveDefaultTurnstileKey()) {
    if (!hasTurnstile(formKey)) return;
    const api = window.turnstile;
    if (!api || typeof api.render !== 'function') return;
    const config = getTurnstileConfig(formKey);
    const turnstileState = getTurnstileState(formKey);
    if (!config || !config.turnstileHost || !turnstileState) return;

    clearTurnstileToken(formKey);

    try {
      if (turnstileState.widgetId && typeof api.remove === 'function') {
        api.remove(turnstileState.widgetId);
      }
    } catch {
      // ignore
    }

    turnstileState.widgetId = null;
    config.turnstileHost.innerHTML = '';

    const theme = isDarkTheme() ? 'dark' : 'light';

    try {
      turnstileState.widgetId = api.render(config.turnstileHost, {
        sitekey: String(runtime.turnstileSiteKey),
        theme,
        callback: (token) => {
          turnstileState.token = String(token || '');
        },
        'expired-callback': () => {
          turnstileState.token = '';
        },
        'error-callback': () => {
          turnstileState.token = '';
        },
      });
    } catch {
      // ignore
    }
  }

  function ensureTurnstile() {
    Object.keys(turnstileConfigs).forEach((formKey) => setTurnstileVisibility(formKey));
    if (!Object.keys(turnstileConfigs).some((formKey) => hasTurnstile(formKey))) return;
    if (window.turnstile && typeof window.turnstile.render === 'function') {
      Object.keys(turnstileConfigs).forEach((formKey) => renderTurnstile(formKey));
      return;
    }
    if (document.readyState !== 'complete') {
      window.addEventListener('load', ensureTurnstile, { once: true });
      return;
    }
    if (document.querySelector('script[data-turnstile-api]')) return;

    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.dataset.turnstileApi = 'true';
    script.onload = () => {
      Object.keys(turnstileConfigs).forEach((formKey) => renderTurnstile(formKey));
    };
    document.head.appendChild(script);
  }

  function resetTurnstile(formKey = resolveDefaultTurnstileKey()) {
    clearTurnstileToken(formKey);
    const api = window.turnstile;
    const turnstileState = getTurnstileState(formKey);
    if (!api || !turnstileState || !turnstileState.widgetId) return;
    try {
      if (typeof api.reset === 'function') api.reset(turnstileState.widgetId);
    } catch {
      // ignore
    }
  }

  function finalizeTurnstileSubmission(formKey, submittedToken) {
    const consumedToken = String(submittedToken || '').trim();
    if (!hasTurnstile(formKey) || !consumedToken) return;
    const currentToken = getTurnstileToken(formKey);
    if (currentToken && currentToken !== consumedToken) return;
    resetTurnstile(formKey);
  }

  function refreshTurnstileTheme() {
    if (!Object.keys(turnstileConfigs).some((formKey) => hasTurnstile(formKey))) return;
    if (!window.turnstile || typeof window.turnstile.render !== 'function') return;
    Object.keys(turnstileConfigs).forEach((formKey) => renderTurnstile(formKey));
  }

  function parseCsvList(rawValue) {
    return String(rawValue || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  async function submitContactRequest(action = 'contact') {
    const config = getIntakeConfig(action);
    if (!config || !config.form) return;
    if (state.contactInFlight) return;

    const contactEndpoint = action === 'tenant'
      ? String(runtime.tenantSignupEndpoint || '').trim() : resolveContactEndpoint();
    if (!contactEndpoint) {
      setIntakeStatus(action, action === 'tenant' ? 'tenant_form_status_missing_endpoint' : 'form_status_missing_endpoint', 'error');
      return;
    }

    if (typeof config.form.checkValidity === 'function' && !config.form.checkValidity()) {
      if (typeof config.form.reportValidity === 'function') config.form.reportValidity();
      return;
    }

    const turnstileToken = getTurnstileToken('contact');
    if (hasTurnstile('contact') && !turnstileToken) {
      setIntakeStatus(action, 'form_status_turnstile_required', 'error');
      return;
    }

    const fd = new FormData(config.form);
    const volume = String(fd.get('volume') || '').trim();
    const role = String(fd.get('role') || '').trim();
    const requestContext = String(fd.get('request_context') || '').trim();
    const organizationName = String(fd.get('organization_name') || '').trim();
    const marketingParams = getMarketingParams();
    const payload = {
      email: String(fd.get('email') || '').trim(),
      full_name: String(fd.get('full_name') || '').trim(),
      organization_name: organizationName,
      company: organizationName,
      website_url: String(fd.get('website_url') || '').trim(),
      volume,
      role,
      notes: String(fd.get('notes') || '').trim(),
      locale: root.lang || 'en',
      page_url: window.location.href,
      referrer: document.referrer || '',
      marketing: {
        ...marketingParams,
        ...(volume ? { monthly_volume: volume } : {}),
        ...(role ? { role } : {}),
        ...(requestContext ? { request_context: requestContext } : {}),
      },
      turnstile_token: hasTurnstile('contact') ? turnstileToken : undefined,
    };

    state.contactInFlight = true;
    const wasSubmitDisabled = Boolean(config.submitBtn?.disabled);
    const releaseMutableControlLock = lockMutableControls([config.form]);
    if (config.submitBtn) config.submitBtn.disabled = true;
    setIntakeStatus(action, 'form_status_sending');

    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), PUBLIC_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(contactEndpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: withPublicEdgeHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
        }),
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      const data = await readJsonSafe(res);

      if (!res.ok) {
        const code = data && typeof data === 'object' ? data?.error?.code : '';
        setIntakeStatus(action, resolveContactErrorKey(code), 'error');
        return;
      }

      if (!data || typeof data !== 'object' || data.ok !== true) {
        setIntakeStatus(action, resolveContactErrorKey(data?.error?.code), 'error');
        return;
      }

      const reference = resolveIntakeReceiptReference(data);
      // Tenant signup is only accepted with a backend reference; keep the form for a retry.
      if (action === 'tenant' && !reference) {
        setIntakeStatus(action, resolveContactErrorKey(''), 'error');
        return;
      }

      const deduped = Boolean(data && typeof data === 'object' && data.deduped === true);
      setIntakeStatus(
        action,
        contactReceiptStatus(data, deduped),
        'success'
      );
      appendBackendReference(config.status, reference);
      config.form.reset();
    } catch (error) {
      setIntakeStatus(action, error?.name === 'AbortError' ? 'form_status_timeout' : 'form_status_error', 'error');
    } finally {
      state.contactInFlight = false;
      window.clearTimeout(timeoutId);
      finalizeTurnstileSubmission('contact', turnstileToken);
      releaseMutableControlLock();
      if (config.submitBtn) config.submitBtn.disabled = wasSubmitDisabled;
    }
  }

  async function submitDriverRequest() {
    const config = getIntakeConfig('driver');
    if (!config || !config.form) return;
    if (state.driverSignupInFlight || state.driverStatusLookupInFlight || driverDocumentsInFlight) return;

    const driverEndpoint = resolveDriverSignupEndpoint();
    const entryKey = typeof runtime.driverSignupEntryKey === 'string' ? runtime.driverSignupEntryKey.trim() : '';
    if (!driverEndpoint || !entryKey) {
      setIntakeStatus('driver', 'driver_form_status_missing_endpoint', 'error');
      return;
    }

    if (typeof config.form.checkValidity === 'function' && !config.form.checkValidity()) {
      if (typeof config.form.reportValidity === 'function') config.form.reportValidity();
      return;
    }

    const turnstileToken = getTurnstileToken('driver');
    if (hasTurnstile('driver') && !turnstileToken) {
      setIntakeStatus('driver', 'driver_form_status_turnstile_required', 'error');
      return;
    }

    const fd = new FormData(config.form);
    const city = String(fd.get('city') || '').trim();
    const vehicleType = String(fd.get('vehicle_type') || '').trim();
    const languages = parseCsvList(fd.get('languages'));
    const capabilities = parseCsvList(fd.get('capabilities'));
    const payload = {
      entry_key: entryKey,
      email: String(fd.get('email') || '').trim(),
      full_name: String(fd.get('full_name') || '').trim(),
      organization_name: String(fd.get('organization_name') || '').trim(),
      phone: String(fd.get('phone') || '').trim(),
      locale: root.lang || 'en',
      page_url: window.location.href,
      referrer: document.referrer || '',
      experience_summary: String(fd.get('experience_summary') || '').trim(),
      capabilities_requested: capabilities,
      verification_documents: [],
      marketing: {
        ...getMarketingParams(),
        ...(city ? { city } : {}),
        ...(vehicleType ? { vehicle_type: vehicleType } : {}),
        ...(languages.length ? { languages } : {}),
      },
      turnstile_token: hasTurnstile('driver') ? turnstileToken : undefined,
    };

    state.driverSignupInFlight = true;
    const wasSubmitDisabled = Boolean(config.submitBtn?.disabled);
    const releaseMutableControlLock = lockMutableControls([config.form]);
    if (config.submitBtn) config.submitBtn.disabled = true;
    setIntakeStatus('driver', 'driver_form_status_sending');

    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), PUBLIC_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(driverEndpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      const data = await readJsonSafe(res);

      if (!res.ok) {
        const code = data && typeof data === 'object' ? data?.error?.code : '';
        setIntakeStatus('driver', resolveIntakeErrorKey(code, 'driver_form'), 'error');
        return;
      }

      if (!data || typeof data !== 'object' || data.ok !== true) {
        setIntakeStatus('driver', resolveIntakeErrorKey(data?.error?.code, 'driver_form'), 'error');
        return;
      }

      clearDriverDocuments();
      state.driverReceiptReference = resolveIntakeReceiptReference(data);
      const deduped = Boolean(data && typeof data === 'object' && data.deduped === true);
      const statusToken = data && typeof data === 'object'
        ? String(data.application_status_token || '').trim()
        : '';
      setIntakeStatus(
        'driver',
        deduped ? 'driver_form_status_deduped' : 'driver_form_status_under_review',
        'success'
      );
      appendBackendReference(config.status, state.driverReceiptReference);
      if (statusToken) {
        persistDriverStatusToken(statusToken);
        setDriverStatusLookup('driver_status_token_saved', 'success');
        if (resolveDriverStatusEndpoint()) await submitDriverStatusLookup({ fromSignup: true, receiptReference: state.driverReceiptReference });
      }
      config.form.reset();
    } catch (error) {
      setIntakeStatus('driver', error?.name === 'AbortError' ? 'driver_form_status_timeout' : 'driver_form_status_error', 'error');
    } finally {
      state.driverSignupInFlight = false;
      window.clearTimeout(timeoutId);
      finalizeTurnstileSubmission('driver', turnstileToken);
      releaseMutableControlLock();
      if (config.submitBtn) config.submitBtn.disabled = wasSubmitDisabled;
    }
  }

  async function submitDriverStatusLookup(options = {}) {
    if (!driverStatusForm) return;
    // Only the owning signup may continue into its immediate status refresh.
    if (state.driverStatusLookupInFlight || driverDocumentsInFlight || (state.driverSignupInFlight && options.fromSignup !== true)) return;
    setDriverReviewNote('');

    const statusEndpoint = resolveDriverStatusEndpoint();
    if (!statusEndpoint) {
      setDriverStatusLookup('driver_status_missing_endpoint', 'error');
      return;
    }

    if (typeof driverStatusForm.checkValidity === 'function' && !driverStatusForm.checkValidity()) {
      if (typeof driverStatusForm.reportValidity === 'function') driverStatusForm.reportValidity();
      return;
    }

    const fd = new FormData(driverStatusForm);
    const token = String(fd.get('status_token') || '').trim();
    if (!token) {
      setDriverStatusLookup('driver_status_missing_token', 'error');
      return;
    }

    const generation = ++state.driverStatusLookupGeneration;
    const isCurrentLookup = () => generation === state.driverStatusLookupGeneration
      && String(getDriverStatusInput()?.value || '').trim() === token;
    state.driverStatusLookupInFlight = true;
    const wasSubmitDisabled = Boolean(driverStatusSubmitBtn?.disabled);
    const releaseMutableControlLock = lockMutableControls([driverStatusForm]);
    if (driverStatusSubmitBtn) driverStatusSubmitBtn.disabled = true;
    setDriverStatusLookup('driver_status_status_lookup');

    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), PUBLIC_REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(statusEndpoint, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ token }),
        signal: ctrl.signal,
      });

      const data = await readJsonSafe(res);
      if (!isCurrentLookup()) return;

      if (!res.ok) {
        const code = data && typeof data === 'object' ? data?.error?.code : '';
        clearDriverDocuments();
        setDriverStatusLookup(code === 'not_found' || code === 'request_not_found' ? 'driver_status_not_found' : 'driver_status_error', 'error');
        return;
      }

      if (!data || typeof data !== 'object' || data.ok !== true) {
        const code = data?.error?.code;
        clearDriverDocuments();
        setDriverStatusLookup(code === 'not_found' ? 'driver_status_not_found' : 'driver_status_error', 'error');
        return;
      }

      persistDriverStatusToken(token);
      showDriverDocuments(data, token);
      setDriverReviewNote(data?.review_reason);
      setDriverStatusLookup(resolveDriverStatusKey(data), 'success');
      if (options.receiptReference && options.receiptReference === state.driverReceiptReference) {
        setIntakeStatus('driver', resolveDriverStatusKey(data), 'success');
        appendBackendReference(driverStatus, options.receiptReference);
      }
    } catch (error) {
      if (!isCurrentLookup()) return;
      clearDriverDocuments();
      setDriverStatusLookup(error?.name === 'AbortError' ? 'driver_status_timeout' : 'driver_status_error', 'error');
    } finally {
      state.driverStatusLookupInFlight = false;
      window.clearTimeout(timeoutId);
      releaseMutableControlLock();
      if (driverStatusSubmitBtn) driverStatusSubmitBtn.disabled = wasSubmitDisabled;
    }
  }

  // --- Public tracking ---

  const TRACKING_SESSION_KEY = 'masarx_tracking_session_v1';

  function resolveTrackingEndpoint() {
    return typeof runtime.trackingEndpoint === 'string' ? runtime.trackingEndpoint.trim() : '';
  }

  function resolveTrackingUrl(action) {
    const endpoint = resolveTrackingEndpoint();
    if (!endpoint) return '';
    const suffix = String(action || '').replace(/^\/+/, '');
    if (!suffix) return endpoint;
    if (endpoint.startsWith('/')) return `${endpoint.replace(/\/+$/g, '')}/${suffix}`;
    try {
      const url = new URL(endpoint);
      url.pathname = `${url.pathname.replace(/\/+$/g, '')}/${suffix}`;
      return url.toString();
    } catch {
      return '';
    }
  }

  function setTrackingStage(stage) {
    state.trackingStage = stage;
    if (lookupStage) lookupStage.hidden = stage !== 'lookup';
    if (verifyStage) verifyStage.hidden = stage !== 'verify';
    if (resultsStage) resultsStage.hidden = stage !== 'results';
    refreshTrackingRequestsLinks();
    if (stage === 'results') {
      ensureTrackingMap('inline');
      invalidateMap(mapControllers.inline);
      if (state.mapPin) focusMapOnPin(mapControllers.inline, mapControllers.inline.map?.getZoom() || mapRuntime.defaultZoom);
    }
  }

  function refreshTrackingRequestsLinks() {
    const hasResults = state.trackingStage === 'results';
    const key = hasResults ? 'track_nav_actions' : 'track_nav_lookup';
    trackRequestsLinks.forEach((link) => {
      link.setAttribute('href', hasResults ? '#actions' : '#lookup');
      link.dataset.i18n = key;
      link.textContent = getText(key, root.lang || 'en');
    });
  }

  function focusTrackingReferenceInput({ preventScroll = false } = {}) {
    const input = trackLookupForm && trackLookupForm.querySelector('input[name="reference"]');
    if (!input) return;
    input.focus({ preventScroll });
    if (typeof input.select === 'function') input.select();
  }

  function resetTrackingFlow({ clearReference = true, scroll = false } = {}) {
    if (hasTrackingMutationInFlight()) return false;
    invalidateTrackingRequests();
    saveTrackingSession('');
    state.trackingReference = '';
    state.trackingPayload = null;
    closeMapOverlay();
    clearTrackingRequestBanner();

    if (trackLookupForm) {
      if (clearReference) trackLookupForm.reset();
      setTrackingStatus(trackLookupStatus, '');
    }
    if (trackVerifyForm) {
      trackVerifyForm.reset();
      setTrackingStatus(trackVerifyStatus, '');
    }
    if (trackRescheduleForm) {
      trackRescheduleForm.reset();
      setTrackingStatus(trackRescheduleStatus, '');
      delete trackRescheduleForm.dataset.available;
    }
    if (trackLocationForm) {
      trackLocationForm.reset();
      setTrackingStatus(trackLocationStatus, '');
    }

    resetMapPin();
    setTrackingStage('lookup');
    resetTurnstile();

    const scrollTarget = scroll && lookupStage;
    if (scrollTarget) {
      scrollTarget.scrollIntoView({ behavior: isMotionOn() ? 'smooth' : 'auto', block: 'start' });
    }
    focusTrackingReferenceInput({ preventScroll: Boolean(scrollTarget) });
    return true;
  }

  function setTrackingStatus(el, key, tone) {
    if (!el) return;
    const lang = root.lang || 'en';
    el.textContent = key ? (getText(key, lang) || '') : '';
    el.classList.toggle('is-success', tone === 'success');
    el.classList.toggle('is-error', tone === 'error');
  }

  function resolveTrackingErrorKey(code) {
    const normalized = typeof code === 'string' ? code.trim() : '';
    if (!normalized) return 'track_status_error';
    if (normalized === 'turnstile_required' || normalized === 'turnstile_invalid') return 'track_status_turnstile_required';
    if (normalized === 'invalid_reference') return 'track_status_invalid_reference';
    if (normalized === 'verification_failed') return 'track_status_verification_failed';
    if (normalized === 'invalid_session') return 'track_status_invalid_session';
    if (normalized === 'invalid_request') return 'track_status_invalid_request';
    if (normalized === 'rate_limited') return 'track_status_rate_limited';
    if (normalized === 'disabled') return 'track_status_disabled';
    return 'track_status_error';
  }

  function resolveTrackingRequestStatusKey(outcome) {
    if (outcome === 'applied') return 'track_status_request_applied';
    if (outcome === 'rejected') return 'track_status_request_rejected';
    return 'track_status_request_pending_review';
  }

  function clearTrackingRequestBanner() {
    if (!trackRequestBanner) return;
    trackRequestBanner.hidden = true;
    delete trackRequestBanner.dataset.tone;
    if (trackRequestBannerBadge) trackRequestBannerBadge.textContent = '';
    if (trackRequestBannerText) trackRequestBannerText.textContent = '';
    if (trackRequestBannerCase) { trackRequestBannerCase.textContent = ''; trackRequestBannerCase.hidden = true; }
  }

  function setTrackingRequestBanner(outcome, data) {
    if (!trackRequestBanner || !trackRequestBannerBadge || !trackRequestBannerText) return;
    const normalized = typeof outcome === 'string' ? outcome.trim().toLowerCase() : '';
    const tone = normalized === 'applied' ? 'success' : normalized === 'rejected' ? 'danger' : 'warning';
    const badgeKey = normalized === 'applied'
      ? 'track_request_outcome_applied'
      : normalized === 'rejected'
        ? 'track_request_outcome_rejected'
        : 'track_request_outcome_pending_review';
    const textKey = normalized === 'applied'
      ? 'track_request_banner_applied'
      : normalized === 'rejected'
        ? 'track_request_banner_rejected'
        : 'track_request_banner_pending_review';

    trackRequestBanner.dataset.tone = tone;
    trackRequestBannerBadge.textContent = getText(badgeKey, root.lang || 'en') || '';
    trackRequestBannerText.textContent = getText(textKey, root.lang || 'en') || '';
    if (trackRequestBannerCase) {
      const reference = typeof data?.support_case_id === 'string' ? data.support_case_id.trim() : '';
      trackRequestBannerCase.textContent = '';
      trackRequestBannerCase.hidden = !reference;
      appendBackendReference(trackRequestBannerCase, reference);
    }
    trackRequestBanner.hidden = false;
  }

  function formatDate(value) {
    if (!value) return getText('track_not_available', root.lang || 'en') || '';
    try {
      const formatter = new Intl.DateTimeFormat(root.lang || 'en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      return formatter.format(new Date(value));
    } catch {
      return String(value);
    }
  }

  function formatTrackingLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return getText('track_not_available', root.lang || 'en') || '';

    const normalized = raw.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return getText('track_not_available', root.lang || 'en') || '';

    if ((root.lang || 'en') === 'ar') return normalized;
    return normalized.replace(/\b([a-z])/g, (match) => match.toUpperCase());
  }

  function resolveTrackingValueLabel(kind, value) {
    const raw = String(value || '').trim();
    if (!raw) return getText('track_not_available', root.lang || 'en') || '';

    const normalizedKey = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (normalizedKey) {
      const translated = getText(`track_${kind}_value_${normalizedKey}`, root.lang || 'en');
      if (translated) return translated;
    }

    return formatTrackingLabel(raw);
  }

  function formatDateRange(startAt, endAt, fallbackDate) {
    if (!startAt && !endAt && !fallbackDate) return getText('track_not_available', root.lang || 'en') || '';
    if (!startAt && !endAt) return formatDate(fallbackDate);
    try {
      const formatter = new Intl.DateTimeFormat(root.lang || 'en', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      const startLabel = startAt ? formatter.format(new Date(startAt)) : '';
      const endLabel = endAt ? formatter.format(new Date(endAt)) : '';
      return [startLabel, endLabel].filter(Boolean).join(' - ');
    } catch {
      return formatDate(fallbackDate || startAt || endAt);
    }
  }

  function saveTrackingSession(token) {
    state.trackingSessionToken = token || '';
    writeStorageValue('sessionStorage', TRACKING_SESSION_KEY, token);
  }

  function loadTrackingSession() {
    return readStorageValue('sessionStorage', TRACKING_SESSION_KEY);
  }

  function setRescheduleAvailability(dates, enabled, { preserveStatus = false } = {}) {
    if (!trackRescheduleForm || !trackDateSelect) return;

    const availableDates = Array.isArray(dates) ? dates.filter(Boolean) : [];
    const isAvailable = enabled !== false && availableDates.length > 0;
    const mutationLocked = hasTrackingMutationInFlight();
    const preserveCurrentStatus = preserveStatus || mutationLocked;
    trackDateSelect.disabled = !isAvailable || mutationLocked;
    if (!isAvailable) trackDateSelect.value = '';

    const notesField = trackRescheduleForm.querySelector('textarea[name="notes"]');
    if (notesField) notesField.disabled = !isAvailable || mutationLocked;
    if (trackRescheduleSubmitBtn) trackRescheduleSubmitBtn.disabled = !isAvailable || mutationLocked;
    trackRescheduleForm.dataset.available = isAvailable ? '1' : '0';

    if (!isAvailable) {
      if (!preserveCurrentStatus) setTrackingStatus(trackRescheduleStatus, 'track_reschedule_unavailable');
      return;
    }

    if (!preserveCurrentStatus && !trackRescheduleStatus?.classList.contains('is-success')) {
      setTrackingStatus(trackRescheduleStatus, '');
    }
  }

  function reapplyTrackingMutationPolicy() {
    const tracking = state.trackingPayload && typeof state.trackingPayload === 'object'
      ? state.trackingPayload.tracking || state.trackingPayload
      : null;
    if (!tracking) return;
    const reschedule = tracking.actions?.reschedule || {};
    setRescheduleAvailability(
      reschedule.available_dates,
      reschedule.enabled,
      { preserveStatus: true }
    );
  }

  function renderTrackingDates(rescheduleAction) {
    if (!trackDateSelect) return;
    const reschedule = rescheduleAction && typeof rescheduleAction === 'object' ? rescheduleAction : {};
    const dates = Array.isArray(reschedule.available_dates) ? reschedule.available_dates.filter(Boolean) : [];
    const placeholder = getText('track_reschedule_placeholder', root.lang || 'en') || '';
    trackDateSelect.innerHTML = '';
    const emptyOption = document.createElement('option');
    emptyOption.value = '';
    emptyOption.textContent = placeholder;
    trackDateSelect.appendChild(emptyOption);

    dates.forEach((date) => {
      const option = document.createElement('option');
      option.value = String(date || '');
      option.textContent = formatDate(date);
      trackDateSelect.appendChild(option);
    });

    setRescheduleAvailability(dates, reschedule.enabled);
  }

  function renderTrackingTimeline(items) {
    if (!trackTimeline) return;
    trackTimeline.innerHTML = '';
    const lang = root.lang || 'en';
    const timelineItems = Array.isArray(items) ? items : [];
    if (!timelineItems.length) {
      const empty = document.createElement('li');
      empty.className = 'track-timeline-empty';
      empty.textContent = getText('track_timeline_empty', lang) || '';
      trackTimeline.appendChild(empty);
      return;
    }

    timelineItems.forEach((item) => {
      const row = document.createElement('li');
      row.className = 'track-timeline-item';
      const status = document.createElement('strong');
      status.textContent = resolveTrackingValueLabel('status', item?.summary || item?.status || item?.action_type || '');
      const meta = document.createElement('span');
      meta.textContent = formatDate(item?.timestamp);
      row.appendChild(status);
      row.appendChild(meta);
      trackTimeline.appendChild(row);
    });
  }

  function renderTrackingPayload(payload) {
    state.trackingPayload = payload;
    const tracking = payload && typeof payload === 'object' ? payload.tracking || payload : null;
    const shipment = tracking?.shipment || {};
    const recipient = tracking?.recipient || {};
    const address = tracking?.address || {};
    const timeline = tracking?.timeline || [];
    const actions = tracking?.actions || {};
    const reference = shipment.client_reference_number || shipment.carrier_reference_number || shipment.tracking_number || '';

    if (trackShipmentReference) trackShipmentReference.textContent = reference || '';
    if (trackShipmentTracking) trackShipmentTracking.textContent = shipment.tracking_number || '';
    if (trackShipmentClientRef) trackShipmentClientRef.textContent = shipment.client_reference_number || (getText('track_not_available', root.lang || 'en') || '');
    if (trackShipmentCarrierRef) trackShipmentCarrierRef.textContent = shipment.carrier_reference_number || (getText('track_not_available', root.lang || 'en') || '');
    if (trackShipmentStatus) trackShipmentStatus.textContent = resolveTrackingValueLabel('status', shipment.status);
    if (trackShipmentService) trackShipmentService.textContent = shipment.service_type ? resolveTrackingValueLabel('service', shipment.service_type) : (getText('track_not_available', root.lang || 'en') || '');
    if (trackShipmentPromise) {
      trackShipmentPromise.textContent = formatDateRange(
        shipment.promised_window_start_at,
        shipment.promised_window_end_at,
        shipment.promised_delivery_date
      );
    }
    if (trackShipmentCreated) trackShipmentCreated.textContent = formatDate(shipment.created_at);
    if (trackRecipientName) trackRecipientName.textContent = recipient.name || '';
    if (trackRecipientPhone) trackRecipientPhone.textContent = recipient.phone || '';
    if (trackRecipientEmail) trackRecipientEmail.textContent = recipient.email || '';
    if (trackAddressCity) trackAddressCity.textContent = address.city || (getText('track_not_available', root.lang || 'en') || '');
    if (trackAddressDistrict) trackAddressDistrict.textContent = address.district || (getText('track_not_available', root.lang || 'en') || '');
    if (trackAddressShort) trackAddressShort.textContent = address.short_national_address || (getText('track_not_available', root.lang || 'en') || '');

    renderTrackingTimeline(timeline);
    renderTrackingDates(actions?.reschedule || {});
    const request = tracking?.request;
    if (typeof request?.outcome === 'string' && request.outcome.trim()) {
      setTrackingRequestBanner(request.outcome, request);
    } else {
      clearTrackingRequestBanner();
    }
  }

  function captureTrackingRequestDraft(kind) {
    if (kind === 'reschedule_date' && trackRescheduleForm) {
      const notesField = trackRescheduleForm.querySelector('textarea[name="notes"]');
      return {
        requested_date: String(trackDateSelect?.value || '').trim(),
        notes: String(notesField?.value || '').trim(),
      };
    }
    if (kind === 'location_change' && trackLocationForm) {
      const addressField = trackLocationForm.querySelector('textarea[name="address_text"]');
      const shortField = trackLocationForm.querySelector('input[name="short_national_address"]');
      const landmarkField = trackLocationForm.querySelector('input[name="landmark"]');
      const dropPointField = trackLocationForm.querySelector('textarea[name="drop_point"]');
      const notesField = trackLocationForm.querySelector('textarea[name="notes"]');
      return {
        address_text: String(addressField?.value || '').trim(),
        short_national_address: String(shortField?.value || '').trim(),
        landmark: String(landmarkField?.value || '').trim(),
        drop_point: String(dropPointField?.value || '').trim(),
        notes: String(notesField?.value || '').trim(),
        map_pin: state.mapPin ? { lat: state.mapPin.lat, lng: state.mapPin.lng } : null,
        map_pin_confirmed: Boolean(state.mapPinConfirmed),
      };
    }
    return null;
  }

  function restoreTrackingRequestDraft(kind, draft) {
    if (!draft || typeof draft !== 'object') return;
    if (kind === 'reschedule_date' && trackRescheduleForm) {
      if (trackDateSelect && typeof draft.requested_date === 'string') {
        if ([...trackDateSelect.options].some((option) => option.value === draft.requested_date)) {
          trackDateSelect.value = draft.requested_date;
        }
      }
      const notesField = trackRescheduleForm.querySelector('textarea[name="notes"]');
      if (notesField && typeof draft.notes === 'string') notesField.value = draft.notes;
      return;
    }
    if (kind === 'location_change' && trackLocationForm) {
      const addressField = trackLocationForm.querySelector('textarea[name="address_text"]');
      const shortField = trackLocationForm.querySelector('input[name="short_national_address"]');
      const landmarkField = trackLocationForm.querySelector('input[name="landmark"]');
      const dropPointField = trackLocationForm.querySelector('textarea[name="drop_point"]');
      const notesField = trackLocationForm.querySelector('textarea[name="notes"]');
      if (addressField && typeof draft.address_text === 'string') addressField.value = draft.address_text;
      if (shortField && typeof draft.short_national_address === 'string') shortField.value = draft.short_national_address;
      if (landmarkField && typeof draft.landmark === 'string') landmarkField.value = draft.landmark;
      if (dropPointField && typeof draft.drop_point === 'string') dropPointField.value = draft.drop_point;
      if (notesField && typeof draft.notes === 'string') notesField.value = draft.notes;
      if (draft.map_pin && Number.isFinite(draft.map_pin.lat) && Number.isFinite(draft.map_pin.lng)) {
        setMapPin(draft.map_pin.lat, draft.map_pin.lng, { centerAll: false, centerActiveMap: false });
        if (draft.map_pin_confirmed) confirmMapPin();
      }
    }
  }

  async function postTracking(action, body, controller = new AbortController()) {
    const url = resolveTrackingUrl(action);
    if (!url) throw new Error('missing_tracking_endpoint');
    const timeoutId = window.setTimeout(() => controller.abort(), PUBLIC_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        headers: withPublicEdgeHeaders({
          accept: 'application/json',
          'content-type': 'application/json',
        }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await readJsonSafe(response);
      return { response, data };
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function restoreTrackingRequestSubmitButton(kind, button, wasDisabled) {
    if (!button) return;
    if (wasDisabled) {
      button.disabled = true;
      return;
    }
    if (kind === 'reschedule_date' && trackRescheduleForm?.dataset.available !== '1') {
      button.disabled = true;
      return;
    }
    button.disabled = false;
  }

  function asFiniteNumber(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }

  function normalizeLat(value) {
    return Math.max(-85, Math.min(85, asFiniteNumber(value, 0)));
  }

  function normalizeLng(value) {
    let next = asFiniteNumber(value, 0);
    while (next > 180) next -= 360;
    while (next < -180) next += 360;
    return next;
  }

  const mapRuntime = {
    tileUrl: typeof runtime.mapTileUrl === 'string' && runtime.mapTileUrl.trim()
      ? runtime.mapTileUrl.trim()
      : 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: typeof runtime.mapTileAttribution === 'string' && runtime.mapTileAttribution.trim()
      ? runtime.mapTileAttribution.trim()
      : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    defaultLat: normalizeLat(runtime.mapDefaultLat ?? 24.7136),
    defaultLng: normalizeLng(runtime.mapDefaultLng ?? 46.6753),
    defaultZoom: Math.max(3, Math.min(18, Math.round(asFiniteNumber(runtime.mapDefaultZoom, 11)))),
    locateZoom: Math.max(3, Math.min(19, Math.round(asFiniteNumber(runtime.mapLocateZoom, 16)))),
    maxZoom: Math.max(3, Math.min(20, Math.round(asFiniteNumber(runtime.mapMaxZoom, 19)))),
  };

  const mapControllers = {
    inline: {
      key: 'inline',
      container: trackMapPicker,
      map: null,
      marker: null,
    },
    expanded: {
      key: 'expanded',
      container: trackMapDialogPicker,
      map: null,
      marker: null,
    },
  };

  function getLeaflet() {
    const maybeLeaflet = window.L;
    return maybeLeaflet && typeof maybeLeaflet.map === 'function' ? maybeLeaflet : null;
  }

  function formatMapCoord(value) {
    return asFiniteNumber(value, 0).toFixed(5);
  }

  function setMapStatus(keyOrText = '', tone = 'neutral', options = {}) {
    if (!trackMapStatus) return;
    const lang = root.lang || 'en';
    const text = options.raw ? String(keyOrText || '') : (getText(keyOrText, lang) || String(keyOrText || ''));
    trackMapStatus.textContent = text;
    trackMapStatus.hidden = !text;
    if (text) trackMapStatus.dataset.tone = tone;
    else delete trackMapStatus.dataset.tone;
  }

  function getActiveMapController() {
    if (trackMapOverlay && !trackMapOverlay.hidden && mapControllers.expanded.container) {
      return mapControllers.expanded;
    }
    return mapControllers.inline;
  }

  function buildMapIcon(L) {
    return L.divIcon({
      className: 'track-map-marker',
      html: '<span class="track-map-marker-pin" aria-hidden="true"></span>',
      iconSize: [22, 30],
      iconAnchor: [11, 30],
    });
  }

  function syncMapMarker(controller) {
    if (!controller || !controller.map || !controller.marker) return;
    if (!state.mapPin) {
      if (controller.map.hasLayer(controller.marker)) controller.marker.remove();
      return;
    }
    controller.marker.setLatLng([state.mapPin.lat, state.mapPin.lng]);
    if (!controller.map.hasLayer(controller.marker)) controller.marker.addTo(controller.map);
  }

  function invalidateMap(controller) {
    if (!controller?.map) return;
    window.requestAnimationFrame(() => controller.map.invalidateSize(false));
  }

  function focusMapOnPin(controller, zoom) {
    if (!controller?.map || !state.mapPin) return;
    controller.map.setView(
      [state.mapPin.lat, state.mapPin.lng],
      Math.max(3, Math.min(mapRuntime.maxZoom, Math.round(asFiniteNumber(zoom, controller.map.getZoom())))),
      { animate: isMotionOn() }
    );
  }

  function ensureTrackingMap(key) {
    const controller = mapControllers[key];
    const container = controller?.container;
    const L = getLeaflet();
    if (!controller || !container || !L) return controller;
    if (controller.map) return controller;

    const map = L.map(container, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: true,
      keyboard: true,
      minZoom: 3,
      maxZoom: mapRuntime.maxZoom,
      worldCopyJump: false,
    });

    L.tileLayer(mapRuntime.tileUrl, {
      attribution: mapRuntime.tileAttribution,
      maxZoom: mapRuntime.maxZoom,
    }).addTo(map);

    map.attributionControl.setPrefix(false);
    map.setView([mapRuntime.defaultLat, mapRuntime.defaultLng], mapRuntime.defaultZoom);
    map.on('click', (event) => {
      if (state.trackingRequestInFlight.location_change) return;
      setMapPin(event.latlng.lat, event.latlng.lng, { centerActiveMap: false });
      setMapStatus('track_location_map_pending_confirm', 'info');
    });

    controller.map = map;
    controller.marker = L.marker([mapRuntime.defaultLat, mapRuntime.defaultLng], {
      icon: buildMapIcon(L),
      keyboard: false,
    });

    syncMapMarker(controller);
    invalidateMap(controller);
    return controller;
  }

  function syncMapPinUi() {
    const pin = state.mapPin;
    [trackMapPicker, trackMapDialogPicker].forEach((pickerEl) => {
      if (!pickerEl) return;
      pickerEl.classList.toggle('is-empty', !pin);
      pickerEl.classList.toggle('has-pin', Boolean(pin));
      pickerEl.classList.toggle('is-confirmed', Boolean(pin && state.mapPinConfirmed));
    });
    trackMapClearEls.forEach((btn) => {
      btn.disabled = !pin;
    });
    trackMapConfirmEls.forEach((btn) => {
      btn.hidden = !pin;
      btn.disabled = !pin;
      btn.classList.toggle('is-confirmed', Boolean(pin && state.mapPinConfirmed));
      btn.setAttribute('aria-pressed', pin && state.mapPinConfirmed ? 'true' : 'false');
      const lang = root.lang || 'en';
      btn.textContent = getText(
        pin && state.mapPinConfirmed ? 'track_location_map_confirmed_cta' : 'track_location_map_confirm',
        lang
      ) || '';
    });
    trackMapLocateEls.forEach((btn) => {
      btn.disabled = state.mapLocateInFlight;
      btn.setAttribute('aria-busy', state.mapLocateInFlight ? 'true' : 'false');
    });
    if (trackMapValue) {
      const lang = root.lang || 'en';
      if (!pin) {
        trackMapValue.textContent = getText('track_location_map_empty', lang) || '';
      } else {
        const template = getText('track_location_map_value', lang) || 'Pin: {lat}, {lng}';
        trackMapValue.textContent = template
          .replace('{lat}', formatMapCoord(pin.lat))
          .replace('{lng}', formatMapCoord(pin.lng));
      }
    }
    Object.values(mapControllers).forEach((controller) => {
      const shouldInit = controller.key === 'expanded'
        ? Boolean(trackMapOverlay && !trackMapOverlay.hidden)
        : Boolean(resultsStage && !resultsStage.hidden);
      if (!controller.map && !shouldInit) return;
      if (shouldInit) ensureTrackingMap(controller.key);
      syncMapMarker(controller);
    });
  }

  function resetMapPin(options = {}) {
    state.mapLocateSeq += 1;
    state.mapLocateInFlight = false;
    state.mapPin = null;
    state.mapPinConfirmed = false;
    syncMapPinUi();
    if (!options.preserveStatus) setMapStatus('');
  }

  function setMapPin(lat, lng, options = {}) {
    state.mapPin = {
      lat: Number(normalizeLat(lat).toFixed(6)),
      lng: Number(normalizeLng(lng).toFixed(6)),
    };
    state.mapPinConfirmed = false;
    syncMapPinUi();

    const activeController = getActiveMapController();
    ensureTrackingMap(activeController.key);
    const fallbackZoom = activeController?.map?.getZoom() || mapRuntime.defaultZoom;
    const zoomTarget = Math.max(
      3,
      Math.min(mapRuntime.maxZoom, Math.round(asFiniteNumber(options.zoom, fallbackZoom)))
    );

    if (options.centerAll) {
      Object.values(mapControllers).forEach((controller) => {
        ensureTrackingMap(controller.key);
        focusMapOnPin(controller, zoomTarget);
      });
      return;
    }

    if (options.centerActiveMap !== false) {
      const controller = getActiveMapController();
      ensureTrackingMap(controller.key);
      focusMapOnPin(controller, zoomTarget);
    }
  }

  function setMapPinAtCenter(controller = getActiveMapController()) {
    const resolved = ensureTrackingMap(controller.key);
    const center = resolved?.map
      ? resolved.map.getCenter()
      : { lat: mapRuntime.defaultLat, lng: mapRuntime.defaultLng };
    setMapPin(center.lat, center.lng, { centerActiveMap: false });
    setMapStatus('track_location_map_pending_confirm', 'info');
  }

  function bindMapPicker(pickerEl) {
    if (!pickerEl || pickerEl.dataset.bound === '1') return;
    pickerEl.dataset.bound = '1';
    pickerEl.addEventListener('click', (e) => {
      const key = pickerEl === trackMapDialogPicker ? 'expanded' : 'inline';
      const controller = mapControllers[key];
      if (controller?.map) return;
      if (state.trackingRequestInFlight.location_change) return;
      const rect = pickerEl.getBoundingClientRect();
      const xRatio = rect.width > 0 ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0.5;
      const yRatio = rect.height > 0 ? Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) : 0.5;
      const lat = normalizeLat(mapRuntime.defaultLat + (0.5 - yRatio) * 0.08);
      const lng = normalizeLng(mapRuntime.defaultLng + (xRatio - 0.5) * 0.08);
      setMapPin(lat, lng, { centerAll: true, centerActiveMap: false });
      setMapStatus('track_location_map_pending_confirm', 'info');
    });
    pickerEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (state.trackingRequestInFlight.location_change) return;
        const key = pickerEl === trackMapDialogPicker ? 'expanded' : 'inline';
        setMapPinAtCenter(mapControllers[key]);
      }
    });
  }

  function locateUserOnMap() {
    if (state.mapLocateInFlight) return;
    if (!window.isSecureContext || !navigator.geolocation) {
      setMapStatus('track_location_map_locate_unavailable', 'error');
      return;
    }

    state.mapLocateInFlight = true;
    state.mapLocateSeq += 1;
    const requestId = state.mapLocateSeq;
    syncMapPinUi();
    setMapStatus('track_location_map_locating', 'info');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (requestId !== state.mapLocateSeq) return;
        state.mapLocateInFlight = false;
        const lat = position?.coords?.latitude;
        const lng = position?.coords?.longitude;
        setMapPin(lat, lng, {
          centerAll: false,
          zoom: mapRuntime.locateZoom,
        });
        syncMapPinUi();
        setMapStatus('track_location_map_located', 'info');
      },
      (error) => {
        if (requestId !== state.mapLocateSeq) return;
        state.mapLocateInFlight = false;
        syncMapPinUi();
        if (error && Number(error.code) === 1) {
          setMapStatus('track_location_map_locate_denied', 'error');
          return;
        }
        setMapStatus('track_location_map_locate_error', 'error');
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 60000,
      }
    );
  }

  function openMapOverlay(triggerEl) {
    if (!trackMapOverlay) return;
    state.mapOverlayTrigger = triggerEl instanceof HTMLElement ? triggerEl : null;
    trackMapOverlay.hidden = false;
    document.body.classList.add('track-map-overlay-open');
    const controller = ensureTrackingMap('expanded');
    syncMapPinUi();
    window.requestAnimationFrame(() => {
      invalidateMap(controller);
      if (state.mapPin) focusMapOnPin(controller, controller?.map?.getZoom() || mapRuntime.defaultZoom);
      if (trackMapDialogPicker) trackMapDialogPicker.focus();
    });
  }

  const DIALOG_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Modal dialog keyboard contract: Escape closes from any control, Tab and Shift+Tab wrap inside.
  function handleMapOverlayKeydown(e) {
    if (trackMapOverlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMapOverlay();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = [...trackMapOverlay.querySelectorAll(DIALOG_FOCUSABLE)]
      .filter((el) => el.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function closeMapOverlay() {
    if (!trackMapOverlay || trackMapOverlay.hidden) return;
    trackMapOverlay.hidden = true;
    document.body.classList.remove('track-map-overlay-open');
    invalidateMap(mapControllers.inline);
    const returnEl = state.mapOverlayTrigger;
    state.mapOverlayTrigger = null;
    if (returnEl && typeof returnEl.focus === 'function') {
      window.requestAnimationFrame(() => returnEl.focus());
    }
  }

  function refreshTrackingUiForLang() {
    if (!trackingPage) return;
    applyTrackLinks();
    applyHomeLinks();
    const lang = root.lang || 'en';
    if (trackMapPicker) {
      trackMapPicker.setAttribute('aria-label', getText('track_location_map_aria', lang) || 'Shipment location map');
    }
    if (trackMapDialogPicker) {
      trackMapDialogPicker.setAttribute('aria-label', getText('track_location_map_aria_expanded', lang) || 'Expanded shipment location map');
    }
    if (state.trackingPayload) renderTrackingPayload(state.trackingPayload);
    syncMapPinUi();
  }

  function focusMapConfirmButton() {
    const candidate = trackMapConfirmEls.find((btn) => !btn.hidden && !btn.disabled);
    if (candidate && typeof candidate.focus === 'function') candidate.focus();
  }

  function confirmMapPin() {
    if (!state.mapPin) {
      setMapStatus('track_location_map_empty', 'error');
      return;
    }
    state.mapPinConfirmed = true;
    syncMapPinUi();
    setMapStatus('track_location_map_confirmed', 'success');
    if (trackMapOverlay && !trackMapOverlay.hidden) closeMapOverlay();
  }

  async function hydrateTrackingSession() {
    if (!trackingPage) return;
    const token = loadTrackingSession();
    if (!token) return;
    const request = beginTrackingRequest('session');

    try {
      const { response, data } = await postTracking('session', {
        session_token: token,
      }, request.controller);
      if (!isCurrentTrackingRequest(request)) return;
      if (!response.ok || !data || data.ok === false) {
        saveTrackingSession('');
        setTrackingStage('lookup');
        setTrackingStatus(trackLookupStatus, 'track_status_invalid_session', 'error');
        focusTrackingReferenceInput();
        return;
      }

      saveTrackingSession(token);
      renderTrackingPayload(data);
      setTrackingStage('results');
    } catch {
      if (!isCurrentTrackingRequest(request)) return;
      saveTrackingSession('');
    } finally {
      finishTrackingRequest(request);
    }
  }

  async function submitTrackingLookup() {
    if (!trackLookupForm) return;
    if (state.trackingLookupInFlight) return;
    if (typeof trackLookupForm.checkValidity === 'function' && !trackLookupForm.checkValidity()) {
      if (typeof trackLookupForm.reportValidity === 'function') trackLookupForm.reportValidity();
      return;
    }
    const turnstileToken = getTurnstileToken();
    if (hasTurnstile() && !turnstileToken) {
      setTrackingStatus(trackLookupStatus, 'track_status_turnstile_required', 'error');
      return;
    }

    const fd = new FormData(trackLookupForm);
    state.trackingReference = String(fd.get('reference') || '').trim();
    const wasSubmitDisabled = Boolean(trackLookupSubmitBtn?.disabled);
    const request = beginTrackingRequest('lookup', {
      supersedeKeys: ['session', 'lookup', 'verify'],
      release: () => {
        state.trackingLookupInFlight = false;
        if (trackLookupSubmitBtn) trackLookupSubmitBtn.disabled = wasSubmitDisabled;
      },
      statusEl: trackLookupStatus,
      turnstileKey: 'tracking',
      turnstileToken,
    });
    state.trackingLookupInFlight = true;
    if (trackLookupSubmitBtn) trackLookupSubmitBtn.disabled = true;
    claimTrackingRequestLoadingStatus(request);

    try {
      const { response, data } = await postTracking('lookup', {
        reference: state.trackingReference,
        turnstile_token: turnstileToken,
      }, request.controller);
      if (!isCurrentTrackingRequest(request)) return;
      if (!response.ok || !data || data.ok === false) {
        setOwnedTrackingRequestStatus(request, resolveTrackingErrorKey(data?.error?.code), 'error');
        return;
      }
      setTrackingStage('verify');
      setOwnedTrackingRequestStatus(request, '');
      setTrackingStatus(trackVerifyStatus, '');
      const input = trackVerifyForm && trackVerifyForm.querySelector('input[name="phone_last3"]');
      if (input) input.focus();
    } catch (error) {
      if (!isCurrentTrackingRequest(request)) return;
      setOwnedTrackingRequestStatus(
        request,
        error instanceof Error && error.message === 'missing_tracking_endpoint'
          ? 'track_status_missing_endpoint'
          : 'track_status_error',
        'error'
      );
    } finally {
      finishTrackingRequest(request);
    }
  }

  async function submitTrackingVerify() {
    if (!trackVerifyForm) return;
    if (state.trackingVerifyInFlight) return;
    if (typeof trackVerifyForm.checkValidity === 'function' && !trackVerifyForm.checkValidity()) {
      if (typeof trackVerifyForm.reportValidity === 'function') trackVerifyForm.reportValidity();
      return;
    }
    const turnstileToken = getTurnstileToken();
    if (hasTurnstile() && !turnstileToken) {
      setTrackingStatus(trackVerifyStatus, 'track_status_turnstile_required', 'error');
      return;
    }

    const fd = new FormData(trackVerifyForm);
    const wasSubmitDisabled = Boolean(trackVerifySubmitBtn?.disabled);
    const request = beginTrackingRequest('verify', {
      release: () => {
        state.trackingVerifyInFlight = false;
        if (trackVerifySubmitBtn) trackVerifySubmitBtn.disabled = wasSubmitDisabled;
      },
      statusEl: trackVerifyStatus,
      turnstileKey: 'tracking',
      turnstileToken,
    });
    state.trackingVerifyInFlight = true;
    if (trackVerifySubmitBtn) trackVerifySubmitBtn.disabled = true;
    claimTrackingRequestLoadingStatus(request);

    try {
      const { response, data } = await postTracking('verify', {
        reference: state.trackingReference,
        phone_last3: String(fd.get('phone_last3') || '').trim(),
        turnstile_token: turnstileToken,
      }, request.controller);
      if (!isCurrentTrackingRequest(request)) return;
      if (!response.ok || !data || data.ok === false) {
        setOwnedTrackingRequestStatus(request, resolveTrackingErrorKey(data?.error?.code), 'error');
        return;
      }

      saveTrackingSession(String(data.session_token || '').trim());
      clearTrackingRequestBanner();
      renderTrackingPayload(data);
      setTrackingStage('results');
      setOwnedTrackingRequestStatus(request, '');
    } catch (error) {
      if (!isCurrentTrackingRequest(request)) return;
      setOwnedTrackingRequestStatus(
        request,
        error instanceof Error && error.message === 'missing_tracking_endpoint'
          ? 'track_status_missing_endpoint'
          : 'track_status_error',
        'error'
      );
    } finally {
      finishTrackingRequest(request);
    }
  }

  async function submitTrackingRequest(kind) {
    const form = kind === 'reschedule_date' ? trackRescheduleForm : trackLocationForm;
    const statusEl = kind === 'reschedule_date' ? trackRescheduleStatus : trackLocationStatus;
    if (!form) return;
    if (hasTrackingMutationInFlight()) return;
    if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
      if (typeof form.reportValidity === 'function') form.reportValidity();
      return;
    }
    if (!state.trackingSessionToken) {
      setTrackingStatus(statusEl, 'track_status_invalid_session', 'error');
      return;
    }
    if (kind === 'location_change' && !state.mapPin) {
      setTrackingStatus(statusEl, 'track_status_invalid_request', 'error');
      setMapStatus('track_location_map_empty', 'error');
      return;
    }
    if (kind === 'location_change' && !state.mapPinConfirmed) {
      setTrackingStatus(statusEl, 'track_status_invalid_request', 'error');
      setMapStatus('track_location_map_pending_confirm', 'error');
      focusMapConfirmButton();
      return;
    }
    const turnstileToken = hasTurnstile() ? getTurnstileToken() : '';

    const fd = new FormData(form);
    const draft = captureTrackingRequestDraft(kind);
    const payload = kind === 'reschedule_date'
      ? {
          requested_date: String(fd.get('requested_date') || '').trim(),
          notes: String(fd.get('notes') || '').trim(),
        }
      : {
          address_text: String(fd.get('address_text') || '').trim(),
          short_national_address: String(fd.get('short_national_address') || '').trim(),
          landmark: String(fd.get('landmark') || '').trim(),
          drop_point: String(fd.get('drop_point') || '').trim(),
          notes: String(fd.get('notes') || '').trim(),
          map_pin: state.mapPin
            ? { lat: state.mapPin.lat, lng: state.mapPin.lng }
            : null,
        };

    clearTrackingRequestBanner();
    const mutationButtons = [
      {
        kind: 'reschedule_date',
        button: trackRescheduleSubmitBtn,
        wasDisabled: Boolean(trackRescheduleSubmitBtn?.disabled),
      },
      {
        kind: 'location_change',
        button: trackLocationSubmitBtn,
        wasDisabled: Boolean(trackLocationSubmitBtn?.disabled),
      },
    ];
    const wasLangToggleDisabled = Boolean(langToggle?.disabled);
    const releaseMutableControlLock = lockMutableControls([
      trackRescheduleForm,
      trackLocationForm,
    ]);
    const request = beginTrackingRequest(kind, {
      release: () => {
        state.trackingRequestInFlight[kind] = false;
        mutationButtons.forEach(({ kind: buttonKind, button, wasDisabled }) => {
          restoreTrackingRequestSubmitButton(buttonKind, button, wasDisabled);
        });
        releaseMutableControlLock();
        reapplyTrackingMutationPolicy();
        if (langToggle) langToggle.disabled = wasLangToggleDisabled;
      },
      statusEl,
      turnstileKey: 'tracking',
      turnstileToken,
    });
    state.trackingRequestInFlight[kind] = true;
    mutationButtons.forEach(({ button }) => {
      if (button) button.disabled = true;
    });
    if (langToggle) langToggle.disabled = true;
    claimTrackingRequestLoadingStatus(request);
    try {
      const { response, data } = await postTracking('request', {
        session_token: state.trackingSessionToken,
        request_type: kind,
        payload,
        ...(turnstileToken ? { turnstile_token: turnstileToken } : {}),
      }, request.controller);
      if (!isCurrentTrackingRequest(request)) return;
      if (!response.ok || !data || data.ok === false) {
        if (data?.error?.code === 'invalid_session') {
          saveTrackingSession('');
          resetTrackingFlow({ clearReference: false });
          setTrackingStatus(trackLookupStatus, 'track_status_invalid_session', 'error');
          return;
        }
        setOwnedTrackingRequestStatus(request, resolveTrackingErrorKey(data?.error?.code), 'error');
        return;
      }
      const outcome = typeof data.outcome === 'string' ? data.outcome.trim().toLowerCase() : 'pending_review';
      if (data.tracking) renderTrackingPayload(data);
      if (outcome === 'rejected') restoreTrackingRequestDraft(kind, draft);
      setTrackingRequestBanner(outcome, data);
      setOwnedTrackingRequestStatus(
        request,
        resolveTrackingRequestStatusKey(outcome),
        outcome === 'rejected' ? 'error' : 'success'
      );
      if (outcome !== 'rejected') {
        form.reset();
        if (kind === 'location_change') {
          resetMapPin();
          closeMapOverlay();
        }
      }
    } catch (error) {
      if (!isCurrentTrackingRequest(request)) return;
      setOwnedTrackingRequestStatus(
        request,
        error instanceof Error && error.message === 'missing_tracking_endpoint'
          ? 'track_status_missing_endpoint'
          : 'track_status_error',
        'error'
      );
    } finally {
      finishTrackingRequest(request);
    }
  }

  // --- Language ---

  function setLang(lang) {
    const next = knownLangs.has(lang) ? lang : 'en';
    root.lang = next;
    root.dir = next === 'ar' ? 'rtl' : 'ltr';
    writeStorageValue('localStorage', 'masarx_lang', next);

    if (langToggle) {
      langToggle.textContent = next === 'ar' ? 'EN' : 'AR';
      langToggle.setAttribute('aria-pressed', String(next === 'ar'));
    }

    if (themeToggle) {
      const labelKey = isDarkTheme() ? 'theme_light' : 'theme_dark';
      themeToggle.textContent = getText(labelKey, next);
      themeToggle.setAttribute('aria-pressed', String(isDarkTheme()));
    }

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.dataset.i18n;
      const value = getText(key, next);
      if (el.dataset.i18nHtml === 'true') el.innerHTML = value;
      else el.textContent = value;
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.dataset.i18nPlaceholder;
      const value = getText(key, next);
      el.setAttribute('placeholder', value);
    });

    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.dataset.i18nAria;
      const value = getText(key, next);
      if (value) el.setAttribute('aria-label', value);
    });

    applyTrackLinks();
    applyHomeLinks();
    refreshClientsUiForLang();
    refreshTrackingUiForLang();
    refreshTrackingRequestsLinks();
    setDriverReviewNote(state.driverReviewNote);

    if (isMotionOn()) applyWordReveal();
  }

  // --- Tilt micro-interaction ---

  function setupTilt(el, { maxDeg = 5 } = {}) {
    if (!el || !('requestAnimationFrame' in window)) return;
    let raf = 0;

    const reset = () => {
      if (raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
      el.style.removeProperty('--rx');
      el.style.removeProperty('--ry');
    };

    el.addEventListener('pointermove', (e) => {
      if (!isMotionOn()) return;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const rect = el.getBoundingClientRect();
        const px = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const py = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        const x = px - 0.5;
        const y = py - 0.5;
        const rx = (-y * maxDeg).toFixed(2);
        const ry = (x * maxDeg).toFixed(2);
        el.style.setProperty('--rx', `${rx}deg`);
        el.style.setProperty('--ry', `${ry}deg`);
        // C4: edge glow position
        el.style.setProperty('--edge-x', `${(px * 100).toFixed(1)}%`);
        el.style.setProperty('--edge-y', `${(py * 100).toFixed(1)}%`);
      });
    });

    el.addEventListener('pointerleave', reset);
    el.addEventListener('blur', reset);
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      reset();
    });
  }

  // Apply data-w attributes as CSS custom properties (avoids inline styles for CSP).
  document.querySelectorAll('.bar[data-w]').forEach((el) => {
    el.style.setProperty('--w', el.dataset.w);
  });

  // --- Mobile hamburger menu ---

  if (navToggle && navEl) {
    const closeNav = () => {
      navEl.classList.remove('is-open');
      navToggle.setAttribute('aria-expanded', 'false');
    };

    navToggle.addEventListener('click', () => {
      const open = navEl.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', String(open));
    });

    navLinks.forEach((link) => {
      link.addEventListener('click', closeNav);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && navEl.classList.contains('is-open')) closeNav();
    });

    document.addEventListener('pointerdown', (e) => {
      if (!navEl.classList.contains('is-open')) return;
      if (navEl.contains(e.target) || navToggle.contains(e.target)) return;
      closeNav();
    });
  }

  // --- Wire UI events ---

  if (langToggle) {
    langToggle.addEventListener('click', () => {
      if (hasTrackingMutationInFlight()) return;
      const next = root.lang === 'ar' ? 'en' : 'ar';
      navigateTo(buildLangHref(next));
    });
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => setTheme(isDarkTheme() ? 'light' : 'dark'));
  }

  // --- Initial state ---

  const initialMotion =
    (query.get('motion') && knownMotions.has(query.get('motion')) && query.get('motion'))
    || readStorageValue('localStorage', 'masarx_motion')
    || root.dataset.motion
    || (prefersReducedMotion ? 'off' : 'on');

  function readInitialTheme() {
    const fromQuery = query.get('theme');
    if (knownThemes.has(fromQuery)) return fromQuery;
    const stored = readStorageValue('localStorage', THEME_STORAGE_KEY);
    if (knownThemes.has(stored)) return stored;
    // Move a choice saved under the old landing key once, then drop that key.
    const legacy = readStorageValue('localStorage', LEGACY_THEME_STORAGE_KEY);
    if (legacy) writeStorageValue('localStorage', LEGACY_THEME_STORAGE_KEY, '');
    return knownThemes.has(legacy) ? legacy : 'system';
  }

  const initialTheme = readInitialTheme();

  const initialLang =
    pathLang
    || root.lang
    || 'en';

  setTheme(initialTheme);
  if (colorSchemeQuery) {
    const onColorSchemeChange = () => {
      if (themeMode === 'system') applyTheme(resolveSystemTheme());
    };
    if (colorSchemeQuery.addEventListener) colorSchemeQuery.addEventListener('change', onColorSchemeChange);
    else if (colorSchemeQuery.addListener) colorSchemeQuery.addListener(onColorSchemeChange);
  }
  setMotion(initialMotion);
  setLang(initialLang);

  applyRuntimeLinks();

  // Hide dead runtime links (fallback when optional URLs are unset).
  runtimeHrefEls.forEach((el) => {
    if (el.getAttribute('href') !== '#') return;
    const key = el.dataset.runtimeHref;
    if (key === 'docsUrl' || key === 'appUrl') el.style.display = 'none';
  });

  installClientLogoFallbacks(document);
  loadClients();
  ensureTurnstile();

  if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitContactRequest();
    });

    tenantSignupBtn?.addEventListener('click', () => submitContactRequest('tenant'));
    contactForm.addEventListener('input', () => {
      setIntakeStatus('contact', '');
      setIntakeStatus('tenant', '');
    });
  }

  if (driverForm) {
    driverForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitDriverRequest();
    });

    driverForm.addEventListener('input', () => setIntakeStatus('driver', ''));
  }

  if (driverStatusForm) {
    driverStatusForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitDriverStatusLookup();
    });
    const clearDriverStatusResult = () => {
      state.driverStatusLookupGeneration += 1;
      clearDriverDocuments();
      setDriverStatusLookup('');
      setDriverReviewNote('');
    };
    driverStatusForm.addEventListener('input', clearDriverStatusResult);
    driverStatusForm.addEventListener('reset', clearDriverStatusResult);
  }

  if (driverDocumentsForm) {
    driverDocumentsForm.addEventListener('submit', (event) => { event.preventDefault(); submitDriverDocuments(); });
    driverDocumentsForm.querySelector('[data-driver-documents-abandon]')?.addEventListener('click', () => submitDriverDocuments('abandon'));
  }

  hydrateDriverStatusToken();
  if (trackingPage) {
    setTrackingStage('lookup');
    resetMapPin();

    if (trackLookupForm) {
      trackLookupForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitTrackingLookup();
      });
      trackLookupForm.addEventListener('input', () => {
        invalidateTrackingRequests(['session', 'lookup', 'verify']);
        state.trackingReference = '';
        saveTrackingSession('');
        setTrackingStatus(trackLookupStatus, '');
      });
    }

    if (trackVerifyForm) {
      trackVerifyForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitTrackingVerify();
      });
      trackVerifyForm.addEventListener('input', () => {
        invalidateTrackingRequests('verify');
        setTrackingStatus(trackVerifyStatus, '');
      });
    }

    if (trackBackBtn) {
      trackBackBtn.addEventListener('click', () => {
        invalidateTrackingRequests(['session', 'lookup', 'verify']);
        setTrackingStage('lookup');
        setTrackingStatus(trackVerifyStatus, '');
        resetTurnstile();
        focusTrackingReferenceInput();
      });
    }

    trackResetEls.forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        resetTrackingFlow({ clearReference: true, scroll: true });
      });
    });
    trackRequestsLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        if (state.trackingStage !== 'results' && !resetTrackingFlow({ clearReference: false })) {
          event.preventDefault();
        }
      });
    });

    if (trackRescheduleForm) {
      trackRescheduleForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitTrackingRequest('reschedule_date');
      });
      trackRescheduleForm.addEventListener('input', () => {
        if (!state.trackingRequestInFlight.reschedule_date) setTrackingStatus(trackRescheduleStatus, '');
      });
    }

    if (trackLocationForm) {
      trackLocationForm.addEventListener('submit', (e) => {
        e.preventDefault();
        submitTrackingRequest('location_change');
      });
      trackLocationForm.addEventListener('input', () => {
        if (!state.trackingRequestInFlight.location_change) setTrackingStatus(trackLocationStatus, '');
      });
    }

    bindMapPicker(trackMapPicker);
    bindMapPicker(trackMapDialogPicker);

    trackMapExpandEls.forEach((btn) => {
      btn.addEventListener('click', () => openMapOverlay(btn));
    });
    trackMapConfirmEls.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.trackingRequestInFlight.location_change) return;
        confirmMapPin();
      });
    });
    trackMapCenterEls.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.trackingRequestInFlight.location_change) return;
        setMapPinAtCenter();
      });
    });
    trackMapLocateEls.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.trackingRequestInFlight.location_change) return;
        locateUserOnMap();
      });
    });
    trackMapClearEls.forEach((btn) => {
      btn.addEventListener('click', () => {
        if (state.trackingRequestInFlight.location_change) return;
        resetMapPin();
        if (trackMapOverlay && !trackMapOverlay.hidden && trackMapDialogPicker) {
          trackMapDialogPicker.focus();
        }
      });
    });
    trackMapCloseEls.forEach((btn) => {
      btn.addEventListener('click', closeMapOverlay);
    });
    if (trackMapOverlay) {
      trackMapOverlay.addEventListener('click', (e) => {
        if (e.target === trackMapOverlay) closeMapOverlay();
      });
      trackMapOverlay.addEventListener('keydown', handleMapOverlayKeydown);
    }

    window.addEventListener('pagehide', () => invalidateTrackingRequests());
    hydrateTrackingSession();
    syncMapPinUi();
  }
  // Tilt micro-interaction.
  tiltEls.forEach((el) => setupTilt(el, { maxDeg: 4 }));

  // --- Scroll progress ---

  if ('requestAnimationFrame' in window) {
    let rafScroll = 0;

    const updateScroll = () => {
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      const scrollY = window.scrollY || doc.scrollTop || 0;
      const next = Math.max(0, Math.min(1, scrollY / max));
      root.style.setProperty('--scroll', next.toFixed(4));

      // C2: parallax on hero
      if (heroSection && isMotionOn()) {
        const parallax = Math.min(scrollY, 600);
        heroSection.style.setProperty('--parallax', parallax.toFixed(1));
      }
    };

    const onScroll = () => {
      if (rafScroll) return;
      rafScroll = window.requestAnimationFrame(() => {
        rafScroll = 0;
        updateScroll();
      });
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    updateScroll();
  }

  // --- Scroll reveal ---

  if (isMotionOn() && 'IntersectionObserver' in window) {
    const revealEls = document.querySelectorAll('[data-reveal]');
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-inview');
        obs.unobserve(e.target);
      });
    }, { threshold: 0.14 });
    revealEls.forEach((el) => obs.observe(el));
  } else {
    document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-inview'));
  }

  // --- Smooth scroll with header offset ---

  const pageHeader = document.querySelector('.header');
  if (pageHeader) {
    const updateScrollOffset = () => {
      root.style.setProperty('--scroll-offset', `${pageHeader.offsetHeight + 16}px`);
    };
    updateScrollOffset();
    window.addEventListener('resize', updateScrollOffset, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(updateScrollOffset).observe(pageHeader);
  }
  // Use the measured header offset without deferring the form's initial focus.
  void applyDriverRoute();

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const link = e.target.closest('a[href^="#"]');
    if (!link) return;
    const id = link.getAttribute('href').slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    const header = document.querySelector('.header');
    const offset = (header ? header.offsetHeight : 0) + 16;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top, behavior: isMotionOn() ? 'smooth' : 'auto' });
    history.pushState(null, '', `#${id}`);
  });

  // --- Active section indicator in nav ---

  if ('IntersectionObserver' in window && navLinks.length) {
    const navSections = navLinks
      .map((a) => {
        const id = (a.getAttribute('href') || '').replace('#', '');
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean);

    if (navSections.length) {
      let lastActiveLink = null;

      const navObserver = new IntersectionObserver((entries) => {
        let anyIntersecting = false;
        entries.forEach((entry) => {
          const link = navLinks.find((a) => a.getAttribute('href') === `#${entry.target.id}`);
          if (!link) return;
          if (entry.isIntersecting) {
            anyIntersecting = true;
            navLinks.forEach((a) => a.removeAttribute('aria-current'));
            link.setAttribute('aria-current', 'true');
            lastActiveLink = link;
          }
        });

        if (!anyIntersecting && lastActiveLink) {
          const stillActive = navLinks.some((a) => a.getAttribute('aria-current') === 'true');
          if (!stillActive) {
            lastActiveLink.setAttribute('aria-current', 'true');
          }
        }
      }, { rootMargin: '-20% 0px -60% 0px', threshold: 0 });

      navSections.forEach((sec) => navObserver.observe(sec));
    }
  }

  // --- Word-by-word hero text reveal ---

  function splitIntoWords(el) {
    if (!el) return;
    const text = el.textContent || '';
    const words = text.split(/\s+/).filter(Boolean);
    el.textContent = '';
    words.forEach((word, i) => {
      if (i > 0) el.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = word;
      span.style.setProperty('--word-i', String(i));
      el.appendChild(span);
    });
  }

  function applyWordReveal() {
    const heroH1 = document.querySelector('.hero h1');
    const heroP = document.querySelector('.hero-copy > p');
    if (heroH1) splitIntoWords(heroH1);
    if (heroP) splitIntoWords(heroP);
  }

  if (isMotionOn()) applyWordReveal();

  // --- Animated number counters ---

  function countUp(el, target, durationMs) {
    if (!el) return;
    const dur = durationMs || 900;
    const start = performance.now();
    const prefix = el.dataset.countPrefix || '';
    const suffix = el.dataset.countSuffix || '';
    const step = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(eased * target);
      el.textContent = prefix + current + suffix;
      if (t < 1) requestAnimationFrame(step);
    };
    el.textContent = prefix + '0' + suffix;
    requestAnimationFrame(step);
  }

  function triggerCounters(container) {
    if (!container) return;
    const els = [...container.querySelectorAll('[data-count-to]')];
    els.forEach((el, i) => {
      if (el.dataset.counted === '1') return;
      el.dataset.counted = '1';
      const target = parseInt(el.dataset.countTo, 10) || 0;
      if (!isMotionOn()) {
        const prefix = el.dataset.countPrefix || '';
        const suffix = el.dataset.countSuffix || '';
        el.textContent = prefix + target + suffix;
        return;
      }
      setTimeout(() => countUp(el, target, 900), i * 100);
    });
  }

  // Trigger proof bar counters on scroll reveal.
  if ('IntersectionObserver' in window) {
    const proofBar = document.querySelector('.proof-bar');
    if (proofBar) {
      const proofObs = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          triggerCounters(proofBar);
          proofObs.unobserve(e.target);
        });
      }, { threshold: 0.3 });
      proofObs.observe(proofBar);
    }
  }

  // --- Lifecycle step stagger ---

  document.querySelectorAll('.lifecycle-step').forEach((el, i) => {
    el.style.setProperty('--lc-i', String(i));
  });

  // Immediately mark hero as in-view so lifecycle animation starts on page load
  if (heroSection) heroSection.classList.add('is-inview');

  // C7: Typewriter lifecycle replay
  if (isMotionOn() && heroSection) {
    let replayInterval = 0;
    let typewriterRunning = false;

    function typewriterMeta(el, text) {
      return new Promise((resolve) => {
        el.textContent = '';
        el.setAttribute('data-typing', '');
        let i = 0;
        const step = () => {
          if (i < text.length) {
            el.textContent += text[i];
            i++;
            setTimeout(step, 25 + Math.random() * 20);
          } else {
            el.removeAttribute('data-typing');
            resolve();
          }
        };
        step();
      });
    }

    async function replayLifecycleTypewriter() {
      if (typewriterRunning) return;
      typewriterRunning = true;
      const steps = heroSection.querySelectorAll('.lifecycle-step');
      if (!steps.length) { typewriterRunning = false; return; }

      // Re-trigger step-in animation
      steps.forEach((s) => {
        s.style.removeProperty('animation');
        void s.offsetHeight;
        s.style.setProperty('animation', '');
      });

      // Type each meta sequentially
      for (const step of steps) {
        const meta = step.querySelector('.lifecycle-meta');
        if (!meta) continue;
        const lang = root.lang || 'en';
        const key = meta.dataset.i18n;
        const fullText = key ? getText(key, lang) : (meta.textContent || '');
        if (fullText) {
          await typewriterMeta(meta, fullText);
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      typewriterRunning = false;
    }

    if ('IntersectionObserver' in window) {
      const heroReplayObs = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            replayInterval = window.setInterval(replayLifecycleTypewriter, 10000);
          } else {
            window.clearInterval(replayInterval);
          }
        });
      }, { threshold: 0.2 });
      heroReplayObs.observe(heroSection);
    }
  }

  // --- Compare card entrance ---

  if ('IntersectionObserver' in window) {
    const compareSection = document.querySelector('#integration');
    if (compareSection) {
      const compareCards = [...compareSection.querySelectorAll('.compare-card')];
      compareCards.forEach((card, i) => card.style.setProperty('--card-i', String(i)));

      if (!isMotionOn()) {
        compareCards.forEach((card) => card.classList.add('is-card-visible'));
      } else {
        const compareObs = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            compareCards.forEach((card) => card.classList.add('is-card-visible'));
            compareObs.unobserve(e.target);
          });
        }, { threshold: 0.12 });
        compareObs.observe(compareSection);
      }
    }
  }

  // --- 3-step card entrance ---

  if ('IntersectionObserver' in window) {
    const stepsContainer = document.querySelector('.steps-three');
    if (stepsContainer) {
      const stepCards = [...stepsContainer.querySelectorAll('.step-card')];
      stepCards.forEach((card, i) => card.style.setProperty('--step-i', String(i)));

      const stepConnectors = [...stepsContainer.querySelectorAll('.step-connector')];

      if (!isMotionOn()) {
        stepCards.forEach((s) => s.classList.add('is-step-visible'));
        stepConnectors.forEach((c) => c.classList.add('is-connector-drawn'));
      } else {
        const stepObs = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            stepCards.forEach((card) => card.classList.add('is-step-visible'));
            // C5: draw connector lines after step cards appear
            stepConnectors.forEach((conn, ci) => {
              setTimeout(() => conn.classList.add('is-connector-drawn'), (ci + 1) * 200 + 300);
            });
            stepObs.unobserve(e.target);
          });
        }, { threshold: 0.12 });
        stepObs.observe(stepsContainer);
      }
    }
  }

  // --- Capability card stagger entrance ---

  if ('IntersectionObserver' in window) {
    const capSection = document.querySelector('#capabilities');
    if (capSection) {
      const capCards = [...capSection.querySelectorAll('.cap-card')];
      capCards.forEach((card, i) => card.style.setProperty('--cap-i', String(i)));

      if (!isMotionOn()) {
        capCards.forEach((card) => card.classList.add('is-card-visible'));
      } else {
        const capObs = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (!e.isIntersecting) return;
            capCards.forEach((card) => card.classList.add('is-card-visible'));
            capObs.unobserve(e.target);
          });
        }, { threshold: 0.12 });
        capObs.observe(capSection);
      }
    }
  }

  // --- Grid card stagger entrance ---

  if (isMotionOn() && 'IntersectionObserver' in window) {
    const grids = document.querySelectorAll('.grid-2');
    grids.forEach((grid) => {
      const cards = [...grid.querySelectorAll('.card')];
      cards.forEach((card, i) => card.style.setProperty('--card-i', String(i)));
    });

    const cardObs = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const section = e.target;
        const cards = [...section.querySelectorAll('.grid-2 .card')];
        cards.forEach((card) => card.classList.add('is-card-visible'));
        cardObs.unobserve(section);
      });
    }, { threshold: 0.12 });

    document.querySelectorAll('.section.reveal').forEach((s) => {
      if (s.querySelectorAll('.grid-2 .card').length) {
        cardObs.observe(s);
      }
    });
  }

  // --- Floating CTA on scroll ---

  if ('IntersectionObserver' in window) {
    const floatCta = document.querySelector('[data-float-cta]');
    const contactSection = document.querySelector('#contact');
    if (floatCta && heroSection && contactSection) {
      let heroVisible = true;
      let contactVisible = false;

      const floatLink = floatCta.querySelector('a');
      const updateFloat = () => {
        const show = !heroVisible && !contactVisible;
        floatCta.classList.toggle('is-visible', show);
        floatCta.setAttribute('aria-hidden', String(!show));
        if (floatLink) floatLink.setAttribute('tabindex', show ? '0' : '-1');
      };

      const heroVisObs = new IntersectionObserver((entries) => {
        entries.forEach((e) => { heroVisible = e.isIntersecting; updateFloat(); });
      }, { threshold: 0 });

      const contactObs = new IntersectionObserver((entries) => {
        entries.forEach((e) => { contactVisible = e.isIntersecting; updateFloat(); });
      }, { threshold: 0 });

      heroVisObs.observe(heroSection);
      contactObs.observe(contactSection);
    }
  }

  // --- Form shake on invalid submit ---

  if (contactForm) {
    contactForm.addEventListener('invalid', () => {
      if (!isMotionOn()) return;
      contactForm.classList.add('form-shake');
    }, true);

    contactForm.addEventListener('animationend', (e) => {
      if (e.animationName === 'shake') contactForm.classList.remove('form-shake');
    });
  }

  // --- C1: Mouse-reactive aurora ---

  if (isMotionOn() && window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
    let auroraRaf = 0;
    document.body.addEventListener('pointermove', (e) => {
      if (auroraRaf) return;
      auroraRaf = requestAnimationFrame(() => {
        auroraRaf = 0;
        const x = ((e.clientX / window.innerWidth) - 0.5) * 30;
        const y = ((e.clientY / window.innerHeight) - 0.5) * 30;
        document.body.style.setProperty('--aurora-x', `${x.toFixed(1)}px`);
        document.body.style.setProperty('--aurora-y', `${y.toFixed(1)}px`);
      });
    });
  }

  // --- C3: Cursor-following glow on primary buttons ---

  if (isMotionOn() && window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
    document.querySelectorAll('.btn-primary').forEach((btn) => {
      let btnRaf = 0;
      btn.addEventListener('pointermove', (e) => {
        if (btnRaf) return;
        btnRaf = requestAnimationFrame(() => {
          btnRaf = 0;
          const rect = btn.getBoundingClientRect();
          const gx = e.clientX - rect.left;
          const gy = e.clientY - rect.top;
          btn.style.setProperty('--glow-x', `${gx.toFixed(0)}px`);
          btn.style.setProperty('--glow-y', `${gy.toFixed(0)}px`);
        });
      });
    });
  }

  // --- Lottie animations ---

  // Inline animation data (Bodymovin JSON format)
  const HERO_FLOW_DATA = {
    v: '5.7.4', fr: 30, ip: 0, op: 90, w: 400, h: 200,
    layers: [
      // Node 1
      { ty: 4, nm: 'n1', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 0, s: [60], e: [100] }, { t: 30, s: [100], e: [60] }, { t: 60, s: [60] }] }, p: { a: 0, k: [60, 100, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [24, 24] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 1] }, w: { a: 0, k: 2 } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 0.15] } }] },
      // Node 2
      { ty: 4, nm: 'n2', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 15, s: [60], e: [100] }, { t: 45, s: [100], e: [60] }, { t: 75, s: [60] }] }, p: { a: 0, k: [160, 70, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [24, 24] } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 1] }, w: { a: 0, k: 2 } }, { ty: 'fl', c: { a: 0, k: [0.06, 0.73, 0.51, 0.15] } }] },
      // Node 3
      { ty: 4, nm: 'n3', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 30, s: [60], e: [100] }, { t: 60, s: [100], e: [60] }, { t: 90, s: [60] }] }, p: { a: 0, k: [260, 130, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [24, 24] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 1] }, w: { a: 0, k: 2 } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 0.15] } }] },
      // Node 4
      { ty: 4, nm: 'n4', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 45, s: [60], e: [100] }, { t: 75, s: [100], e: [60] }, { t: 90, s: [60] }] }, p: { a: 0, k: [340, 80, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [24, 24] } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 1] }, w: { a: 0, k: 2 } }, { ty: 'fl', c: { a: 0, k: [0.06, 0.73, 0.51, 0.15] } }] },
      // Path 1→2
      { ty: 4, nm: 'p12', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 50 }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[60, 100], [160, 70]], i: [[0, 0], [0, 0]], o: [[40, -20], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.5] }, w: { a: 0, k: 1.5 }, d: [{ n: 'd', nm: 'dash', v: { a: 0, k: 4 } }, { n: 'g', nm: 'gap', v: { a: 0, k: 4 } }, { n: 'o', nm: 'offset', v: { a: 1, k: [{ t: 0, s: [0], e: [-40] }, { t: 90, s: [-40] }] } }] }, { ty: 'tm', s: { a: 1, k: [{ t: 0, s: [0], e: [0] }, { t: 20, s: [0] }] }, e: { a: 1, k: [{ t: 0, s: [0], e: [100] }, { t: 20, s: [100] }] } }] },
      // Path 2→3
      { ty: 4, nm: 'p23', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 50 }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[160, 70], [260, 130]], i: [[0, 0], [0, 0]], o: [[40, 20], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 0.5] }, w: { a: 0, k: 1.5 }, d: [{ n: 'd', nm: 'dash', v: { a: 0, k: 4 } }, { n: 'g', nm: 'gap', v: { a: 0, k: 4 } }, { n: 'o', nm: 'offset', v: { a: 1, k: [{ t: 0, s: [0], e: [-40] }, { t: 90, s: [-40] }] } }] }, { ty: 'tm', s: { a: 1, k: [{ t: 10, s: [0], e: [0] }, { t: 30, s: [0] }] }, e: { a: 1, k: [{ t: 10, s: [0], e: [100] }, { t: 30, s: [100] }] } }] },
      // Path 3→4
      { ty: 4, nm: 'p34', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 50 }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[260, 130], [340, 80]], i: [[0, 0], [0, 0]], o: [[30, -20], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.5] }, w: { a: 0, k: 1.5 }, d: [{ n: 'd', nm: 'dash', v: { a: 0, k: 4 } }, { n: 'g', nm: 'gap', v: { a: 0, k: 4 } }, { n: 'o', nm: 'offset', v: { a: 1, k: [{ t: 0, s: [0], e: [-40] }, { t: 90, s: [-40] }] } }] }, { ty: 'tm', s: { a: 1, k: [{ t: 20, s: [0], e: [0] }, { t: 40, s: [0] }] }, e: { a: 1, k: [{ t: 20, s: [0], e: [100] }, { t: 40, s: [100] }] } }] },
    ],
  };

  const STEP_CONNECT_DATA = {
    v: '5.7.4', fr: 30, ip: 0, op: 60, w: 200, h: 80,
    layers: [
      // Bracket sliding in
      { ty: 4, nm: 'bracket', ip: 0, op: 60, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 1, k: [{ t: 0, s: [-20, 40, 0], e: [30, 40, 0] }, { t: 15, s: [30, 40, 0] }] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[8, -12], [0, -12], [0, 12], [8, 12]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 1] }, w: { a: 0, k: 2.5 } }] },
      // Arrow path
      { ty: 4, nm: 'arrow', ip: 0, op: 60, st: 0, sr: 1, ks: { o: { a: 0, k: 80 }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[50, 40], [130, 40]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 1] }, w: { a: 0, k: 2 }, d: [{ n: 'd', nm: 'dash', v: { a: 0, k: 6 } }, { n: 'g', nm: 'gap', v: { a: 0, k: 4 } }, { n: 'o', nm: 'offset', v: { a: 1, k: [{ t: 0, s: [0], e: [-30] }, { t: 60, s: [-30] }] } }] }, { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 8, s: [0], e: [100] }, { t: 25, s: [100] }] } }] },
      // Endpoint circle
      { ty: 4, nm: 'endpoint', ip: 0, op: 60, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [155, 40, 0] }, s: { a: 1, k: [{ t: 25, s: [80, 80], e: [110, 110] }, { t: 35, s: [110, 110], e: [100, 100] }, { t: 42, s: [100, 100] }] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [20, 20] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 1] }, w: { a: 0, k: 2 } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 0.2] } }] },
    ],
  };

  const STEP_CONFIGURE_DATA = {
    v: '5.7.4', fr: 30, ip: 0, op: 90, w: 200, h: 80, _loop: false,
    layers: [
      // Source field 1
      { ty: 4, nm: 'sf1', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [30, 20, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 10] }, r: { a: 0, k: 3 } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 0.3] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.6] }, w: { a: 0, k: 1 } }] },
      // Source field 2
      { ty: 4, nm: 'sf2', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [30, 40, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 10] }, r: { a: 0, k: 3 } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 0.3] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.6] }, w: { a: 0, k: 1 } }] },
      // Source field 3
      { ty: 4, nm: 'sf3', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [30, 60, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 10] }, r: { a: 0, k: 3 } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 0.3] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.6] }, w: { a: 0, k: 1 } }] },
      // Target field 1
      { ty: 4, nm: 'tf1', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [170, 20, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 10] }, r: { a: 0, k: 3 } }, { ty: 'fl', c: { a: 0, k: [0.06, 0.73, 0.51, 0.3] } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 0.6] }, w: { a: 0, k: 1 } }] },
      // Target field 2
      { ty: 4, nm: 'tf2', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [170, 40, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 10] }, r: { a: 0, k: 3 } }, { ty: 'fl', c: { a: 0, k: [0.06, 0.73, 0.51, 0.3] } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 0.6] }, w: { a: 0, k: 1 } }] },
      // Target field 3
      { ty: 4, nm: 'tf3', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [170, 60, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'rc', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [40, 10] }, r: { a: 0, k: 3 } }, { ty: 'fl', c: { a: 0, k: [0.06, 0.73, 0.51, 0.3] } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 0.6] }, w: { a: 0, k: 1 } }] },
      // Mapping line 1
      { ty: 4, nm: 'ml1', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 20, s: [0], e: [80] }, { t: 35, s: [80] }] }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[50, 20], [150, 20]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.7] }, w: { a: 0, k: 1.5 } }, { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 20, s: [0], e: [100] }, { t: 40, s: [100] }] } }] },
      // Mapping line 2
      { ty: 4, nm: 'ml2', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 30, s: [0], e: [80] }, { t: 45, s: [80] }] }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[50, 40], [150, 40]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 0.7] }, w: { a: 0, k: 1.5 } }, { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 30, s: [0], e: [100] }, { t: 50, s: [100] }] } }] },
      // Mapping line 3
      { ty: 4, nm: 'ml3', ip: 0, op: 90, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 40, s: [0], e: [80] }, { t: 55, s: [80] }] }, p: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100] } }, shapes: [{ ty: 'sh', ks: { a: 0, k: { v: [[50, 60], [150, 60]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]], c: false } } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.7] }, w: { a: 0, k: 1.5 } }, { ty: 'tm', s: { a: 0, k: 0 }, e: { a: 1, k: [{ t: 40, s: [0], e: [100] }, { t: 60, s: [100] }] } }] },
    ],
  };

  const STEP_GOLIVE_DATA = {
    v: '5.7.4', fr: 30, ip: 0, op: 75, w: 200, h: 80,
    layers: [
      // Center dot
      { ty: 4, nm: 'center', ip: 0, op: 75, st: 0, sr: 1, ks: { o: { a: 0, k: 100 }, p: { a: 0, k: [100, 40, 0] }, s: { a: 1, k: [{ t: 0, s: [100, 100], e: [115, 115] }, { t: 15, s: [115, 115], e: [100, 100] }, { t: 30, s: [100, 100], e: [115, 115] }, { t: 45, s: [115, 115], e: [100, 100] }, { t: 60, s: [100, 100] }] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [12, 12] } }, { ty: 'fl', c: { a: 0, k: [0.31, 0.27, 0.90, 1] } }] },
      // Ring 1
      { ty: 4, nm: 'r1', ip: 0, op: 75, st: 0, sr: 1, ks: { o: { a: 1, k: [{ t: 0, s: [70], e: [0] }, { t: 25, s: [0] }] }, p: { a: 0, k: [100, 40, 0] }, s: { a: 1, k: [{ t: 0, s: [40, 40], e: [200, 200] }, { t: 25, s: [200, 200] }] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [30, 30] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.6] }, w: { a: 0, k: 1.5 } }] },
      // Ring 2
      { ty: 4, nm: 'r2', ip: 10, op: 75, st: 10, sr: 1, ks: { o: { a: 1, k: [{ t: 10, s: [70], e: [0] }, { t: 35, s: [0] }] }, p: { a: 0, k: [100, 40, 0] }, s: { a: 1, k: [{ t: 10, s: [40, 40], e: [200, 200] }, { t: 35, s: [200, 200] }] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [30, 30] } }, { ty: 'st', c: { a: 0, k: [0.06, 0.73, 0.51, 0.5] }, w: { a: 0, k: 1.5 } }] },
      // Ring 3
      { ty: 4, nm: 'r3', ip: 20, op: 75, st: 20, sr: 1, ks: { o: { a: 1, k: [{ t: 20, s: [70], e: [0] }, { t: 45, s: [0] }] }, p: { a: 0, k: [100, 40, 0] }, s: { a: 1, k: [{ t: 20, s: [40, 40], e: [200, 200] }, { t: 45, s: [200, 200] }] } }, shapes: [{ ty: 'el', p: { a: 0, k: [0, 0] }, s: { a: 0, k: [30, 30] } }, { ty: 'st', c: { a: 0, k: [0.31, 0.27, 0.90, 0.4] }, w: { a: 0, k: 1.5 } }] },
    ],
  };

  function initLottie() {
    if (typeof lottie === 'undefined') return;

    const animations = {
      'hero-flow': HERO_FLOW_DATA,
      'step-connect': STEP_CONNECT_DATA,
      'step-configure': STEP_CONFIGURE_DATA,
      'step-golive': STEP_GOLIVE_DATA,
    };

    document.querySelectorAll('[data-lottie]').forEach((container) => {
      const key = container.dataset.lottie;
      const data = animations[key];
      if (!data) return;

      const loopAnim = data._loop !== false;

      const anim = lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: loopAnim,
        autoplay: false,
        animationData: data,
      });

      // Lazy-play on scroll
      if ('IntersectionObserver' in window) {
        const obs = new IntersectionObserver((entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting && isMotionOn()) {
              anim.play();
            } else {
              anim.pause();
            }
          });
        }, { threshold: 0.2 });
        obs.observe(container);
      }

      // Respect motion-off
      if (!isMotionOn()) {
        anim.goToAndStop(anim.totalFrames - 1, true);
      }
    });
  }

  initLottie();
})();
