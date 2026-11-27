// Capability names and the permission phrases built from them (lib/capabilities).
// Label keys are the capability keys, split at the dot into resource and action.
// English labels for keys without a hand-written name are the key words, as before.
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/capabilities';

const messages: CatalogShape<typeof English> = {
  capabilities: {
    required: 'يلزم إذن {label}',
    requires: 'يتطلب إذن {label}',
    fallback: 'هذا الإجراء',
    fallbackTitle: 'هذا الإجراء',
    or: ' أو ',
    scopeAnd: '{scope} و{requirement}',
    scopeRequired: 'يلزم {scope}',
    scope: {
      platform: 'نطاق المنصة',
      tenant: 'نطاق المستأجر',
      client: 'نطاق العميل',
      sender: 'نطاق المرسل',
      other: 'النطاق المطلوب',
    },
    labels: {
      access_policy: {
        approve: 'اعتماد الوصول',
        read: 'سياسة الوصول',
      },
      addresses: {
        read: 'قراءة العناوين',
      },
      agreements: {
        write: 'إدارة مستوى الخدمة',
      },
      alerts: {
        read: 'قراءة التنبيهات',
        write: 'تحديث التنبيهات',
      },
      api_gateway: {
        read: 'بوابة API',
        write: 'تحديث بوابة API',
      },
      audit_log: {
        read: 'نشاط التدقيق',
      },
      baskets: {
        read: 'قراءة السلال',
        write: 'تحديث السلال',
      },
      billing: {
        read: 'قراءة الفوترة',
        write: 'تحديث الفوترة',
      },
      branches: {
        read: 'قراءة الفروع',
        write: 'تحديث الفروع',
      },
      clients: {
        read: 'الوصول إلى العملاء',
        write: 'تحديث العملاء',
      },
      cod: {
        read: 'الدفع عند الاستلام',
      },
      comms: {
        write: 'تحديث الاتصالات',
      },
      console_metadata: {
        read: 'قراءة البيانات الوصفية لوحدة التحكم',
      },
      devices: {
        write: 'إدارة الأجهزة',
      },
      disputes: {
        read: 'قراءة النزاعات',
        write: 'تحديث النزاعات',
      },
      feature_flags: {
        read: 'علامات الميزات',
        write: 'تحديث علامات الميزات',
      },
      finance: {
        read: 'الوصول إلى المالية',
        write: 'تحديث المالية',
      },
      fleet: {
        read: 'قراءة الأسطول',
        write: 'تحديث الأسطول',
      },
      imports: {
        read: 'الوصول إلى الاستيراد',
        write: 'تحديث الاستيراد',
      },
      insights: {
        read: 'قراءة الرؤى',
      },
      integration_plugins: {
        activate: 'تفعيل إضافات التكامل',
        approve: 'اعتماد إضافات التكامل',
        read: 'إضافات التكامل',
        test: 'اختبار إضافات التكامل',
        write: 'تحديث إضافات التكامل',
      },
      integrations: {
        read: 'قراءة التكاملات',
        write: 'تحديث التكاملات',
      },
      invoices: {
        refund: 'استرداد الفواتير',
        send: 'إرسال الفواتير',
      },
      label_design: {
        read: 'قراءة تصميم الملصقات',
        write: 'تحديث تصميم الملصقات',
      },
      labels: {
        download: 'تنزيل الملصقات',
        read: 'قراءة الملصقات',
        reprint: 'إعادة طباعة الملصقات',
        write: 'تحديث الملصقات',
      },
      lookups: {
        read: 'الوصول إلى القوائم المرجعية',
        write: 'تحديث القوائم المرجعية',
      },
      manual_review: {
        resolve: 'حل المراجعة اليدوية',
      },
      mappings: {
        read: 'قراءة التعيينات',
        write: 'تحديث التعيينات',
      },
      marketplace: {
        read: 'قراءة السوق',
        write: 'تحديث السوق',
      },
      marketplace_participant_requests: {
        read: 'طلبات الشركاء',
        review: 'مراجعة طلبات الشركاء',
      },
      network: {
        read: 'قراءة الشبكة',
      },
      observability: {
        read: 'قراءة المراقبة',
      },
      organizations: {
        read: 'قراءة المؤسسات',
        write: 'تحديث المؤسسات',
      },
      pickups: {
        read: 'قراءة الاستلامات',
      },
      provider_auth: {
        read: 'قراءة مصادقة المزوّدين',
      },
      recipients: {
        read: 'الوصول إلى المستلمين',
        write: 'تحديث المستلمين',
      },
      route_plans: {
        read: 'خطط المسارات',
        write: 'تحديث خطط المسارات',
      },
      routes: {
        read: 'قراءة المسارات',
        write: 'تحديث المسارات',
      },
      senders: {
        read: 'الوصول إلى المرسلين',
        write: 'تحديث المرسلين',
      },
      service_offerings: {
        read: 'عروض الخدمات',
        write: 'تحديث عروض الخدمات',
      },
      settings: {
        read: 'الوصول إلى الإعدادات',
        write: 'تحديث الإعدادات',
      },
      settlements: {
        read: 'التسويات',
        write: 'تحديث التسويات',
      },
      shipments: {
        read: 'الوصول إلى الشحنات',
        write: 'تحديث الشحنات',
      },
      support: {
        read: 'قراءة الدعم',
        write: 'تحديث الدعم',
      },
      system: {
        write: 'تحديث النظام',
      },
      tasks: {
        complete: 'إكمال المهام',
        read: 'قراءة المهام',
        write: 'تحديث المهام',
      },
      tenant_signup_requests: {
        read: 'طلبات تسجيل المستأجرين',
        review: 'مراجعة طلبات تسجيل المستأجرين',
      },
      user_devices: {
        read: 'الوصول إلى الأجهزة',
        write: 'إلغاء الأجهزة',
      },
      users: {
        manage: 'إدارة المستخدمين',
        read: 'الوصول إلى المستخدمين',
      },
      warehouse: {
        read: 'قراءة المستودع',
        scan: 'مسح المستودع',
        write: 'تحديث المستودع',
      },
      webhooks: {
        read: 'قراءة خطافات الويب',
        write: 'تحديث خطافات الويب',
      },
      workflows: {
        read: 'قراءة سير العمل',
        write: 'تحديث سير العمل',
      },
      zones: {
        read: 'قراءة المناطق',
        write: 'تحديث المناطق',
      },
    },
  },
};

export default messages;
