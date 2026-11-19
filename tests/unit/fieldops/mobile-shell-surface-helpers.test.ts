import type { MobileAddressPolicy } from "../../../apps/fieldops/src/mobile-shell-policy";
import {
  buildChannelUrl,
  buildNavigationUrl,
  extractAddressFields,
  extractCoordinates,
  extractCustomerName,
  extractFieldOpsActiveRoleSnapshot,
  fieldOpsLiveSourceResult,
  projectFieldOpsLiveOperations,
  selectFieldOpsLiveSources,
  extractOperationalContacts,
  extractOperationalStopSnapshot,
  extractPhoneNumber,
  extractRouteCardSnapshot,
  extractScanContext,
  extractSettlementSnapshot,
  extractTaskCardSnapshot,
  formatMoneyLabel,
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
  test("active-role snapshot trusts only server-listed role identities", () => {
    const selected = extractFieldOpsActiveRoleSnapshot({
      device_id: "device-1",
      selected_role_id: "role-2",
      selection_state: "selected",
      eligible_roles: [
        { role_id: "role-1", role_key: "driver", label: "Driver", branch_ids: ["b-1", "b-1"] },
        { role_id: "role-2", role_key: "loader", label: "Loader", branch_ids: ["b-2"] },
      ],
    });
    expect(selected).toEqual({
      deviceId: "device-1",
      selectionState: "selected",
      selectedRole: { roleId: "role-2", roleKey: "loader", label: "Loader", branchIds: ["b-2"] },
      eligibleRoles: [
        { roleId: "role-1", roleKey: "driver", label: "Driver", branchIds: ["b-1"] },
        { roleId: "role-2", roleKey: "loader", label: "Loader", branchIds: ["b-2"] },
      ],
    });

    expect(extractFieldOpsActiveRoleSnapshot({
      selected_role_id: "unlisted-role",
      selection_state: "selected",
      eligible_roles: [{ role_id: "role-1", role_key: "driver" }],
    })).toMatchObject({ selectionState: "absent", selectedRole: null });
    expect(extractFieldOpsActiveRoleSnapshot({
      selection_state: "single_eligible",
      eligible_roles: [{ role_id: "role-1", role_key: "driver" }],
    })).toMatchObject({ selectionState: "single_eligible", selectedRole: null });
  });
  test("App reads and sets only the server-authorized active-role contract", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
    expect(app).toContain('client.rpc("ui_get_fieldops_active_role_v1"');
    expect(app).toContain('client.rpc("ui_set_fieldops_active_role_v1"');
    expect(app).toContain("activeRoleSnapshot.eligibleRoles.map");
    expect(app).not.toMatch(/access_token.*active.role|user_metadata.*active.role/i);
  });


  test("extractAddressFields reads backend canonical Saudi short-address aliases", () => {
    const fields = extractAddressFields(
      {
        metadata: {
          address: {
            district: "Al Olaya",
            city: "Riyadh",
            sa_short_code: "RRRD2929",
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
        value: "Al Olaya, Riyadh, RRRD2929",
        required: true,
        missing: false,
      },
    ]);
  });

  test("extractOperationalStopSnapshot includes short national address readback", () => {
    const stop = extractOperationalStopSnapshot({
      metadata: {
        title: "Deliver: MX Short Address",
        address: {
          district: "Al Yasmin",
          city: "Riyadh",
          short_national_address: "RYAD7334",
        },
      },
    });

    expect(stop.place).toBe("Al Yasmin - Riyadh - RYAD7334");
    expect(stop.addressSummary).toBe("Al Yasmin - Riyadh - RYAD7334");
    expect(stop.fullAddress).toBe("Al Yasmin, Riyadh, RYAD7334");
    expect(stop.addressMissing).toBe(false);
  });

  test.each(["short_address","shortAddress","address_short","sa_short_code","short_national_address","shortNationalAddress","national_short_address","nationalShortAddress","short_code","shortCode"])("reads and trims Saudi address alias %s in both projections", (key) => {
    const detail = { metadata: { address: { [key]: "  RYAD7334  " } } };
    const stop = extractOperationalStopSnapshot(detail);
    expect(stop.place).toBe("RYAD7334");
    expect(stop.addressSummary).toBe("RYAD7334");
    expect(stop.fullAddress).toBe("RYAD7334");
    expect(stop.addressMissing).toBe(false);
    expect(extractAddressFields(detail, {
      fields: [{ key: "address", label: "Address", required: true }],
      showCoordinates: true, showAccuracy: true,
    })[0].value).toBe("RYAD7334");
    const blank = { address: { [key]: "  " } };
    expect(extractOperationalStopSnapshot(blank).addressMissing).toBe(true);
    expect(extractAddressFields(blank, {
      fields: [{ key: "address", label: "Address", required: true }],
      showCoordinates: true, showAccuracy: true,
    })[0]).toMatchObject({ value: "-", missing: true });
  });

  test("Saudi alias order preserves first nonblank normalized match", () => {
    for (const address of [
      { short_code: "LAST", sa_short_code: "SECOND", short_address: "FIRST" },
      { short_address: " ", sa_short_code: "FIRST", short_code: "LAST" },
    ]) {
      const detail = { address };
      expect(extractOperationalStopSnapshot(detail).fullAddress).toBe("FIRST");
      expect(extractAddressFields(detail, {
        fields: [{ key: "address", label: "Address", required: true }],
        showCoordinates: true, showAccuracy: true,
      })[0].value).toBe("FIRST");
    }
  });

  test("selected route payment shape keeps its decimal COD", () => {
    expect(extractRouteCardSnapshot({ route_stop: { payment: {
      expected_amount: "175.5", currency: "SAR",
    } } }).codBadge).toBe("SAR 175.5 COD");
  });

  test("selected task metadata payment shape keeps its decimal COD", () => {
    expect(extractTaskCardSnapshot({ metadata: { payment: {
      amount_due: 99.75, currency_code: "SAR",
    } } }).codBadge).toBe("SAR 99.75 COD");
  });

  describe.each([
    ["route", extractRouteCardSnapshot],
    ["task", extractTaskCardSnapshot],
  ] as const)("%s card COD money", (_kind, extractCard) => {
    test.each([175.5, "175.5", 99.75, "99.75"])("preserves decimal amount %p", (amount) => {
      expect(extractCard({ cod_amount: amount, currency: "SAR" }).codBadge)
        .toBe("SAR " + Number(amount) + " COD");
    });

    test.each([
      [0, "SAR", "SAR 0 COD"],
      ["0", "SAR", "SAR 0 COD"],
      [100, "USD", "USD 100 COD"],
      ["100", "USD", "USD 100 COD"],
      [12.5, null, "SAR 12.5 COD"],
      [12.5, undefined, "SAR 12.5 COD"],
      [null, "SAR", null],
      [undefined, "SAR", null],
      [Number.NaN, "SAR", null],
      [Number.POSITIVE_INFINITY, "SAR", null],
      [Number.NEGATIVE_INFINITY, "SAR", null],
      ["Infinity", "SAR", null],
    ])("retains amount/currency boundary %#", (amount, currency, expected) => {
      expect(extractCard({ cod_amount: amount, currency }).codBadge).toBe(expected);
    });

    test.each([175.5, "99.75", 0])("canonical payment beats legacy COD: %s", (amount) => {
      const detail = { cod_amount: 999, currency: "USD",
        metadata: { route_stop: { delivery_completion: { payment_collection: {
          expected_amount: amount, currency: "SAR",
        } } } } };
      expect(extractCard(detail).codBadge).toBe("SAR " + Number(amount) + " COD");
      expect(extractOperationalStopSnapshot(detail).codAmount).toBe(Number(amount));
    });
  });

  test.each([
    [175.5, "SAR", "SAR 175.5"],
    [99.75, "SAR", "SAR 99.75"],
    [1.234, "USD", "USD 1.23"],
    [0, null, "SAR 0"],
    [12, undefined, "SAR 12"],
    [null, "SAR", null],
    [Number.NaN, "SAR", null],
    [Number.POSITIVE_INFINITY, "SAR", null],
    [Number.NEGATIVE_INFINITY, "SAR", null],
  ])("shared formatter preserves existing detail money behavior %#", (amount, currency, expected) => {
    expect(formatMoneyLabel(amount as number | null, currency as string | null | undefined)).toBe(expected);
  });

  test("App consumes the shared formatter without a local duplicate", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
    const sharedImport = app.match(/import \{([^}]+)\} from "\.\/src\/mobile-shell-surface-helpers";/)?.[1];
    expect(sharedImport).toMatch(/\bformatMoneyLabel\b/);
    expect(app).not.toMatch(/function formatMoneyLabel\(/);
    expect(app).toContain("formatMoneyLabel(stop.expectedAmount ?? stop.codAmount, stop.currency)");
    expect(app).toContain("formatMoneyLabel(stop.collectedAmount, stop.currency)");
    expect(app).toContain("formatMoneyLabel(stop.varianceAmount, stop.currency)");
  });

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

  test.each([
    [{ window_start_at: "2026-09-01T00:00:00Z", window_end_at: "2026-09-02T00:00:00Z" }, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"],
    [{ window_start_at: "2026-09-01T00:00:00Z" }, "2026-09-01T00:00:00Z", null],
    [{ window_end_at: "2026-09-02T00:00:00Z" }, null, "2026-09-02T00:00:00Z"],
    [{ window_start_at: " ", window_end_at: 123, metadata: { window_start_at: "ignored" } }, null, null],
    [{}, null, null],
  ])("settlement window uses canonical fields without fabricating endpoints %j", (detail, start, end) => {
    const snapshot = extractSettlementSnapshot(detail, "settlement-a");
    expect(snapshot.windowStartAt).toBe(start);
    expect(snapshot.windowEndAt).toBe(end);
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
      windowStartAt: null,
      windowEndAt: null,
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

  test("extractOperationalStopSnapshot reads canonical delivery payment collection", () => {
    const stop = extractOperationalStopSnapshot({
      metadata: {
        route_stop: {
          delivery_completion: {
            payment_collection: {
              outcome: "collected",
              method: "card",
              expected_amount: 150,
              collected_amount: 145,
              variance_amount: 5,
              discrepancy_kind: "shortfall",
              has_discrepancy: true,
              currency: "SAR",
              receipt_context: "card-slip-8811",
              proof_artifact_count: 2,
              signature_artifact_id: "00000000-0000-0000-0000-000000000123",
              proof_artifact_ids: [
                "00000000-0000-0000-0000-000000000123",
                "00000000-0000-0000-0000-000000000124",
              ],
              allowed_methods: ["cash", "card"],
            },
          },
        },
      },
    });

    expect(stop.expectedAmount).toBe(150);
    expect(stop.codAmount).toBe(150);
    expect(stop.collectedAmount).toBe(145);
    expect(stop.varianceAmount).toBe(5);
    expect(stop.collectionRequired).toBe(true);
    expect(stop.collectionOutcome).toBe("collected");
    expect(stop.paymentModeLabel).toBe("card");
    expect(stop.discrepancyKind).toBe("shortfall");
    expect(stop.hasDiscrepancy).toBe(true);
    expect(stop.currency).toBe("SAR");
    expect(stop.receiptContext).toBe("card-slip-8811");
    expect(stop.proofArtifactCount).toBe(2);
    expect(stop.signatureArtifactId).toBe("00000000-0000-0000-0000-000000000123");
    expect(stop.proofArtifactIds).toEqual([
      "00000000-0000-0000-0000-000000000123",
      "00000000-0000-0000-0000-000000000124",
    ]);
    expect(stop.allowedMethods).toEqual(["cash", "card"]);
  });

  test("extractOperationalStopSnapshot reads canonical shipment action projections", () => {
    const stop = extractOperationalStopSnapshot({
      shipment_action: {
        payment_collection_outcome: "collected",
        payment_collection_method: "cash",
        payment_expected_amount: "90",
        payment_collected_amount: "90",
        payment_variance_amount: "0",
        payment_discrepancy_kind: null,
        payment_has_discrepancy: false,
        payment_currency: "SAR",
        payment_receipt_context: "cash-count-44",
      },
    });

    expect(stop.expectedAmount).toBe(90);
    expect(stop.collectedAmount).toBe(90);
    expect(stop.varianceAmount).toBe(0);
    expect(stop.collectionOutcome).toBe("collected");
    expect(stop.paymentModeLabel).toBe("cash");
    expect(stop.hasDiscrepancy).toBe(false);
    expect(stop.currency).toBe("SAR");
    expect(stop.receiptContext).toBe("cash-count-44");
  });

  test.each(["metadata", "payload"])(
    "extractOperationalStopSnapshot reads %s.payment_collection with canonical outputs",
    (envelope) => {
      const stop = extractOperationalStopSnapshot({
        [envelope]: {
          payment_collection: {
            expected_amount: "150",
            collected_amount: "145",
            outcome: "collected",
            method: "card",
            receipt_context: "synthetic-receipt",
            variance_amount: "5",
            discrepancy_kind: "shortfall",
            has_discrepancy: true,
          },
        },
      });

      expect(stop).toMatchObject({
        expectedAmount: 150,
        codAmount: 150,
        collectedAmount: 145,
        collectionOutcome: "collected",
        paymentModeLabel: "card",
        receiptContext: "synthetic-receipt",
        varianceAmount: 5,
        discrepancyKind: "shortfall",
        hasDiscrepancy: true,
      });
      expect(stop).not.toHaveProperty("outstandingAmount");
      expect(stop).not.toHaveProperty("discrepancyState");
    }
  );

  test("existing delivery collection wins over envelope fallbacks, including zero and false", () => {
    const stop = extractOperationalStopSnapshot({
      payment_expected_amount: 150,
      payment_collected_amount: 145,
      route_stop: {
        delivery_completion: {
          payment_collection: {
            expected_amount: 0,
            collected_amount: 0,
            variance_amount: 0,
            has_discrepancy: false,
            outcome: "not_required",
            method: "cash",
            receipt_context: "canonical-receipt",
          },
        },
      },
      metadata: {
        payment_collection: {
          expected_amount: 150,
          collected_amount: 145,
          variance_amount: 5,
          has_discrepancy: true,
          outcome: "collected",
          method: "card",
          receipt_context: "fallback-receipt",
        },
      },
    });

    expect(stop).toMatchObject({
      expectedAmount: 0,
      collectedAmount: 0,
      varianceAmount: 0,
      hasDiscrepancy: false,
      collectionRequired: false,
      collectionOutcome: "not_required",
      paymentModeLabel: "cash",
      receiptContext: "canonical-receipt",
    });
  });

  test.each(["detail", "shipment_action"])(
    "existing %s payment projection wins over conflicting envelope fallbacks",
    (location) => {
      const projection = {
        payment_expected_amount: 0,
        payment_collected_amount: 0,
        payment_variance_amount: 0,
        payment_currency: "USD",
        payment_collection_outcome: "not_required",
        payment_collection_method: "cash",
        payment_discrepancy_kind: "none",
        payment_has_discrepancy: false,
        payment_receipt_context: "projection-receipt",
      };
      const fallback = {
        expected_amount: 150,
        collected_amount: 145,
        variance_amount: 5,
        currency: "SAR",
        outcome: "collected",
        method: "card",
        discrepancy_kind: "shortfall",
        has_discrepancy: true,
        receipt_context: "fallback-receipt",
        proof_artifact_ids: ["fallback-proof"],
        signature_artifact_id: "fallback-signature",
        allowed_methods: ["cash", "card"],
      };
      const stop = extractOperationalStopSnapshot({
        ...(location === "detail" ? projection : { shipment_action: projection }),
        metadata: { payment_collection: fallback },
        payload: { payment_collection: fallback },
      });

      expect(stop).toMatchObject({
        codAmount: 0,
        expectedAmount: 0,
        collectedAmount: 0,
        varianceAmount: 0,
        currency: "USD",
        collectionOutcome: "not_required",
        paymentModeLabel: "cash",
        discrepancyKind: "none",
        hasDiscrepancy: false,
        receiptContext: "projection-receipt",
        proofArtifactIds: ["fallback-proof"],
        proofArtifactCount: 1,
        signatureArtifactId: "fallback-signature",
        allowedMethods: ["cash", "card"],
      });
    }
  );

  test("existing generic COD display fields win over new envelope fallbacks", () => {
    const stop = extractOperationalStopSnapshot({
      cod_amount: 50,
      currency_code: "USD",
      payment_mode_label: "Cash only",
      allowed_methods: ["cash"],
      metadata: {
        payment_collection: {
          expected_amount: 150,
          currency: "SAR",
          method: "card",
          allowed_methods: ["card"],
        },
      },
    });

    expect(stop).toMatchObject({
      codAmount: 50,
      expectedAmount: 50,
      currency: "USD",
      paymentModeLabel: "Cash only",
      allowedMethods: ["cash"],
    });
  });

  test("payment envelope fallback prefers metadata and does not project unrelated stop fields", () => {
    const stop = extractOperationalStopSnapshot({
      metadata: {
        payment_collection: {
          collected_amount: 145,
          title: "Not a stop title",
          status: "Not a stop status",
          outstanding_amount: 5,
          discrepancy_state: "shortfall",
        },
      },
      payload: { payment_collection: { collected_amount: 200, receipt_context: "payload-receipt" } },
    });

    expect(stop).toMatchObject({
      collectedAmount: 145,
      receiptContext: "payload-receipt",
      title: "Task",
      status: "open",
      expectedAmount: null,
      varianceAmount: null,
      discrepancyKind: null,
      hasDiscrepancy: null,
    });
  });

  test.each([undefined, null, [], "not-a-record"])(
    "malformed or absent payment envelopes remain neutral (%p)",
    (paymentCollection) => {
      const stop = extractOperationalStopSnapshot({
        metadata: { payment_collection: paymentCollection },
        payload: { payment_collection: paymentCollection },
      });

      expect(stop).toMatchObject({
        expectedAmount: null,
        collectedAmount: null,
        collectionOutcome: null,
        paymentModeLabel: null,
        receiptContext: null,
        varianceAmount: null,
        discrepancyKind: null,
        hasDiscrepancy: null,
      });
    }
  );

  test("extractOperationalStopSnapshot ignores unrelated generic outcome and method fields", () => {
    const stop = extractOperationalStopSnapshot({
      outcome: "delivery_complete",
      method: "manual_override",
      proof_artifact_count: 3,
      signature_artifact_id: "generic-signature",
      proof_artifact_ids: ["generic-proof"],
    });

    expect(stop.collectionOutcome).toBeNull();
    expect(stop.paymentModeLabel).toBeNull();
    expect(stop.proofArtifactCount).toBeNull();
    expect(stop.signatureArtifactId).toBeNull();
    expect(stop.proofArtifactIds).toEqual([]);
  });

  describe.each(["direct", "metadata", "payload", "nested"])(
    "explicit payment collection aliases (%s)",
    (location) => {
      test.each([
        { key: "cash_collected", value: 145, output: "collectedAmount" },
        { key: "amount_collected", value: 145, output: "collectedAmount" },
        { key: "receipt_number", value: "synthetic-receipt", output: "receiptContext" },
        { key: "payment_method", value: "card", output: "paymentModeLabel" },
        { key: "allowed_payment_methods", value: ["cash", "card"], output: "allowedMethods" },
      ])("restores $key as $output", ({ key, value, output }) => {
        const paymentCollection = { [key]: value };
        const detail = location === "direct"
          ? { payment_collection: paymentCollection }
          : location === "nested"
            ? { route_stop: { delivery_completion: { payment_collection: paymentCollection } } }
            : { [location]: { payment_collection: paymentCollection } };

        expect(extractOperationalStopSnapshot(detail)).toMatchObject({ [output]: value });
      });
    }
  );

  test.each(["nested", "projection", "envelope"])(
    "supported canonical %s values win over conflicting legacy payment aliases",
    (location) => {
      const canonical = {
        collected_amount: 0,
        receipt_context: "canonical-receipt",
        payment_mode_label: "Cash only",
        allowed_methods: ["cash"],
        variance_amount: 0,
        has_discrepancy: false,
      };
      const detail = {
        payment_collection: {
          cash_collected: 145,
          amount_collected: 200,
          receipt_number: "legacy-receipt",
          payment_method: "card",
          allowed_payment_methods: ["card"],
        },
        ...(location === "nested"
          ? { route_stop: { delivery_completion: { payment_collection: canonical } } }
          : location === "envelope"
            ? { metadata: { payment_collection: canonical } }
            : {
                shipment_action: {
                  payment_collected_amount: 0,
                  payment_receipt_context: "canonical-receipt",
                  payment_collection_method: "Cash only",
                  payment_variance_amount: 0,
                  payment_has_discrepancy: false,
                },
                allowed_methods: ["cash"],
              }),
      };

      expect(extractOperationalStopSnapshot(detail)).toMatchObject({
        collectedAmount: 0,
        receiptContext: "canonical-receipt",
        paymentModeLabel: "Cash only",
        allowedMethods: ["cash"],
        varianceAmount: 0,
        hasDiscrepancy: false,
      });
    }
  );

  test("legacy aliases retain zero and explicit-record order without inventing discrepancies", () => {
    const stop = extractOperationalStopSnapshot({
      payment_collection: {
        cash_collected: "0",
        amount_collected: 145,
        receipt_number: "direct-receipt",
        payment_method: "cash",
        allowed_payment_methods: ["cash"],
        title: "Not a stop title",
        status: "Not a stop status",
      },
      metadata: {
        payment_collection: {
          cash_collected: 200,
          receipt_number: "metadata-receipt",
          payment_method: "card",
          allowed_payment_methods: ["card"],
        },
      },
    });

    expect(stop).toMatchObject({
      collectedAmount: 0,
      receiptContext: "direct-receipt",
      paymentModeLabel: "cash",
      allowedMethods: ["cash"],
      title: "Task",
      status: "open",
      varianceAmount: null,
      discrepancyKind: null,
      hasDiscrepancy: null,
    });
    expect(stop).not.toHaveProperty("outstandingAmount");
    expect(stop).not.toHaveProperty("discrepancyState");
  });

  test("unusable alias values fall through using the existing value parsers", () => {
    const stop = extractOperationalStopSnapshot({
      payment_collection: {
        cash_collected: "not-a-number",
        amount_collected: "145",
        receipt_number: " ",
        payment_method: null,
        allowed_payment_methods: [],
      },
      payload: {
        payment_collection: {
          receipt_number: "payload-receipt",
          payment_method: "card",
          allowed_payment_methods: ["card"],
        },
      },
    });

    expect(stop).toMatchObject({
      collectedAmount: 145,
      receiptContext: "payload-receipt",
      paymentModeLabel: "card",
      allowedMethods: ["card"],
    });
  });

  test.each(["detail", "metadata", "payload"])(
    "legacy payment aliases outside explicit collection records are ignored (%s)",
    (location) => {
      const unrelated = {
        cash_collected: 145,
        amount_collected: 200,
        receipt_number: "unrelated-receipt",
        payment_method: "card",
        allowed_payment_methods: ["card"],
      };
      const stop = extractOperationalStopSnapshot(
        location === "detail" ? unrelated : { [location]: unrelated }
      );

      expect(stop).toMatchObject({
        collectedAmount: null,
        receiptContext: null,
        paymentModeLabel: null,
        allowedMethods: [],
      });
    }
  );

  test("extractSettlementSnapshot reads canonical COD payment collection summary", () => {
    const settlement = extractSettlementSnapshot(
      {
        settlement: {
          settlement_id: "stl-cod-1",
          payment_collection_summary: {
            expected_amount: 220,
            collected_amount: 200,
            variance_amount: 20,
            currency: "SAR",
          },
        },
      },
      "fallback"
    );

    expect(settlement).toEqual({
      id: "stl-cod-1",
      title: "Settlement stl-cod-1",
      status: "open",
      currency: "SAR",
      expected: 220,
      counted: 200,
      variance: -20,
      windowStartAt: null,
      windowEndAt: null,
    });
  });

  test("extractSettlementSnapshot derives UI variance from canonical COD summary amounts", () => {
    const settlement = extractSettlementSnapshot(
      {
        settlement: {
          payment_collection_summary: {
            expected_amount: 120,
            collected_amount: 125,
            variance_amount: -5,
            currency: "SAR",
          },
        },
      },
      "fallback"
    );

    expect(settlement.expected).toBe(120);
    expect(settlement.counted).toBe(125);
    expect(settlement.variance).toBe(5);
  });

  test("extractSettlementSnapshot reads total_collected without changing variance direction", () => {
    const settlement = extractSettlementSnapshot(
      { settlement: { expected_amount: 220, total_collected: "200" } },
      "synthetic"
    );

    expect(settlement).toMatchObject({ expected: 220, counted: 200, variance: -20 });
  });

  test("settlement counted fields and canonical payment summaries win over total_collected", () => {
    expect(
      extractSettlementSnapshot(
        { settlement: { expected_amount: 220, counted_amount: 0, total_collected: 200 } },
        "synthetic"
      )
    ).toMatchObject({ counted: 0, variance: -220 });
    expect(
      extractSettlementSnapshot(
        {
          settlement: {
            expected_amount: 220,
            total_collected: 200,
            payment_collection_summary: { expected_amount: 120, collected_amount: 125 },
          },
        },
        "synthetic"
      )
    ).toMatchObject({ expected: 120, counted: 125, variance: 5 });
    expect(extractSettlementSnapshot({}, "synthetic")).toMatchObject({
      expected: null,
      counted: null,
      variance: null,
    });
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

  test("route context never promotes driver settlement data to route ownership", () => {
    const context = extractScanContext({
      id: "route-stop-a",
      route_run_id: "route-a",
      route_stop_id: "route-stop-a",
      settlement_id: "latest-driver-settlement",
      driver_shift_id: "shift-a",
      window_start_at: "2026-09-14T08:00:00Z",
      window_end_at: "2026-09-14T18:00:00Z",
    });

    expect(context.routeRunId).toBe("route-a");
    expect(context.routeStopId).toBe("route-stop-a");
    expect(context).not.toHaveProperty("settlementId");
    expect(context).not.toHaveProperty("driverShiftId");
    expect(context).not.toHaveProperty("windowStartAt");
    expect(context).not.toHaveProperty("windowEndAt");
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
      collectionOutcome: null,
      collectedAmount: null,
      varianceAmount: null,
      discrepancyKind: null,
      hasDiscrepancy: null,
      receiptContext: null,
      proofArtifactCount: null,
      signatureArtifactId: null,
      proofArtifactIds: [],
      paymentModeLabel: null,
      allowedMethods: [],
      recipientMissing: false,
      phoneMissing: false,
      addressMissing: false,
    });
  });

  test("pickup snapshots preserve canonical identity and displayed operational fields together", () => {
    const row = {
      id: "pickup-task", resource_type: "route_stop", resource_id: "pickup-stop",
      status: "in_progress", status_reason: "arrived", priority: 80,
      metadata: {
        route_run_id: "pickup-route", route_stop_id: "pickup-stop", shipment_id: "pickup-shipment",
        client_id: "pickup-client", ref: "pickup-reference", package_count: 4,
        notes: "Collect at the staffed loading door.",
        route_stop: { id: "pickup-stop", route_run_id: "pickup-route", stop_kind: "pickup" },
        customer: { name: "Pickup sender", phone_number: "+12025550123" },
        address: { district: "Al Olaya", city: "Riyadh", short_address: "RNQA7082" },
      },
    };
    const before = JSON.stringify(row);
    expect(extractScanContext(row)).toMatchObject({
      taskId: "pickup-task", routeStopId: "pickup-stop", routeRunId: "pickup-route",
      shipmentId: "pickup-shipment", clientId: "pickup-client", reference: "pickup-reference",
    });
    const stop = extractOperationalStopSnapshot(row);
    expect(stop).toMatchObject({
      kind: "pickup", status: "in_progress", statusReason: "arrived", priority: "P80",
      customerName: "Pickup sender", reference: "pickup-reference",
      addressSummary: "Al Olaya - Riyadh - RNQA7082",
      notes: "Collect at the staffed loading door.", packageCount: 4,
    });
    expect(extractRouteCardSnapshot(row)).toMatchObject({
      kind: stop.kind, customerName: stop.customerName, reference: stop.reference,
      place: stop.place, status: stop.status, statusReason: stop.statusReason, packageCount: stop.packageCount,
    });
    expect(extractTaskCardSnapshot(row)).toMatchObject({
      customerName: stop.customerName, reference: stop.reference, priority: stop.priority, packageCount: stop.packageCount,
    });
    expect(JSON.stringify(row)).toBe(before);
  });

  test("absent or malformed pickup data never invents identity or parcel counts from priority", () => {
    for (const input of [undefined, null, false, 7, "pickup", [], {}, { metadata: null },
      { metadata: { priority: 88 } }]) {
      expect(extractScanContext(input)).toMatchObject({
        taskId: null, routeRunId: null, routeStopId: null, shipmentId: null,
      });
      expect(extractOperationalStopSnapshot(input)).toMatchObject({
        kind: null, reference: null, customerName: null, addressSummary: null, notes: null, packageCount: null,
      });
      expect(extractRouteCardSnapshot(input).packageCount).toBeNull();
      expect(extractTaskCardSnapshot(input).packageCount).toBeNull();
    }
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

describe("fieldops live projections", () => {
  const registry = { resources: [
    { key: "routes" }, { key: "route_stops" }, { key: "tasks" }, { key: "baskets" },
    { key: "basket_items" }, { key: "return_to_branch_shipments" },
  ] };

  test.each([
    ["driver", "rider"], ["warehouse_operator", "loader"], ["fleet_manager", "supervisor"],
    ["rider", "rider"], ["loader", "loader"], ["supervisor", "supervisor"],
  ])("maps canonical and compatibility role %s to %s", (role, expected) => {
    expect(selectFieldOpsLiveSources(role, registry).roleKey).toBe(expected);
  });

  test("keeps each role source plan disjoint and server-filtered", () => {
    const rider = selectFieldOpsLiveSources("driver", registry);
    expect(rider.rpcQueries).toEqual([]);
    expect(rider.resourceQueries).toEqual([
      { id: "routes", resource: "routes", filters: {} },
      { id: "routeStops", resource: "route_stops", filters: { stop_kind: "pickup" } },
    ]);

    const loader = selectFieldOpsLiveSources("warehouse_operator", registry);
    expect(loader.rpcQueries).toEqual([]);
    expect(loader.resourceQueries).toContainEqual({
      id: "warehouseSortTasks", resource: "tasks", filters: { task_type_key: "warehouse_sort" },
    });
    expect(loader.resourceQueries.map((query) => query.resource)).not.toContain("routes");

    const supervisor = selectFieldOpsLiveSources("fleet_manager", registry);
    expect(supervisor.rpcQueries).toEqual([{ id: "pickupFailures", rpc: "pickup_failures_list_v1" }]);
    expect(supervisor.resourceQueries).toEqual([
      { id: "warehouseSupervisorTasks", resource: "tasks", filters: { task_type_key: "warehouse_supervisor_approval" } },
      { id: "warehouseScanSupervisorTasks", resource: "tasks", filters: { task_type_key: "warehouse_scan_supervisor_approval" } },
      { id: "dispatchExceptionTasks", resource: "tasks", filters: { task_type_key: "dispatch_exception_review" } },
    ]);
  });

  test("projects pickup and trip fields without treating planned end as ETA", () => {
    const snapshot = projectFieldOpsLiveOperations({
      routeStops: fieldOpsLiveSourceResult([{ route_stop_id: "pickup-stop-1", stop_kind: "pickup",
        planned_window_start_at: "2026-09-13T08:00:00Z",
        planned_window_end_at: "2026-09-13T09:00:00Z", box_count: 4 }], { complete: false }),
      routes: fieldOpsLiveSourceResult([{ route_run_id: "trip-1", status: "started",
        planned_start_at: "2026-09-13T08:00:00Z", planned_end_at: "2026-09-13T09:00:00Z",
        driver_user_id: "driver-1", vehicle_id: "vehicle-1", stop_count: 2,
        route_execution_manifest: { manifest_hash: "hash-1" } }], { complete: false }),
    });
    expect(snapshot.pickup).toMatchObject({ state: "ready", id: "pickup-stop-1",
      windowStartAt: "2026-09-13T08:00:00Z", windowEndAt: "2026-09-13T09:00:00Z",
      expectedCount: 4, pickedCount: null, seal: null, failureCount: null });
    expect(snapshot.trip).toMatchObject({ id: "trip-1", stage: "started", eta: null,
      plannedEndAt: "2026-09-13T09:00:00Z",
      driverId: "driver-1", vehicleId: "vehicle-1", count: 2, seal: null });
  });

  test("does not compose a pickup or trip from different visible records", () => {
    const snapshot = projectFieldOpsLiveOperations({
      routeStops: fieldOpsLiveSourceResult([
        { id: "pickup-a", shipment_id: "shipment-a", planned_window_start_at: "08:00" },
        { id: "pickup-b", shipment_id: "shipment-b", planned_window_end_at: "10:00" },
      ]),
      routes: fieldOpsLiveSourceResult([
        { id: "trip-a", origin: "Branch A" },
        { id: "trip-b", destination: "Branch B", eta_at: "11:00" },
      ]),
      pickupFailures: fieldOpsLiveSourceResult([{ shipment_id: "shipment-b" }], { complete: true }),
    });
    expect(snapshot.pickup).toMatchObject({
      id: "pickup-a", windowStartAt: "08:00", windowEndAt: null, failureCount: 0,
    });
    expect(snapshot.trip).toMatchObject({
      id: "trip-a", origin: "Branch A", destination: null, eta: null,
    });
  });

  test("counts only complete same-shipment pickup failures", () => {
    const routeStops = fieldOpsLiveSourceResult([{ id: "pickup-a", shipment_id: "shipment-a" }]);
    const failures = [{ shipment_id: "shipment-a" }, { shipment_id: "shipment-b" }];
    expect(projectFieldOpsLiveOperations({
      routeStops, pickupFailures: fieldOpsLiveSourceResult(failures, { complete: false }),
    }).pickup.failureCount).toBeNull();
    expect(projectFieldOpsLiveOperations({
      routeStops, pickupFailures: fieldOpsLiveSourceResult(failures, { complete: true }),
    }).pickup.failureCount).toBe(1);
    expect(projectFieldOpsLiveOperations({
      pickupFailures: fieldOpsLiveSourceResult(failures, { complete: true }),
    }).pickup.failureCount).toBeNull();
  });

  test("does not relabel basket membership or task-row values as sortation metrics", () => {
    const noMetrics = projectFieldOpsLiveOperations({
      baskets: fieldOpsLiveSourceResult([{ current_count: 3 }]),
      basketItems: fieldOpsLiveSourceResult([
        { added_at: "2020-01-01T08:00:00Z", removed_at: "2020-01-02T08:00:00Z" },
        { added_at: "2026-09-13T08:10:00Z", removed_at: null },
      ]),
    });
    expect(noMetrics.sortation).toEqual({ state: "ready", bays: null, recent: null,
      inducted: null, throughput: null, minutes: null });
    const explicit = projectFieldOpsLiveOperations({
      warehouseSortTasks: fieldOpsLiveSourceResult([
        { id: "sort-task", throughput_per_minute: 8, elapsed_minutes: 12 },
      ]),
    });
    expect(explicit.sortation).toMatchObject({ throughput: null, minutes: null });
  });

  test("keeps absent, empty, error, and incomplete values neutral", () => {
    expect(projectFieldOpsLiveOperations({}).state).toBe("absent");
    expect(projectFieldOpsLiveOperations({ routes: fieldOpsLiveSourceResult([]) }).state).toBe("empty");
    expect(projectFieldOpsLiveOperations({ routes: fieldOpsLiveSourceResult(null, { error: true }) }).state).toBe("error");
    expect(projectFieldOpsLiveOperations({
      baskets: fieldOpsLiveSourceResult([{ current_count: 5 }], { complete: false }),
      basketItems: fieldOpsLiveSourceResult([{ added_at: "2026-09-13T08:00:00Z" }], { complete: false }),
    }).sortation).toMatchObject({ bays: null, recent: null, inducted: null, throughput: null, minutes: null });
  });

  test("surfaces returned visible loader and supervisor work without claiming a total", () => {
    expect(projectFieldOpsLiveOperations({
      warehouseSortTasks: fieldOpsLiveSourceResult([{ id: "sort-1" }, { id: "sort-2" }], { complete: false }),
    }).work).toEqual({ state: "ready", visibleCount: 2 });
    expect(projectFieldOpsLiveOperations({
      warehouseSupervisorTasks: fieldOpsLiveSourceResult([{ id: "approval-1" }], { complete: false }),
      dispatchExceptionTasks: fieldOpsLiveSourceResult([], { complete: true }),
    }).work).toEqual({ state: "ready", visibleCount: 1 });
    expect(projectFieldOpsLiveOperations({}).work).toEqual({ state: "absent", visibleCount: null });
  });

  test("App uses exact existing RPC arguments and filtered registry reads", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const app = fs.readFileSync(path.resolve(__dirname, "../../../apps/fieldops/App.tsx"), "utf8");
    expect(app).toContain('client.rpc(query.rpc, args)');
    expect(app).not.toContain('pickup_requests_list_v1');
    expect(app).not.toContain('pickup_waves_list_v1');
    expect(app).toContain('p_shipment_ids: null');
    expect(app).toContain('uiClient.listResource(query.resource, query.filters, 50, 0, null)');
    expect(app).toContain('No visible live records in this scope.');
    expect(app).toContain('Live sources are not available for this scope.');
    expect(app).toContain('One or more scoped sources failed.');
    expect(app).toContain('stableStringify(me?.access_scope ?? null)');
    expect(app).toContain('Array.isArray(data) && data.length < 50');
    expect(app).toContain('Boolean(liveRegistryQuery.data)');
    expect(app).toContain('returned visible items:');
  });
});
