// Platform imports: import job cancellation form (issue #302).
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/platform-imports-cancel';

const messages: CatalogShape<typeof English> = {
  platformImportsCancel: {
    importCancelReasonForm: {
      enterTheOperatorReason: 'أدخل سبب المشغل قبل إلغاء مهمة الاستيراد هذه.',
      importCancellationFailed: 'فشل إلغاء الاستيراد',
      currentStatus: 'الحالة الحالية',
      reason: 'السبب',
      cancellationReason: 'سبب الإلغاء',
      whyIsThisImport: 'لماذا يُلغى هذا الاستيراد؟',
      close: 'إغلاق',
      confirmCancellation: 'تأكيد الإلغاء',
    },
  },
};

export default messages;
