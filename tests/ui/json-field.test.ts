import { parseJsonValue } from '../../packages/ui/src/json-field';
import { parseJsonValue as pickupParse } from '../../packages/ui/src/pickup-operations-utils';
import { parseJsonValue as marketplaceParse } from '../../packages/ui/src/marketplace-page-utils';

function withLocale(locale: string | undefined, run: () => void) {
  const original = process.env.NEXT_PUBLIC_LOCALE;
  if (locale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
  else process.env.NEXT_PUBLIC_LOCALE = locale;
  try {
    run();
  } finally {
    if (original === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = original;
  }
}

describe('shared JSON field parser', () => {
  it('is the single implementation behind the pickup and marketplace helpers', () => {
    expect(pickupParse).toBe(parseJsonValue);
    expect(marketplaceParse).toBe(parseJsonValue);
  });

  it('returns the fallback for blank input and the parsed value otherwise', () => {
    expect(parseJsonValue('  ', { source: 'form' })).toEqual({ ok: true, value: { source: 'form' } });
    expect(parseJsonValue(' {"a":1} ', {})).toEqual({ ok: true, value: { a: 1 } });
  });

  it('returns the catalog message in English and Arabic, never the engine parse error', () => {
    withLocale('en', () => {
      expect(parseJsonValue('{', {})).toEqual({
        ok: false,
        message: 'Enter valid JSON in this field, then submit again.',
      });
    });
    withLocale('ar', () => {
      const result = parseJsonValue('{', {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toContain('أدخل JSON صالحًا');
      expect(result.message).not.toMatch(/JSON at position|Unexpected|Invalid JSON payload/);
    });
  });
});
