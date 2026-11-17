import { toResponseBody } from "../_shared/mod.mjs";

export const readApiCallerResult = async (response, { requireSuccess = false } = {}) => {
  const data = await toResponseBody(response);
  const result = data && typeof data === "object" ? data.result : null;
  if (!result || typeof result !== "object" || typeof result.status !== "number") {
    if (!response.ok) throw new Error(`api_caller_http_${response.status}`);
    throw new Error("api_caller_response_malformed");
  }
  if (requireSuccess && data.success !== true) {
    throw new Error("api_caller_dispatch_failed");
  }
  return {
    status: result.status,
    headers: result.headers && typeof result.headers === "object" ? result.headers : {},
    body: result.body ?? null,
  };
};
