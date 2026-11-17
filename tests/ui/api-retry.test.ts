import { isRetriableSupabaseError } from "../../packages/api/src/retry";

test("isRetriableSupabaseError returns true for server statuses", () => {
  expect(isRetriableSupabaseError({ status: 503 })).toBe(true);
});

test("isRetriableSupabaseError returns true for schema cache function misses", () => {
  expect(
    isRetriableSupabaseError({
      code: "PGRST202",
      message:
        "Could not find the function api.request_settings_change_v1(p_category, p_scope_type, p_scope_id, p_value) in the schema cache",
    })
  ).toBe(true);
});

test("isRetriableSupabaseError returns false for non-transient client errors", () => {
  expect(
    isRetriableSupabaseError({
      status: 400,
      code: "42501",
      message: "permission denied",
    })
  ).toBe(false);
});
