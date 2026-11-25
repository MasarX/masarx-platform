// RouteError.tsx - router default error view, localized from the EN/AR catalogs.
import { StateView } from '@/components/StateView';
import { Button } from '@/components/Button';
import { useI18n } from '@/lib/i18n';

export function RouteError({ error, reset }: { error: unknown; reset: () => void }) {
  const { t } = useI18n();
  return (
    <div className="page" style={{ padding: '24px' }}>
      <StateView
        kind="error"
        title={t('route.errorTitle')}
        hint={error instanceof Error && error.message ? error.message : t('route.errorHint')}
        action={<Button label={t('common.retry')} iconName="refresh" kind="primary" onClick={reset} />}
      />
    </div>
  );
}
