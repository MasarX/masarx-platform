// Scope pill: the scope a setting was resolved from (components/ScopePill, #302 slice 28).
// `type` keys are the `scope_type` lookup values; an unknown value falls back to the raw token.
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/scope';

const messages: CatalogShape<typeof English> = {
  scopePill: {
    title: 'مستمد من نطاق {scope}',
    type: {
      global: 'عام',
      tenant: 'المستأجر',
      client: 'العميل',
      sender: 'المرسل',
      source: 'المصدر',
      resource: 'المورد',
    },
  },
};

export default messages;
