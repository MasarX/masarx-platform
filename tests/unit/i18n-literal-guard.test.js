const { scanSource, scanRepo, readBaseline, check } = require('../../scripts/tooling/i18n-literal-guard');

const texts = (source, file = 'fixture.tsx') => scanSource(source, file).map((f) => `${f.kind}:${f.text}`);

describe('i18n literal guard rule', () => {
  test('flags English JSX text, user-facing props, toasts and error setters', () => {
    const source = `
      export function Page() {
        pushToast('Shipment saved', 'good');
        toast({ tone: 'success', title: 'Route published' });
        Alert.alert('Sign-in failed', 'Check your code');
        setFormError('Name is required');
        const columns = [{ key: 'status', header: 'Status' }];
        return (
          <section aria-label="Shipment list" title={busy ? 'Saving' : 'Saved'}>
            <h1>Shipments</h1>
            <Button confirmLabel="Delete route" emptyText={'Nothing here'} />
            {loading ? 'Loading' : null}
          </section>
        );
      }`;
    expect(texts(source)).toEqual([
      'toast:Shipment saved',
      'prop:Route published',
      'toast:Sign-in failed',
      'toast:Check your code',
      'error:Name is required',
      'prop:Status',
      'prop:Shipment list',
      'prop:Saving',
      'prop:Saved',
      'jsx-text:Shipments',
      'prop:Delete route',
      'prop:Nothing here',
      'jsx-text:Loading',
    ]);
  });

  test('passes catalog lookups, codes, symbols, IDs and marked literals', () => {
    const source = `
      export function Page({ id }) {
        pushToast(t('ships.saved', 'Shipment saved'), 'good');
        toast({ tone: 'success', title: t('routes.published') });
        setError(null);
        const columns = [{ key: 'status', header: t('cols.status', 'Status'), label: 'status_code' }];
        return (
          <section className="flex gap-2" aria-labelledby="h1" data-testid="ship-list" title={t('a', 'Fallback')}>
            <h1>{t('ships.title', 'Shipments')}</h1>
            <span dir="ltr">{id}</span> · — 42%
            <span>MasarX {/* i18n-literal-ok brand */}</span>
          </section>
        );
      }`;
    expect(texts(source)).toEqual([]);
  });

  test('scans calls in .ts files, where JSX cannot appear', () => {
    expect(texts("pushToast('Copied to clipboard', 'info');", 'helper.ts')).toEqual(['toast:Copied to clipboard']);
  });

  test('a new file, a higher count or a stale baseline line fails', () => {
    const finding = [{ line: 3, kind: 'jsx-text', text: 'Shipments' }];
    const baseline = { entries: new Map([['a.tsx', 1], ['gone.tsx', 2]]), problems: [] };
    const current = new Map([['a.tsx', [...finding, ...finding]], ['new.tsx', finding]]);
    expect(check(current, baseline)).toEqual([
      'a.tsx: 2 literals, baseline allows 1; move the new ones to the catalogs',
      'new.tsx: 1 new literal(s); move them to the catalogs. First: line 3 "Shipments"',
      'gone.tsx: no literals left; delete its baseline line',
    ]);
    expect(check(new Map([['a.tsx', finding]]), { entries: new Map([['a.tsx', 1]]), problems: [] })).toEqual([]);
  });
});

describe('i18n literal baseline', () => {
  test('the repository holds no literal beyond the baseline, and the baseline has no stale line', () => {
    const baseline = readBaseline();
    expect(check(scanRepo(), baseline)).toEqual([]);
  }, 60000);
});
