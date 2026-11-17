import { isSchemaCacheFunctionUnavailableError } from "../../packages/ui/src/utils";

test("detects schema cache function miss for request_settings_change_v1", () => {
  expect(
    isSchemaCacheFunctionUnavailableError(
      {
        code: "PGRST202",
        message:
          "Could not find the function api.request_settings_change_v1(p_category, p_scope_type, p_scope_id, p_value) in the schema cache",
      },
      "request_settings_change_v1"
    )
  ).toBe(true);
});

test("ignores unrelated errors", () => {
  expect(
    isSchemaCacheFunctionUnavailableError(
      { message: "permission denied for relation shipments" },
      "request_settings_change_v1"
    )
  ).toBe(false);
});

