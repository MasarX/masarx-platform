// Insights API gateway outbound lifecycle drawer: Console V2 copy in English and Arabic (issue #302).
import type { CatalogShape } from '@/lib/i18n';

export const en = {
  insightsApiGatewayLifecycle: {
    openApiGatewayOutboundLifecycleDrawer: {
      providerDeliveryValue: 'Provider delivery - {value}',
    },
    apiGatewayOutboundLifecycleBody: {
      gatewayRequest: 'Gateway request',
      correlation: 'Correlation',
      providerReference: 'Provider reference',
      providerDeliveryStatus: 'Provider delivery status',
      providerStatus: 'Provider status',
      providerError: 'Provider error',
      providerErrorDetail: 'Provider error detail',
      workflowRun: 'Workflow run',
      shipment: 'Shipment',
      policyCheck: 'Policy check',
      recorded: 'Recorded',
      received: 'Received',
      noProviderDeliveryUpdate: 'No provider delivery update yet',
      noProviderDeliveryUpdate2: 'No provider delivery update is available for this API request yet.',
    },
  },
};

export const ar: CatalogShape<typeof en> = {
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
      noProviderDeliveryUpdate: 'لا يوجد تحديث لتسليم المزوّد بعد',
      noProviderDeliveryUpdate2: 'لا يتوفر تحديث لتسليم المزوّد لطلب API هذا بعد.',
    },
  },
};
