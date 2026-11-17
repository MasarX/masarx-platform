import {
  isPasswordGrantTokenRequest,
  summarizeAuthErrorBody,
} from "../../e2e/utils/auth-request";

describe("auth request matcher", () => {
  test("matches password grant request for expected email", () => {
    expect(
      isPasswordGrantTokenRequest({
        method: "POST",
        url: "https://project.supabase.co/auth/v1/token?grant_type=password",
        postData: JSON.stringify({
          email: "hqhurgjlxmmnnpujhixupxok@example.invalid",
          password: "secret",
          gotrue_meta_security: {},
        }),
        email: "hqhurgjlxmmnnpujhixupxok@example.invalid",
      })
    ).toBe(true);
  });

  test("rejects non-password grants", () => {
    expect(
      isPasswordGrantTokenRequest({
        method: "POST",
        url: "https://project.supabase.co/auth/v1/token?grant_type=refresh_token",
        postData: JSON.stringify({ refresh_token: "abc" }),
        email: "lpnoiwlvqmryinlkzgwwiosw@example.invalid",
      })
    ).toBe(false);
  });

  test("rejects password grant for a different email", () => {
    expect(
      isPasswordGrantTokenRequest({
        method: "POST",
        url: "https://project.supabase.co/auth/v1/token?grant_type=password",
        postData: JSON.stringify({
          email: "grtvmqqmiylsynghursjhmzp@example.invalid",
          password: "secret",
        }),
        email: "hqhurgjlxmmnnpujhixupxok@example.invalid",
      })
    ).toBe(false);
  });

  test("accepts form-encoded password grant body", () => {
    expect(
      isPasswordGrantTokenRequest({
        method: "POST",
        url: "https://project.supabase.co/auth/v1/token",
        postData:
          "grant_type=password&email=hqhurgjlxmmnnpujhixupxok%40example.invalid&password=secret",
        email: "hqhurgjlxmmnnpujhixupxok@example.invalid",
      })
    ).toBe(true);
  });

  test("allows password grant matching without expected email", () => {
    expect(
      isPasswordGrantTokenRequest({
        method: "POST",
        url: "https://project.supabase.co/auth/v1/token?grant_type=password",
        postData: JSON.stringify({
          email: "mlswrglokqqujmzjgujtkxkn@example.invalid",
          password: "secret",
        }),
      })
    ).toBe(true);
  });
});

describe("summarizeAuthErrorBody", () => {
  test("summarizes JSON error payload", () => {
    expect(
      summarizeAuthErrorBody(
        JSON.stringify({
          error_code: "invalid_credentials",
          message: "Invalid login credentials",
        })
      )
    ).toBe("invalid_credentials: Invalid login credentials");
  });

  test("returns raw body when payload is not JSON", () => {
    expect(summarizeAuthErrorBody("Something went wrong")).toBe(
      "Something went wrong"
    );
  });
});
