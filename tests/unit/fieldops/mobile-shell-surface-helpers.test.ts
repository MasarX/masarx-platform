import type { MobileAddressPolicy } from "../../../apps/fieldops/src/mobile-shell-policy";
import {
  buildChannelUrl,
  buildNavigationUrl,
  extractAddressFields,
  extractCoordinates,
  extractCustomerName,
  extractOperationalContacts,
  extractOperationalStopSnapshot,
  extractPhoneNumber,
  extractRouteCardSnapshot,
  extractScanContext,
  extractSettlementSnapshot,
  extractTaskCardSnapshot,
} from "../../../apps/fieldops/src/mobile-shell-surface-helpers";

const ADDRESS_POLICY: MobileAddressPolicy = {
  fields: [
    { key: "buildingNo", label: "Building", required: true },
    { key: "street", label: "Street", required: true },
    { key: "district", label: "District", required: false },
  ],
  showCoordinates: true,
  showAccuracy: true,
};

describe("mobile shell surface helpers", () => {
  test("extractCoordinates parses nested location shapes", () => {
    expect(
      extractCoordinates({
        location: { lat: 24.7136, lng: 46.6753, accuracy_m: 8 },
      })
    ).toEqual({
      latitude: 24.7136,
      longitude: 46.6753,
      accuracyM: 8,
    });
  });

  test("extractCoordinates resolves nested metadata payload", () => {
    expect(
      extractCoordinates({
        metadata: {
          location: {
            latitude: "24.71130",
            longitude: "46.67450",
            gps_accuracy_m: "18",
          },
        },
      })
    ).toEqual({
      latitude: 24.7113,
      longitude: 46.6745,
      accuracyM: 18,
    });
  });

  test("extractPhoneNumber and extractCustomerName parse common keys", () => {
    const detail = {
      customer: {
        name: "Ahmed",
        phone_number: "+12025550123",
      },
    };
    expect(extractCustomerName(detail)).toBe("Ahmed");
    expect(extractPhoneNumber(detail)).toBe("+12025550123");
  });

  test("extractAddressFields matches policy keys across snake/camel case", () => {
    const fields = extractAddressFields(
      {
        address: {
          building_no: "12",
          street: "King Rd",
        },
      },
      ADDRESS_POLICY
    );

    expect(fields).toEqual([
      {
        key: "buildingNo",
        label: "Building",
        value: "12",
        required: true,
        missing: false,
      },
      {
        key: "street",
        label: "Street",
        value: "King Rd",
        required: true,
        missing: false,
      },
      {
        key: "district",
        label: "District",
        value: "-",
        required: false,
        missing: false,
      },
    ]);
  });

  test("extractAddressFields formats nested address object for generic address key", () => {
    const fields = extractAddressFields(
      {
        metadata: {
          address: {
            street: "King Fahd Rd",
            building_no: "7082",
            district: "Al Olaya",
            city: "Riyadh",
            postal_code: "12211",
          },
        },
      },
      {
        fields: [{ key: "address", label: "Address", required: true }],
        showCoordinates: true,
        showAccuracy: true,
      }
    );

    expect(fields).toEqual([
      {
        key: "address",
        label: "Address",
        value: "King Fahd Rd 7082, Al Olaya, Riyadh, 12211",
        required: true,
        missing: false,
      },
    ]);
  });

  test("extractSettlementSnapshot computes variance when missing", () => {
    const settlement = extractSettlementSnapshot(
      {
        settlement_id: "stl-1",
        status: "counting",
        expected_amount: 120,
        counted_amount: 100,
      },
      "fallback"
    );

    expect(settlement.id).toBe("stl-1");
    expect(settlement.expected).toBe(120);
    expect(settlement.counted).toBe(100);
    expect(settlement.variance).toBe(-20);
    expect(settlement.currency).toBe("SAR");
  });

  test("extractSettlementSnapshot reads metadata fields", () => {
    const settlement = extractSettlementSnapshot(
      {
        metadata: {
          settlement_id: "stl-meta-1",
          title: "Route Batch 1",
          currency_code: "SAR",
          expected_amount: "500",
          counted_amount: "490",
        },
      },
      "fallback"
    );

    expect(settlement).toEqual({
      id: "stl-meta-1",
      title: "Route Batch 1",
      status: "open",
      currency: "SAR",
      expected: 500,
      counted: 490,
      variance: -10,
    });
  });

  test("extractOperationalStopSnapshot reads COD payment summary fields", () => {
    const stop = extractOperationalStopSnapshot({
      route_stop: {
        kind: "delivery",
        cod_amount: 150,
        cod_currency: "SAR",
        payment_mode_label: "Card or cash",
        payment: {
          collection_required: true,
          expected_amount: 150,
          currency: "SAR",
          allowed_methods: ["cash", "card"],
          payment_mode_label: "Card or cash",
        },
      },
    });

    expect(stop.codAmount).toBe(150);
    expect(stop.expectedAmount).toBe(150);
    expect(stop.currency).toBe("SAR");
    expect(stop.collectionRequired).toBe(true);
    expect(stop.paymentModeLabel).toBe("Card or cash");
    expect(stop.allowedMethods).toEqual(["cash", "card"]);
  });

  test("extractRouteCardSnapshot normalizes route card metadata", () => {
    const route = extractRouteCardSnapshot({
      kind: "delivery",
      sequence: 3,
      eta_minutes: 14,
      status: "open",
      address: {
        district: "Olaya",
        city: "Riyadh",
      },
    });

    expect(route).toEqual({
      title: "Task",
      customerName: null,
      reference: null,
      sequence: 3,
      kind: "delivery",
      etaMin: 14,
      place: "Olaya - Riyadh",
      status: "open",
      statusReason: null,
      packageCount: null,
      codBadge: null,
    });
  });

  test("extractRouteCardSnapshot reads metadata-first route shape", () => {
    const route = extractRouteCardSnapshot({
      metadata: {
        type: "pickup",
        stop_order: 2,
        eta_minutes: 18,
        state: "in_progress",
        status_reason: "en_route",
        address: {
          district: "Al Mohammadiyah",
          city: "Riyadh",
          short_address: "RNQA7082",
        },
      },
    });

    expect(route).toEqual({
      title: "Task",
      customerName: null,
      reference: null,
      sequence: 2,
      kind: "pickup",
      etaMin: 18,
      place: "Al Mohammadiyah - Riyadh - RNQA7082",
      status: "in_progress",
      statusReason: "en_route",
      packageCount: null,
      codBadge: null,
    });
  });

  test("extractOperationalContacts merges task-context and policy support contacts", () => {
    const contacts = extractOperationalContacts(
      {
        customer: {
          name: "Ahmed",
          phone_number: "+12025550123",
        },
        metadata: {
          support_contacts: [
            {
              role: "dispatcher",
              label: "Dispatcher",
              phone_number: "+12025550123",
            },
          ],
        },
      },
      {
        allowedChannels: ["call", "sms", "whatsapp"],
        templates: [],
        supportContacts: [
          {
            id: "support",
            role: "support",
            label: "Support desk",
            name: "Support desk",
            phone: "+12025550123",
            allowedChannels: ["call"],
            notes: "Escalations only",
          },
        ],
      }
    );

    expect(contacts.customer).toEqual({
      id: "customer:+12025550123",
      source: "customer",
      role: "customer",
      label: "Ahmed",
      name: "Ahmed",
      phone: "+12025550123",
      allowedChannels: ["call", "sms", "whatsapp"],
      notes: null,
    });
    expect(contacts.supportContacts).toEqual([
      {
        id: "task_context:dispatcher:+12025550123",
        source: "task_context",
        role: "dispatcher",
        label: "Dispatcher",
        name: null,
        phone: "+12025550123",
        allowedChannels: ["call", "sms", "whatsapp"],
        notes: null,
      },
      {
        id: "support",
        source: "policy",
        role: "support",
        label: "Support desk",
        name: "Support desk",
        phone: "+12025550123",
        allowedChannels: ["call"],
        notes: "Escalations only",
      },
    ]);
  });

  test("extractTaskCardSnapshot normalizes title chips and due", () => {
    const task = extractTaskCardSnapshot({
      metadata: {
        title: "Deliver: ACME Order #10291",
        status: "in_progress",
        status_reason: "arrived",
        priority: 80,
        sla_minutes: 55,
        address: {
          city: "Riyadh",
          district: "Al Olaya",
        },
      },
    });

    expect(task).toEqual({
      title: "Deliver: ACME Order #10291",
      customerName: null,
      reference: null,
      place: "Al Olaya - Riyadh",
      status: "in_progress",
      statusReason: "arrived",
      priority: "P80",
      due: "Due 55m",
      packageCount: null,
      codBadge: null,
    });
  });

  test("extractScanContext captures route run context", () => {
    const context = extractScanContext({
      id: "task-1",
      metadata: {
        route_run_id: "run-1",
        route_stop_id: "stop-1",
        shipment_id: "shipment-1",
        client_id: "client-1",
      },
    });

    expect(context.routeRunId).toBe("run-1");
    expect(context.routeStopId).toBe("stop-1");
    expect(context.shipmentId).toBe("shipment-1");
  });

  test("extractOperationalStopSnapshot resolves driver-first stop fields", () => {
    const stop = extractOperationalStopSnapshot({
      id: "task-1",
      status: "open",
      metadata: {
        title: "Deliver: ACME Order #10291",
        ref: "ship_aa01",
        kind: "delivery",
        sequence: 1,
        eta_min: 18,
        notes: "Leave at reception.",
        package_count: 3,
        cod_amount: 125,
        currency_code: "SAR",
        address: {
          street: "King Fahd Rd",
          building_no: "7082",
          district: "Al Olaya",
          city: "Riyadh",
          postal_code: "12211",
          short_address: "RNQA7082",
        },
        customer: {
          name: "Faisal",
          phone_number: "+12025550123",
        },
      },
    });

    expect(stop).toEqual({
      title: "Deliver: ACME Order #10291",
      customerName: "Faisal",
      phone: "+12025550123",
      reference: "ship_aa01",
      sequence: 1,
      kind: "delivery",
      status: "open",
      statusReason: null,
      etaMin: 18,
      due: "Due 18m",
      priority: null,
      place: "Al Olaya - Riyadh - RNQA7082",
      addressSummary: "Al Olaya - Riyadh - RNQA7082",
      fullAddress: "King Fahd Rd 7082, Al Olaya, Riyadh, 12211, RNQA7082",
      notes: "Leave at reception.",
      packageCount: 3,
      codAmount: 125,
      expectedAmount: 125,
      currency: "SAR",
      collectionRequired: true,
      paymentModeLabel: null,
      allowedMethods: [],
      recipientMissing: false,
      phoneMissing: false,
      addressMissing: false,
    });
  });

  test("extractOperationalStopSnapshot accepts Saudi short national address aliases", () => {
    const stop = extractOperationalStopSnapshot({
      id: "task-sa-short-code",
      status: "open",
      metadata: {
        address: {
          district: "Al Olaya",
          city: "Riyadh",
          sa_short_code: "RNQA7082",
        },
      },
    });

    expect(stop.place).toBe("Al Olaya - Riyadh - RNQA7082");
    expect(stop.addressSummary).toBe("Al Olaya - Riyadh - RNQA7082");
    expect(stop.fullAddress).toBe("Al Olaya, Riyadh, RNQA7082");
  });

  test("extractScanContext binds task and shipment linkage when present", () => {
    const context = extractScanContext(
      {
        id: "task-1",
        resource_type: "shipment",
        resource_id: "ship-1",
        metadata: {
          ref: "ship_aa01",
          customer: {
            name: "Faisal",
          },
          route_stop_id: "stop-1",
          client_id: "client-1",
        },
      },
      "task-1"
    );

    expect(context).toEqual({
      label: "ship_aa01",
      resourceId: "task-1",
      taskId: "task-1",
      routeRunId: null,
      routeStopId: "stop-1",
      shipmentId: "ship-1",
      clientId: "client-1",
      opsSessionId: null,
      reference: "ship_aa01",
      customerName: "Faisal",
    });
  });

  test("extractScanContext does not promote task ids to route stop ids", () => {
    const context = extractScanContext(
      {
        id: "task-8885",
        resource_type: "shipment",
        metadata: {
          ref: "ship_aa01",
          customer: {
            name: "Faisal",
          },
        },
      },
      "task-8885"
    );

    expect(context).toEqual({
      label: "ship_aa01",
      resourceId: "task-8885",
      taskId: "task-8885",
      routeRunId: null,
      routeStopId: null,
      shipmentId: null,
      clientId: null,
      opsSessionId: null,
      reference: "ship_aa01",
      customerName: "Faisal",
    });
  });

  test("buildNavigationUrl respects provider + platform", () => {
    expect(
      buildNavigationUrl({
        provider: "apple_maps",
        platform: "ios",
        latitude: 24.7,
        longitude: 46.6,
      })
    ).toContain("maps.apple.com");

    expect(
      buildNavigationUrl({
        provider: "google_maps",
        platform: "android",
        latitude: 24.7,
        longitude: 46.6,
      })
    ).toContain("google.com/maps/dir");
  });

  test("buildChannelUrl supports call sms whatsapp", () => {
    expect(buildChannelUrl({ channel: "call", phone: "+12025550123" })).toBe(
      "tel:+12025550123"
    );
    expect(
      buildChannelUrl({
        channel: "sms",
        phone: "+12025550123",
        message: "Hello",
      })
    ).toContain("sms:+12025550123?body=Hello");
    expect(
      buildChannelUrl({
        channel: "whatsapp",
        phone: "+966 50 000 0002",
        message: "On my way",
      })
    ).toContain("https://wa.me/966500000002");
  });
});
