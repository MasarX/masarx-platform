import {
  requestAccessPolicyChangeWithCompat,
  requestSettingsChangeWithCompat,
} from "../../packages/api/src/settings-change-compat";

test("requestSettingsChangeWithCompat falls back to change-reason signature on schema cache mismatch", async () => {
  const rpc = jest
    .fn()
    .mockRejectedValueOnce({
      code: "PGRST202",
      message:
        "Could not find the function api.request_settings_change_v1(p_category, p_change_reason, p_effective_from, p_scope_id, p_scope_type, p_value) in the schema cache",
    })
    .mockResolvedValueOnce({
      settings_version_id: "sv_1",
      domain_event_id: "de_1",
    });

  const result = await requestSettingsChangeWithCompat(rpc, {
    category: "ui_table_views",
    scopeType: "client",
    scopeId: "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
    value: { views: {} },
    changeReason: "save view",
    effectiveFrom: "2026-02-06T00:00:00.000Z",
  });

  expect(result).toEqual({
    settings_version_id: "sv_1",
    domain_event_id: "de_1",
  });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenNthCalledWith(1, "request_settings_change_v1", {
    p_category: "ui_table_views",
    p_scope_type: "client",
    p_scope_id: "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
    p_value: { views: {} },
    p_change_reason: "save view",
    p_effective_from: "2026-02-06T00:00:00.000Z",
  });
  expect(rpc).toHaveBeenNthCalledWith(2, "request_settings_change_v1", {
    p_category: "ui_table_views",
    p_scope_type: "client",
    p_scope_id: "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
    p_value: { views: {} },
    p_change_reason: "save view",
  });
});

test("requestSettingsChangeWithCompat falls through to legacy args when needed", async () => {
  const rpc = jest
    .fn()
    .mockRejectedValueOnce({
      code: "PGRST202",
      message:
        "Could not find the function api.request_settings_change_v1(p_category, p_change_reason, p_effective_from, p_scope_id, p_scope_type, p_value) in the schema cache",
    })
    .mockRejectedValueOnce({
      code: "PGRST202",
      message:
        "Could not find the function api.request_settings_change_v1(p_category, p_change_reason, p_scope_id, p_scope_type, p_value) in the schema cache",
    })
    .mockResolvedValueOnce({
      settings_version_id: "sv_legacy_1",
      domain_event_id: "de_legacy_1",
    });

  const result = await requestSettingsChangeWithCompat(rpc, {
    category: "ui_table_views",
    scopeType: "global",
    scopeId: null,
    value: { views: {} },
    changeReason: "save view",
    effectiveFrom: null,
  });

  expect(result).toEqual({
    settings_version_id: "sv_legacy_1",
    domain_event_id: "de_legacy_1",
  });
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(rpc).toHaveBeenNthCalledWith(3, "request_settings_change_v1", {
    p_category: "ui_table_views",
    p_scope_type: "global",
    p_scope_id: null,
    p_value: { views: {} },
  });
});

test("requestAccessPolicyChangeWithCompat falls back to change-reason signature on schema cache mismatch", async () => {
  const rpc = jest
    .fn()
    .mockRejectedValueOnce({
      code: "PGRST202",
      message:
        "Could not find the function api.ui_request_access_policy_change_v1(p_change_reason, p_effective_from, p_scope_id, p_scope_type, p_value) in the schema cache",
    })
    .mockResolvedValueOnce({
      settings_version_id: "sv_2",
      domain_event_id: "de_2",
    });

  const result = await requestAccessPolicyChangeWithCompat(rpc, {
    scopeType: "tenant",
    scopeId: null,
    value: { grants: [] },
    changeReason: "update policy",
    effectiveFrom: null,
  });

  expect(result).toEqual({
    settings_version_id: "sv_2",
    domain_event_id: "de_2",
  });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc).toHaveBeenNthCalledWith(1, "ui_request_access_policy_change_v1", {
    p_scope_type: "tenant",
    p_scope_id: null,
    p_value: { grants: [] },
    p_change_reason: "update policy",
    p_effective_from: null,
  });
  expect(rpc).toHaveBeenNthCalledWith(2, "ui_request_access_policy_change_v1", {
    p_scope_type: "tenant",
    p_scope_id: null,
    p_value: { grants: [] },
    p_change_reason: "update policy",
  });
});

test("requestSettingsChangeWithCompat falls back when schema cache reports legacy signature", async () => {
  const rpc = jest
    .fn()
    .mockRejectedValueOnce({
      code: "PGRST202",
      message:
        "Could not find the function api.request_settings_change_v1(p_category, p_scope_type, p_scope_id, p_value) in the schema cache",
    })
    .mockRejectedValueOnce({
      code: "PGRST202",
      message:
        "Could not find the function api.request_settings_change_v1(p_category, p_change_reason, p_scope_id, p_scope_type, p_value) in the schema cache",
    })
    .mockResolvedValueOnce({
      settings_version_id: "sv_legacy",
      domain_event_id: "de_legacy",
    });

  const result = await requestSettingsChangeWithCompat(rpc, {
    category: "ui_table_views",
    scopeType: "global",
    scopeId: null,
    value: { views: {} },
    changeReason: "save view",
    effectiveFrom: null,
  });

  expect(result).toEqual({
    settings_version_id: "sv_legacy",
    domain_event_id: "de_legacy",
  });
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(rpc).toHaveBeenNthCalledWith(3, "request_settings_change_v1", {
    p_category: "ui_table_views",
    p_scope_type: "global",
    p_scope_id: null,
    p_value: { views: {} },
  });
});

test("requestSettingsChangeWithCompat keeps original error for unrelated function misses", async () => {
  const rpcError = {
    code: "PGRST202",
    message:
      "Could not find the function api.some_other_rpc(p_category, p_scope_type, p_scope_id, p_value) in the schema cache",
  };
  const rpc = jest.fn().mockRejectedValueOnce(rpcError);

  await expect(
    requestSettingsChangeWithCompat(rpc, {
      category: "ui_table_views",
      scopeType: "global",
      scopeId: null,
      value: { views: {} },
      changeReason: "save view",
      effectiveFrom: null,
    })
  ).rejects.toBe(rpcError);

  expect(rpc).toHaveBeenCalledTimes(1);
});
