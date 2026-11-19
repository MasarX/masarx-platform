const E164_PHONE_RE = /^\+[1-9][0-9]{7,14}$/;

export function normalizePhoneForMatch(value: unknown): string {
  return String(value ?? '').replace(/[^\d+]/g, '');
}

export function isE164PhoneNumber(value: unknown): boolean {
  return E164_PHONE_RE.test(String(value ?? '').trim());
}

export function e164PhoneError(label = 'Phone'): string {
  return `${label} must be in E.164 format, for example +9665XXXXXXXX.`;
}
