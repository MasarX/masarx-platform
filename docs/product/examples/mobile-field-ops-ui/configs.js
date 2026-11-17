(() => {
  const sharedSettingsRows = [
    {
      category: 'mobile_visibility_policy',
      scopeType: 'global',
      scopeId: null,
      value: { allowed_modes: ['assigned_only', 'branch', 'zone', 'organization'], default_mode: 'assigned_only' },
    },
    {
      category: 'mobile_visibility_policy',
      scopeType: 'tenant',
      scopeId: 'org_demo',
      value: { allowed_modes: ['assigned_only', 'branch', 'organization'], default_mode: 'branch' },
    },
    {
      category: 'mobile_visibility_policy',
      scopeType: 'resource',
      scopeId: 'branches:branch_riyadh',
      value: { allowed_modes: ['assigned_only', 'branch'], default_mode: 'assigned_only' },
    },

    {
      category: 'scan_policy',
      scopeType: 'global',
      scopeId: null,
      value: { accepted_scan_types: ['pickup', 'sort', 'load', 'unload', 'delivery_attempt', 'delivered'] },
    },
    {
      category: 'scan_policy',
      scopeType: 'sender',
      scopeId: 'sender_acme_main',
      value: { accepted_scan_types: ['sort', 'load', 'unload', 'delivered'] },
    },

    {
      category: 'pod_policy',
      scopeType: 'global',
      scopeId: null,
      value: { requirements: { delivered: { photo: true, signature: false, otp: false } } },
    },
    {
      category: 'pod_policy',
      scopeType: 'client',
      scopeId: 'client_acme',
      value: { requirements: { delivered: { photo: true, signature: true, otp: false } } },
    },

    {
      category: 'device_policy',
      scopeType: 'global',
      scopeId: null,
      value: { allowed_platforms: ['android', 'ios', 'scanner'], default_platform: 'android' },
    },

    {
      category: 'navigation_policy',
      scopeType: 'global',
      scopeId: null,
      value: { provider_by_platform: { ios: 'apple', android: 'google', scanner: 'google' } },
    },

    {
      category: 'map_policy',
      scopeType: 'global',
      scopeId: null,
      value: {
        route_views: ['list', 'orders_map'],
        default_route_view_by_layout: { C: 'list' },
        clustering: { enabled: true, grid_px: 120, min_count: 2 },
        show_legend: true,
      },
    },

    {
      category: 'address_policy',
      scopeType: 'global',
      scopeId: null,
      value: {
        fields: [
          { key: 'buildingNo', label: { en: 'Building', ar: 'مبنى' }, required: true },
          { key: 'street', label: { en: 'Street', ar: 'شارع' }, required: true },
          { key: 'district', label: { en: 'District', ar: 'حي' }, required: true },
          { key: 'city', label: { en: 'City', ar: 'مدينة' }, required: true },
          { key: 'postalCode', label: { en: 'Postal Code', ar: 'الرمز البريدي' }, required: false },
          { key: 'secondaryNo', label: { en: 'Secondary No', ar: 'رقم إضافي' }, required: false },
          { key: 'shortAddress', label: { en: 'Short Address', ar: 'العنوان المختصر' }, required: false },
        ],
        show_coordinates: true,
        show_accuracy: true,
      },
    },

    {
      category: 'communication_policy',
      scopeType: 'global',
      scopeId: null,
      value: {
        allowed_channels: ['call', 'sms', 'whatsapp'],
        templates: [
          {
            id: 'on_way',
            label: { en: 'On my way', ar: 'في الطريق' },
            message: { en: 'Hi, I am on my way to your address.', ar: 'مرحباً، أنا في الطريق إلى عنوانك.' },
          },
          {
            id: 'arrived',
            label: { en: 'Arrived', ar: 'وصلت' },
            message: { en: 'I arrived. Please be ready to receive your order.', ar: 'وصلت. الرجاء الاستعداد لاستلام طلبك.' },
          },
          {
            id: 'need_help',
            label: { en: 'Need directions', ar: 'أحتاج إرشادات' },
            message: { en: 'I need a landmark or gate number to find you.', ar: 'أحتاج علامة مميزة أو رقم البوابة للوصول إليك.' },
          },
        ],
      },
    },

    {
      category: 'driver_safety_policy',
      scopeType: 'global',
      scopeId: null,
      value: {
        driving_mode: {
          enabled: true,
          lock_when_moving: true,
          lock_threshold_kph: 8,
          speed_presets_kph: [0, 35, 90],
          allowed_nav_keys_while_moving: ['route'],
          max_single_glance_sec: 2,
          max_total_glance_sec: 12,
        },
      },
    },

    {
      category: 'ux_safety_policy',
      scopeType: 'global',
      scopeId: null,
      value: {
        require_double_tap_for: ['task_completed', 'task_exception', 'settlement_counted'],
      },
    },

    {
      category: 'mobile_diagnostics_policy',
      scopeType: 'global',
      scopeId: null,
      value: { enabled: true, allow_user_toggle: true, default_enabled: false, expose_resolution: true },
    },
  ];

  const base = {
    shell: {
      title: { en: 'MasarX Field Ops', ar: 'MasarX عمليات الميدان' },
      frame: { widthPx: 520, heightPx: 920 },
    },
    demoDefaults: {
      role: 'driver',
      devicePlatform: 'android',
      direction: 'ltr',
      locale: 'en',
      theme: 'system',
    },
    demoRoleDefaults: {
      driver: {
        devicePlatform: 'android',
        scanInputMode: 'scanner',
        visibilityMode: 'assigned_only',
        user: { id: 'user_demo_driver', name: 'Ahmed', assignedBranchId: 'branch_riyadh' },
      },
      warehouse: {
        devicePlatform: 'scanner',
        scanInputMode: 'scanner',
        visibilityMode: 'branch',
        user: { id: 'user_demo_wh', name: 'Warehouse', assignedBranchId: 'branch_riyadh' },
      },
      cashier: {
        devicePlatform: 'android',
        scanInputMode: 'camera',
        visibilityMode: 'branch',
        user: { id: 'user_demo_cashier', name: 'Cashier', assignedBranchId: 'branch_riyadh' },
      },
    },
    settingsRows: sharedSettingsRows,
  };

  const versionC = {
    ...base,
    shell: {
      ...base.shell,
      layout: 'C',
      modulesByRole: {
        driver: [
          { key: 'tasks', label: { en: 'Tasks', ar: 'المهام' } },
          { key: 'route', label: { en: 'Route', ar: 'المسار' } },
          { key: 'scan', label: { en: 'Scan', ar: 'مسح' } },
          { key: 'settlements', label: { en: 'Settlements', ar: 'التسويات' } },
          { key: 'more', label: { en: 'More', ar: 'المزيد' } },
        ],
        warehouse: [
          { key: 'scan', label: { en: 'Scan Kiosk', ar: 'نقطة المسح' } },
          { key: 'inventory', label: { en: 'Inventory', ar: 'المخزون' } },
          { key: 'baskets', label: { en: 'Baskets', ar: 'سلال' } },
          { key: 'tasks', label: { en: 'Work Queue', ar: 'قائمة العمل' } },
          { key: 'more', label: { en: 'Settings', ar: 'إعدادات' } },
        ],
        cashier: [
          { key: 'settlements', label: { en: 'Ledger', ar: 'الدفتر' } },
          { key: 'tasks', label: { en: 'Exceptions', ar: 'استثناءات' } },
          { key: 'scan', label: { en: 'Scan', ar: 'مسح' } },
          { key: 'more', label: { en: 'More', ar: 'المزيد' } },
        ],
      },
      modules: [{ key: 'tasks', label: { en: 'Tasks', ar: 'المهام' } }],
    },
  };

  globalThis.MX_FIELDOPS_SAMPLE_CONFIGS = { versionC };
})();
