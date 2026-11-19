export type ExternalIntakeTokenTarget = 'api-gateway' | 'webhook-tester';

export interface ExternalIntakeTokenHandoff {
  token: string;
  source_id?: string | null;
  source_name?: string | null;
  created_at: number;
}

const STORAGE_PREFIX = 'masarx.external-intake.source-token-handoff.v1';
const TOKEN_HANDOFF_TTL_MS = 10 * 60 * 1000;

function storageKey(target: ExternalIntakeTokenTarget): string {
  return `${STORAGE_PREFIX}.${target}`;
}

function browserSessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function parseExternalIntakeSourceTokenHandoff(
  raw: string,
  now: number,
): ExternalIntakeTokenHandoff | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ExternalIntakeTokenHandoff>;
    const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
    const createdAt = typeof parsed.created_at === 'number' ? parsed.created_at : 0;
    if (!token || !createdAt || now - createdAt > TOKEN_HANDOFF_TTL_MS) return null;
    return {
      token,
      source_id: typeof parsed.source_id === 'string' && parsed.source_id.trim() ? parsed.source_id.trim() : null,
      source_name: typeof parsed.source_name === 'string' && parsed.source_name.trim() ? parsed.source_name.trim() : null,
      created_at: createdAt,
    };
  } catch {
    return null;
  }
}

export function stashExternalIntakeSourceToken(
  target: ExternalIntakeTokenTarget,
  handoff: Omit<ExternalIntakeTokenHandoff, 'created_at'>,
): boolean {
  const storage = browserSessionStorage();
  if (!storage) return false;
  const key = storageKey(target);
  const token = handoff.token.trim();
  if (!token) {
    try {
      storage.removeItem(key);
    } catch {
      return false;
    }
    return false;
  }
  const payload: ExternalIntakeTokenHandoff = {
    token,
    source_id: handoff.source_id ?? null,
    source_name: handoff.source_name ?? null,
    created_at: Date.now(),
  };
  try {
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function consumeExternalIntakeSourceToken(
  target: ExternalIntakeTokenTarget,
  now = Date.now(),
): ExternalIntakeTokenHandoff | null {
  const storage = browserSessionStorage();
  if (!storage) return null;
  const key = storageKey(target);
  const raw = storage.getItem(key);
  if (!raw) return null;
  storage.removeItem(key);
  return parseExternalIntakeSourceTokenHandoff(raw, now);
}

export function peekExternalIntakeSourceToken(
  target: ExternalIntakeTokenTarget,
  now = Date.now(),
): ExternalIntakeTokenHandoff | null {
  const storage = browserSessionStorage();
  if (!storage) return null;
  const key = storageKey(target);
  const raw = storage.getItem(key);
  if (!raw) return null;
  const handoff = parseExternalIntakeSourceTokenHandoff(raw, now);
  if (!handoff) {
    storage.removeItem(key);
    return null;
  }
  return handoff;
}

export function clearExternalIntakeSourceToken(target: ExternalIntakeTokenTarget): void {
  const storage = browserSessionStorage();
  if (!storage) return;
  storage.removeItem(storageKey(target));
}
