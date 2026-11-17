import {
  DEFAULT_MOBILE_ADDRESS_POLICY,
  DEFAULT_MOBILE_COMMUNICATION_POLICY,
  DEFAULT_MOBILE_DIAGNOSTICS_POLICY,
  DEFAULT_MOBILE_DEVICE_POLICY,
  DEFAULT_MOBILE_DRIVER_SAFETY_POLICY,
  DEFAULT_MOBILE_MAP_POLICY,
  DEFAULT_MOBILE_NAVIGATION_POLICY,
  DEFAULT_MOBILE_UX_SAFETY_POLICY,
  DEFAULT_MOBILE_VISIBILITY_POLICY,
  normalizeMobileAddressPolicy,
  normalizeMobileCommunicationPolicy,
  normalizeMobileDiagnosticsPolicy,
  normalizeMobileDevicePolicy,
  normalizeMobileDriverSafetyPolicy,
  normalizeMobileMapPolicy,
  normalizeMobileNavigationPolicy,
  normalizeMobileUxSafetyPolicy,
  normalizeMobileVisibilityPolicy,
} from "../../../apps/fieldops/src/mobile-shell-policy";

describe("mobile shell policy helpers", () => {
  test("normalizeMobileVisibilityPolicy returns safe defaults", () => {
    expect(normalizeMobileVisibilityPolicy(null)).toEqual(DEFAULT_MOBILE_VISIBILITY_POLICY);
    expect(normalizeMobileVisibilityPolicy({})).toEqual(DEFAULT_MOBILE_VISIBILITY_POLICY);
  });

  test("normalizeMobileVisibilityPolicy respects allowed/default constraints", () => {
    const next = normalizeMobileVisibilityPolicy({
      enabled: false,
      default_visibility: "zone",
      allowed_visibility: ["assigned_only", "branch"],
      allow_user_select: false,
    });

    expect(next).toEqual({
      enabled: false,
      defaultVisibility: "assigned_only",
      allowedVisibility: ["assigned_only", "branch"],
      allowUserSelect: false,
    });
  });

  test("normalizeMobileVisibilityPolicy supports legacy sample keys", () => {
    const next = normalizeMobileVisibilityPolicy({
      default_mode: "branch",
      allowed_modes: ["assigned_only", "branch", "organization"],
      allow_user_select: true,
    });

    expect(next).toEqual({
      enabled: true,
      defaultVisibility: "branch",
      allowedVisibility: ["assigned_only", "branch", "organization"],
      allowUserSelect: true,
    });
  });

  test("normalizeMobileMapPolicy maps configured values", () => {
    const next = normalizeMobileMapPolicy({
      route_views: ["orders_map", "list"],
      default_route_view_by_layout: { mobile: "orders_map" },
      clustering: { enabled: false, grid_px: 96, min_count: 3 },
      show_legend: false,
    });

    expect(next).toEqual({
      openMap: DEFAULT_MOBILE_MAP_POLICY.openMap,
      routeViews: ["orders_map", "list"],
      defaultRouteView: "orders_map",
      clusteringEnabled: false,
      clusteringGridPx: 96,
      clusteringMinCount: 3,
      showLegend: false,
    });
  });

  test("normalizeMobileMapPolicy supports uppercase layout keys", () => {
    const next = normalizeMobileMapPolicy({
      route_views: ["list", "orders_map"],
      default_route_view_by_layout: { C: "orders_map" },
    });
    expect(next.defaultRouteView).toBe("orders_map");
  });

  test("normalizeMobileDriverSafetyPolicy returns defaults on invalid input", () => {
    const next = normalizeMobileDriverSafetyPolicy({
      driving_mode: {
        enabled: "yes",
        lock_when_moving: "yes",
        lock_threshold_kph: "8",
      },
    });
    expect(next).toEqual(DEFAULT_MOBILE_DRIVER_SAFETY_POLICY);
  });

  test("normalizeMobileUxSafetyPolicy supports override", () => {
    const next = normalizeMobileUxSafetyPolicy({
      require_double_tap_for: ["task_completed", "scan_submit"],
    });
    expect(next).toEqual({
      requireDoubleTapFor: ["task_completed", "scan_submit"],
    });
  });

  test("normalizeMobileDevicePolicy maps allowed/default platforms", () => {
    const next = normalizeMobileDevicePolicy({
      allowed_platforms: ["ios", "android"],
      default_platform: "ios",
    });
    expect(next).toEqual({
      allowedPlatforms: ["ios", "android"],
      defaultPlatform: "ios",
    });
  });

  test("normalizeMobileDevicePolicy falls back to defaults", () => {
    expect(
      normalizeMobileDevicePolicy({
        allowed_platforms: ["unknown"],
        default_platform: "unknown",
      })
    ).toEqual(DEFAULT_MOBILE_DEVICE_POLICY);
  });

  test("normalizeMobileNavigationPolicy maps providers and falls back", () => {
    const next = normalizeMobileNavigationPolicy({
      provider_by_platform: {
        ios: "apple_maps",
        android: "google_maps",
      },
    });
    expect(next).toEqual({
      providerByPlatform: {
        ios: "apple_maps",
        android: "google_maps",
        scanner: DEFAULT_MOBILE_NAVIGATION_POLICY.providerByPlatform.scanner,
      },
    });
  });

  test("normalizeMobileCommunicationPolicy parses channels/templates", () => {
    const next = normalizeMobileCommunicationPolicy({
      allowed_channels: ["call", "sms"],
      templates: [
        { id: "on_way", label: "On my way", message: "Arriving soon" },
        { id: "arrived", message: "I am outside" },
      ],
    });

    expect(next).toEqual({
      allowedChannels: ["call", "sms"],
      templates: [
        { id: "on_way", label: "On my way", message: "Arriving soon" },
        { id: "arrived", label: "arrived", message: "I am outside" },
      ],
      supportContacts: [],
    });
  });

  test("normalizeMobileCommunicationPolicy supports localized template strings", () => {
    const next = normalizeMobileCommunicationPolicy({
      allowed_channels: ["whatsapp"],
      templates: [
        {
          id: "on_way",
          label: { en: "On my way", ar: "on_way_ar" },
          message: { en: "Arriving soon", ar: "arriving_soon_ar" },
        },
      ],
    });
    expect(next).toEqual({
      allowedChannels: ["whatsapp"],
      templates: [{ id: "on_way", label: "On my way", message: "Arriving soon" }],
      supportContacts: [],
    });
  });

  test("normalizeMobileCommunicationPolicy falls back channel defaults", () => {
    const next = normalizeMobileCommunicationPolicy({
      allowed_channels: "call",
      templates: [{ id: "" }],
    });
    expect(next).toEqual(DEFAULT_MOBILE_COMMUNICATION_POLICY);
  });

  test("normalizeMobileCommunicationPolicy parses support contacts", () => {
    const next = normalizeMobileCommunicationPolicy({
      allowed_channels: ["call", "sms", "whatsapp"],
      support_contacts: [
        {
          id: "dispatcher",
          role: "dispatcher",
          label: { en: "Dispatch desk" },
          name: "Route Dispatch",
          phone_number: "+12025550123",
          allowed_channels: ["call", "sms"],
          notes: "Use when customer is unreachable",
        },
      ],
    });

    expect(next.supportContacts).toEqual([
      {
        id: "dispatcher",
        role: "dispatcher",
        label: "Dispatch desk",
        name: "Route Dispatch",
        phone: "+12025550123",
        allowedChannels: ["call", "sms"],
        notes: "Use when customer is unreachable",
      },
    ]);
  });

  test("normalizeMobileAddressPolicy parses fields and flags", () => {
    const next = normalizeMobileAddressPolicy({
      fields: [
        { key: "street", label: "Street", required: true },
        { key: "district" },
      ],
      show_coordinates: false,
      show_accuracy: false,
    });
    expect(next).toEqual({
      fields: [
        { key: "street", label: "Street", required: true },
        { key: "district", label: "district", required: false },
      ],
      showCoordinates: false,
      showAccuracy: false,
    });
  });

  test("normalizeMobileAddressPolicy supports localized field labels", () => {
    const next = normalizeMobileAddressPolicy({
      fields: [{ key: "district", label: { en: "District", ar: "district_ar" }, required: true }],
    });
    expect(next.fields).toEqual([{ key: "district", label: "District", required: true }]);
  });

  test("normalizeMobileAddressPolicy falls back to defaults", () => {
    expect(normalizeMobileAddressPolicy({})).toEqual(DEFAULT_MOBILE_ADDRESS_POLICY);
  });

  test("normalizeMobileDiagnosticsPolicy supports default_enabled fallback", () => {
    expect(
      normalizeMobileDiagnosticsPolicy({
        enabled: true,
        allow_user_toggle: true,
        default_enabled: true,
        expose_resolution: true,
      })
    ).toEqual({
      enabled: true,
      allowUserToggle: true,
      defaultOn: true,
      exposeResolution: true,
    });
  });

  test("normalizeMobileDiagnosticsPolicy returns defaults on invalid values", () => {
    expect(normalizeMobileDiagnosticsPolicy({})).toEqual(DEFAULT_MOBILE_DIAGNOSTICS_POLICY);
  });
});
