// Insights activity traces: Console V2 copy in English and Arabic (issue #302).
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/insights-traces';

const messages: CatalogShape<typeof English> = {
  insightsTraces: {
    observabilityRow: {
      eventEventTypeDurms: 'الحدث {event_type}، {durMs} مللي ثانية',
      durationMs: '{ms} مللي ثانية',
    },
    eventDrawerBody: {
      activityEvent: 'حدث النشاط',
      notAvailable: 'غير متاح',
      additionalDetails: 'تفاصيل إضافية',
      activityHistory: 'سجل النشاط',
      thisLookupReturnsTimeline: 'يعرض هذا البحث أحداث الخط الزمني وأحداث النطاق وتشغيلات سير العمل لمرجع النشاط المحدد.',
      event: 'الحدث: {value}',
      source: 'المصدر: {value}',
      resource: 'المورد: {value}',
      status: 'الحالة: {value}',
      eventTime: 'وقت الحدث: {value}',
      duration: 'المدة: {value}',
      durationMs: '{ms} مللي ثانية',
      additionalDetailsCountOne: 'تفصيل إضافي واحد ({count}) مسجّل لمراجعة الدعم.',
      additionalDetailsCount: '{count} من التفاصيل الإضافية مسجّلة لمراجعة الدعم.',
    },
    domainEventCard: {
      recorded: 'مسجّل',
      notAvailable: 'غير متاح',
    },
    workflowRunCard: {
      recorded: 'مسجّل',
      workflowTemplate: 'سير العمل: مسجّل · القالب: {value}',
      notAvailable: 'غير متاح',
    },
    tracesModule: {
      copiedActiveid: 'تم النسخ · {activeId}',
      clipboardBlocked: 'الحافظة محظورة',
      eventEventType: 'الحدث · {event_type}',
      activityHistory: 'سجل النشاط',
      insights: 'التحليلات',
      activity: 'النشاط',
      youNeedActivityHistory: 'تحتاج إلى صلاحية الوصول إلى سجل النشاط لعرض هذه الصفحة.',
      activityReference: 'مرجع النشاط',
      copyActivityReference: 'نسخ مرجع النشاط',
      copyReference: 'نسخ المرجع',
      openThisActivityIn: 'فتح هذا النشاط في علامة تبويب جديدة',
      openInNewTab: 'فتح في علامة تبويب جديدة',
      findActivity: 'البحث عن نشاط',
      noActivityReferenceSelected: 'لم يتم تحديد مرجع نشاط',
      pasteAnActivityReference: 'الصق مرجع نشاط أعلاه لجلب سجله.',
      activityHistoryUnavailable: 'سجل النشاط غير متاح',
      couldNotLoadActivity: 'تعذّر تحميل سجل النشاط لـ "{activeId}".',
      fetchingActivityForActiveid: 'جارٍ جلب النشاط لـ "{activeId}"...',
      noEventsFound: 'لم يتم العثور على أحداث',
      noActivityFoundFor: 'لم يتم العثور على نشاط للمرجع "{activeId}".',
      recorded: 'مسجّل',
      totalValueMs: ' · الإجمالي {value} مللي ثانية',
      totalMs: 'الإجمالي · {ms} مللي ثانية',
      eventCounts: '{events} أحداث · {domain} أحداث نطاق · {workflows} عمليات سير عمل',
      timelineEvents: 'أحداث الخط الزمني',
      relatedEvents: 'الأحداث المرتبطة',
      relatedWorkflows: 'سير العمل المرتبط',
      activityReferenceValue: 'مرجع النشاط: {value}',
      notAvailable: 'غير متاح',
      titlePlain: 'السجل',
    },
  },
};

export default messages;
