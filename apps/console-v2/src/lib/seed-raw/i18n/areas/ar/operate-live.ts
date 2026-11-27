import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/operate-live';

const messages: CatalogShape<typeof English> = {
  live: {
    state: {
      syncing: 'جارٍ المزامنة',
      live: 'مباشر',
      reconnecting: 'جارٍ إعادة الاتصال',
      offline: 'غير متصل',
      polling: 'تحديث تلقائي',
    },
    statusbar: {
      syncing: 'جارٍ مزامنة التحديثات المباشرة',
      live: 'التحديثات المباشرة متصلة',
      reconnecting: 'جارٍ إعادة الاتصال بالتحديثات المباشرة',
      offline: 'غير متصل',
      polling: 'تحديث تلقائي',
    },
    connectedTitle: 'متصل. آخر تغيير قبل {age}.',
    lastUpdate: 'آخر تحديث قبل {age}',
    dataFrom: 'البيانات من {time}',
    dataFromLabel: 'البيانات من {time}',
    pausedBanner: 'التحديثات المباشرة متوقفة مؤقتاً. البيانات المعروضة من {time} وقد لا تكون حديثة.',
    offlineBanner: 'أنت غير متصل. البيانات المعروضة من {time}. التعديلات متوقفة حتى تعود للاتصال.',
    reconnectToSave: 'أعد الاتصال للحفظ',
    show: 'عرض',
    updated: 'محدّثة',
    newRuns: {
      zero: 'لا جولات جديدة',
      one: 'جولة جديدة واحدة',
      two: 'جولتان جديدتان',
      few: '{count} جولات جديدة',
      many: '{count} جولة جديدة',
      other: '{count} جولة جديدة',
    },
    newShipments: {
      zero: 'لا شحنات جديدة',
      one: 'شحنة جديدة واحدة',
      two: 'شحنتان جديدتان',
      few: '{count} شحنات جديدة',
      many: '{count} شحنة جديدة',
      other: '{count} شحنة جديدة',
    },
    conflict: {
      stopTitle: 'تغيّرت هذه المحطة أثناء تحريرك',
      body: 'حدّثها شخص آخر. يبقى ما أدخلته دون حفظ حتى تغلق النموذج.',
      review: 'مراجعة التغيير',
      keep: 'متابعة التحرير',
    },
  },
};

export default messages;
