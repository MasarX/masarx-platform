// Platform imports: import job cancellation form (issue #302).
import type { CatalogShape } from '@/lib/i18n';

export const en = {
  platformImportsCancel: {
    importCancelReasonForm: {
      enterTheOperatorReason: 'Enter the operator reason before cancelling this import job.',
      importCancellationFailed: 'Import cancellation failed',
      currentStatus: 'Current status',
      reason: 'Reason',
      cancellationReason: 'Cancellation reason',
      whyIsThisImport: 'Why is this import being cancelled?',
      close: 'Close',
      confirmCancellation: 'Confirm cancellation',
    },
  },
};

export const ar: CatalogShape<typeof en> = {
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
