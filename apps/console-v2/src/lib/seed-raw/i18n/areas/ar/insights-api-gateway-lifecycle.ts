// Insights API gateway outbound lifecycle drawer: Console V2 copy in English and Arabic (issue #302).
import type { CatalogShape } from '@/lib/i18n-catalog';
import type English from '../en/insights-api-gateway-lifecycle';

const messages: CatalogShape<typeof English> = {
  insightsApiGatewayLifecycle: {
    openApiGatewayOutboundLifecycleDrawer: {
      providerDeliveryValue: 'تسليم المزوّد - {value}',
    },
    apiGatewayOutboundLifecycleBody: {
      gatewayRequest: 'طلب البوابة',
      correlation: 'الارتباط',
      providerReference: 'مرجع المزوّد',
      providerDeliveryStatus: 'حالة تسليم المزوّد',
      providerStatus: 'حالة المزوّد',
      providerError: 'خطأ المزوّد',
      providerErrorDetail: 'تفاصيل خطأ المزوّد',
      workflowRun: 'تشغيل سير العمل',
      shipment: 'الشحنة',
      policyCheck: 'فحص السياسة',
      recorded: 'مسجّل',
      received: 'مستلم',
      pending: 'قيد الانتظار',
      noProviderDeliveryUpdate: 'لا يوجد تحديث لتسليم المزوّد بعد',
      noProviderDeliveryUpdate2: 'لا يتوفر تحديث لتسليم المزوّد لطلب API هذا بعد.',
    },
  },
};

export default messages;
