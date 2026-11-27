// Platform auth email URL policy: Console V2 copy in English and Arabic (issue #302).
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/platform-auth-email';

const messages: CatalogShape<typeof English> = {
  platformAuthEmail: {
    copyableUrl: {
      copyUrl: 'نسخ الرابط',
      copy: 'نسخ',
    },
    authEmailModule: {
      platform: 'المنصة',
      youDoNotHave: 'ليس لديك إذن لعرض سياسة روابط بريد المصادقة.',
      readOnly: 'للقراءة فقط',
      managedByPlatformRelease: 'تُدار عبر ضوابط إصدار المنصّة',
      copyRawJson: 'نسخ JSON الخام',
      environment: 'البيئة',
      audit: 'التدقيق {audit_status}',
      lastReviewed: 'آخر مراجعة: {last_audit_at}',
      managedThroughPlatformRelease: 'تُدار عبر ضوابط إصدار المنصّة.',
      copyPolicyReference: 'نسخ مرجع السياسة',
      copy: 'نسخ',
      callbackUrls: 'روابط الاستدعاء · {length}',
      redirectUrls: 'روابط إعادة التوجيه · {length}',
      policySummary: 'ملخص السياسة',
      copy2: 'نسخ',
      auditStatus: 'حالة التدقيق',
      lastReviewed2: 'آخر مراجعة',
      callbackUrls2: 'روابط الاستدعاء',
      redirectUrls2: 'روابط إعادة التوجيه',
      hostedCallbackUrlsAre: 'تخضع روابط الاستدعاء المستضافة لضوابط إصدار المنصّة. هذه الصفحة للقراءة فقط؛ وتُراجع التغييرات خارج وحدة التحكم قبل الترقية.',
      titleAccent: 'سياسة روابط',
      titlePlain: 'بريد المصادقة',
    },
    copy: {
      copied: 'تم النسخ · {label}',
      copyFailed: 'فشل النسخ',
      clipboardUnavailable: 'الحافظة غير متاحة',
      url: 'الرابط',
      rawPolicyJson: 'JSON الخام للسياسة',
      policyReference: 'مرجع السياسة',
      policySummary: 'ملخص السياسة',
    },
    summary: {
      sourceFile: 'الملف المصدر: {value}',
      environment: 'البيئة: {value}',
      auditStatus: 'حالة التدقيق: {value}',
      callbackUrls: 'عناوين رد الاستدعاء: {count}',
      redirectUrls: 'عناوين إعادة التوجيه: {count}',
    },
  },
};

export default messages;
