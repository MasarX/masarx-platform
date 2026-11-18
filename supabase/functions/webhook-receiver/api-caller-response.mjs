import { toResponseBody } from "../_shared/mod.mjs";

export const assertApiCallerAccepted = async (response) => {
  const data = await toResponseBody(response);
  if (!response.ok) throw new Error(`api_caller_http_${response.status}`);
  if (!data || typeof data !== "object" || data.success !== true) {
    throw new Error("api_caller_response_malformed");
  }
};
