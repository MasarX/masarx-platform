// Platform configuration and scope ladder: Console V2 copy in English and Arabic (issue #302).
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/platform-config';

const messages: CatalogShape<typeof English> = {
  platformConfig: {
    scopeBox: {
      inherit: 'موروث',
      resolvedFrom: 'مصدر الحسم: resolved_from={resolved_from}',
    },
    resolvedValuePanel: {
      largeSavedPolicyValue: 'تم تلخيص قيمة السياسة المحفوظة الكبيرة لتسهيل مراجعتها. تتوفر التفاصيل الكاملة للسياسة المحفوظة أدناه عند الحاجة.',
      showFullSavedPolicy: 'عرض التفاصيل الكاملة للسياسة المحفوظة',
    },
    compareScopesBody: {
      resolvesTheSameSetting: 'يحسم الإعداد نفسه في كل نطاق تسمح به هذه الفئة. النطاقات الأدنى تتجاوز الأعلى؛ و"inherit" تعني عدم وجود صف في ذلك النطاق (الانتقال إلى السلّم).',
    },
    configModule: {
      compareScopes: 'مقارنة النطاقات · {category}',
      close: 'إغلاق',
      compareScopesFailed: 'فشلت مقارنة النطاقات',
      requestSettingsChange: 'طلب تغيير الإعدادات',
      changePreviewReady: 'معاينة التغيير جاهزة',
      changeRequestSubmitted: 'تم إرسال طلب التغيير',
      changePreviewCouldNot: 'تعذّر إعداد معاينة التغيير. راجع تفاصيل الإعداد وحاول مرة أخرى.',
      settingApplied: 'تم تطبيق الإعداد',
      settingCouldNotBe: 'تعذّر تطبيق الإعداد. راجع تفاصيل الإعداد وحاول مرة أخرى.',
      platform: 'المنصة',
      policyResolver: 'أداة حسم السياسة',
      youDoNotHave: 'ليس لديك إذن لعرض الإعدادات وسلّم النطاق.',
      compareScopes2: 'مقارنة النطاقات',
      requestChange: 'طلب تغيير',
      approvalRequired: 'يتطلب اعتمادًا',
      noSettingsCategoriesRegistered: 'لا توجد فئات إعدادات مسجلة.',
      setting: 'الإعداد',
      schemaIdServerSide: 'معرّف المخطط (يتحقق منه الخادم عبر ajv هنا)',
      autoApply: 'تطبيق تلقائي',
      scopes: 'النطاقات: {value}',
      theSavedPolicySource: 'مصدر السياسة المحفوظة تنقصه تفاصيل النطاق المطلوبة.',
      resolutionRecorded: 'تم تسجيل الحسم',
      openPolicyHistory: 'فتح سجل السياسة',
      overrideReplaces: 'تجاوز: {resolved_from} يحل محل {override_of}',
      resolvedValue: 'القيمة المحسومة',
      scopeLadder: 'سلّم النطاق',
      relatedWorkflows: 'سير العمل المرتبط',
      resolvesAtTheScope: 'يُحسم {value} في النطاق {resolved_from}. يستخدم سير العمل المرتبط قرار السياسة المحفوظ هذا تلقائيًا.',
      titleAccent: 'الإعدادات',
      titlePlain: '— سلّم النطاق',
    },
  },
};

export default messages;
