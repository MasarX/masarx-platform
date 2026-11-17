export type MobileTelemetryEvent = {
  event_type: string;
  captured_at: string;
  metadata: Record<string, unknown>;
};

const TELEMETRY_KEY = "fieldops_telemetry_events_v1";
const MAX_EVENTS = 50;
const MAX_STRING_CHARS = 4000;

type SecureStoreModule = {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
};

const inMemoryTelemetry = {
  events: [] as MobileTelemetryEvent[],
};

let secureStorePromise: Promise<SecureStoreModule | null> | null = null;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function truncateString(value: unknown, maxChars = MAX_STRING_CHARS): string | null {
  if (typeof value !== "string") return null;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function isTestRuntime(): boolean {
  const env = typeof process !== "undefined" ? (process as any).env : null;
  if (!env) return false;
  if (env.JEST_WORKER_ID) return true;
  return String(env.NODE_ENV || "").trim().toLowerCase() === "test";
}

function getWebStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    if (!window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

async function loadSecureStore(): Promise<SecureStoreModule | null> {
  if (secureStorePromise) return secureStorePromise;
  secureStorePromise = (async () => {
    try {
      const mod = (await import("expo-secure-store")) as unknown as Partial<SecureStoreModule>;
      if (
        typeof mod.getItemAsync !== "function" ||
        typeof mod.setItemAsync !== "function" ||
        typeof mod.deleteItemAsync !== "function"
      ) {
        return null;
      }
      return mod as SecureStoreModule;
    } catch {
      return null;
    }
  })();
  return secureStorePromise;
}

function normalizeEvent(value: unknown): MobileTelemetryEvent | null {
  const input = asRecord(value);
  const eventType = truncateString(input.event_type);
  const capturedAt = truncateString(input.captured_at) ?? new Date().toISOString();
  if (!eventType) return null;
  const metadata = asRecord(input.metadata);
  const safeMetadata: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(metadata)) {
    const safeKey = truncateString(key, 120);
    if (!safeKey) continue;
    if (typeof raw === "string") {
      safeMetadata[safeKey] = truncateString(raw);
      continue;
    }
    safeMetadata[safeKey] = raw;
  }
  return {
    event_type: eventType,
    captured_at: capturedAt,
    metadata: safeMetadata,
  };
}

function normalizeEvents(value: unknown): MobileTelemetryEvent[] {
  if (!Array.isArray(value)) return [];
  const out: MobileTelemetryEvent[] = [];
  for (const entry of value) {
    const normalized = normalizeEvent(entry);
    if (normalized) out.push(normalized);
  }
  return out;
}

async function readStoredEvents(): Promise<MobileTelemetryEvent[]> {
  try {
    const webStorage = getWebStorage();
    if (webStorage) {
      const raw = webStorage.getItem(TELEMETRY_KEY);
      if (!raw) return [];
      return normalizeEvents(JSON.parse(raw));
    }

    if (isTestRuntime()) {
      return inMemoryTelemetry.events.slice();
    }

    const secureStore = await loadSecureStore();
    if (!secureStore) return [];
    const raw = await secureStore.getItemAsync(TELEMETRY_KEY);
    if (!raw) return [];
    return normalizeEvents(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeStoredEvents(events: MobileTelemetryEvent[]) {
  const payload = JSON.stringify(events.slice(-MAX_EVENTS));
  const webStorage = getWebStorage();
  if (webStorage) {
    try {
      webStorage.setItem(TELEMETRY_KEY, payload);
    } catch {
      // Ignore.
    }
    return;
  }

  if (isTestRuntime()) {
    inMemoryTelemetry.events = normalizeEvents(events).slice(-MAX_EVENTS);
    return;
  }

  const secureStore = await loadSecureStore();
  if (!secureStore) return;
  try {
    await secureStore.setItemAsync(TELEMETRY_KEY, payload);
  } catch {
    // Ignore.
  }
}

async function clearStoredEvents() {
  const webStorage = getWebStorage();
  if (webStorage) {
    try {
      webStorage.removeItem(TELEMETRY_KEY);
    } catch {
      // Ignore.
    }
    return;
  }

  if (isTestRuntime()) {
    inMemoryTelemetry.events = [];
    return;
  }

  const secureStore = await loadSecureStore();
  if (!secureStore) return;
  try {
    await secureStore.deleteItemAsync(TELEMETRY_KEY);
  } catch {
    // Ignore.
  }
}

export async function clearMobileTelemetryEvents() {
  await clearStoredEvents();
}

export async function bufferMobileTelemetryEvent(event: MobileTelemetryEvent) {
  const normalized = normalizeEvent(event);
  if (!normalized) return;
  const existing = await readStoredEvents();
  existing.push(normalized);
  await writeStoredEvents(existing);
}

export async function flushMobileTelemetryEvents(params: {
  enqueue: (events: MobileTelemetryEvent[]) => Promise<void>;
}): Promise<number> {
  const existing = await readStoredEvents();
  if (existing.length === 0) return 0;
  await params.enqueue(existing);
  await clearStoredEvents();
  return existing.length;
}
