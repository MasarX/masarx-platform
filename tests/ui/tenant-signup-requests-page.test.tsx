import * as React from "react";
import { render, screen } from "@testing-library/react";
import { TenantSignupRequestsPage } from "../../packages/ui/src/tenant-signup-requests-page";
import { TenantSignupReviewForm } from "../../packages/ui/src/tenant-signup-review-form";
import { ResourcePage } from "../../packages/ui/src/resource-page";
import { createUiServerClient } from "@masarx/api/server";
import { createServerReachableFetch, getVerifiedAccessToken } from "@masarx/auth/server";
import { getPublicConfig } from "@masarx/config";

jest.mock("@masarx/api/server", () => ({ createUiServerClient: jest.fn() }));
jest.mock("@masarx/auth/server", () => ({
  createServerReachableFetch: jest.fn(),
  getVerifiedAccessToken: jest.fn(),
}));
jest.mock("@masarx/config", () => ({ ...jest.requireActual("@masarx/config"), getPublicConfig: jest.fn() }));
jest.mock("../../packages/ui/src/resource-page", () => ({ ResourcePage: () => null }));
jest.mock("../../packages/ui/src/tenant-signup-review-form", () => ({ TenantSignupReviewForm: () => null }));

const fetchReview = jest.fn();
const requestId = "4f3e8ae5-f9f4-4fb1-baa1-943ca0d0bb77";

beforeEach(() => {
  jest.resetAllMocks();
  (createUiServerClient as jest.Mock).mockReturnValue({
    me: jest.fn().mockResolvedValue({ capabilities: ["tenant_signup_requests.review"] }),
  });
  (getPublicConfig as jest.Mock).mockReturnValue({ supabaseUrl: "https://example.test" });
  (getVerifiedAccessToken as jest.Mock).mockResolvedValue({ accessToken: "synthetic-session" });
  (createServerReachableFetch as jest.Mock).mockReturnValue(fetchReview);
});

async function reviewFooter(detail: Record<string, unknown> = { status: "pending" }) {
  const page = await TenantSignupRequestsPage({
    appKey: "console", searchParams: {}, appBasePath: "/console",
    baseHref: "/console/organizations/requests", testIdPrefix: "tenant-review",
  });
  const resourcePage = React.Children.toArray(page.props.children).find(
    (child): child is React.ReactElement<Parameters<typeof ResourcePage>[0]> =>
      React.isValidElement(child) && child.type === ResourcePage,
  );
  if (!resourcePage?.props.renderDetailFooter) throw new Error("Resource review footer not rendered");
  return resourcePage.props.renderDetailFooter({
    resourceKey: "tenant_signup_requests", detail, detailError: null, detailId: requestId,
    downloadHref: null, baseHref: "/console/organizations/requests", resource: undefined,
  });
}

function findReviewForm(node: React.ReactNode): React.ReactElement<React.ComponentProps<typeof TenantSignupReviewForm>> | null {
  if (React.isValidElement(node)) {
    if (node.type === TenantSignupReviewForm) return node as React.ReactElement<React.ComponentProps<typeof TenantSignupReviewForm>>;
    for (const child of React.Children.toArray((node.props as { children?: React.ReactNode }).children)) {
      const found = findReviewForm(child);
      if (found) return found;
    }
  }
  return null;
}

async function submitReview() {
  const form = findReviewForm(await reviewFooter());
  if (!form) throw new Error("Review form not rendered");
  const data = new FormData();
  data.set("request_id", requestId);
  data.set("decision", "rejected");
  data.set("reason", "Synthetic validation reason");
  return form.props.action({ status: "idle" }, data);
}

test.each(["throw", "missing"])('tenant review configuration failure stays friendly: %s', async (failure) => {
  (getPublicConfig as jest.Mock).mockImplementation(() => {
    if (failure === "throw") throw new Error("Backend secret=synthetic-short");
    return { supabaseUrl: "" };
  });
  expect(await submitReview()).toEqual({ status: "error", message: "Review service is unavailable. Try again later." });
  expect(fetchReview).not.toHaveBeenCalled();
});

test("tenant review asks for a fresh sign-in when the session is unavailable", async () => {
  (getVerifiedAccessToken as jest.Mock).mockResolvedValue({ error: new Error("Backend token=synthetic-short") });
  expect(await submitReview()).toEqual({ status: "error", message: "Sign in again before reviewing this request." });
  expect(fetchReview).not.toHaveBeenCalled();
});

test.each([
  [400, { message: "Backend raw response; token=synthetic-short" }, "Unable to complete the review. Try again or contact your administrator."],
  [400, { code: "internal_guard_failure" }, "Unable to complete the review. Try again or contact your administrator."],
  [401, { message: "JWT token=synthetic-short" }, "Sign in again before reviewing this request."],
  [403, { message: "permission denied for table private_users" }, "You do not have permission to review this request. Contact your administrator."],
  [500, { message: "Unexpected private configuration" }, "Unable to complete the review. Try again or contact your administrator."],
  [422, { message: "A rejection reason is required." }, "Unable to complete the review. Try again or contact your administrator."],
])("tenant review HTTP %s uses safe contextual copy (case %#)", async (status, error, message) => {
  fetchReview.mockResolvedValue({ ok: false, status, json: async () => ({ ok: false, error }) });
  const result = await submitReview();
  expect(result).toEqual({ status: "error", message });
  expect(result.message).not.toContain("rejection reason");
  const [, request] = fetchReview.mock.calls[0];
  expect(JSON.parse(request.body)).toMatchObject({ request_id: requestId, decision: "rejected", reason: "Synthetic validation reason" });
});

test("tenant review transport errors cannot restore rejected diagnostics", async () => {
  fetchReview.mockRejectedValue(new Error("Backend diagnostic; client_secret=synthetic-short"));
  expect(await submitReview()).toEqual({ status: "error", message: "Unable to send the review. Check your connection and try again." });
});

test("tenant review history uses friendly copy without changing persisted diagnosis", async () => {
  const detail = { status: "pending", last_error_code: "PRIVATE_INTERNAL_CODE", last_error_message: "Backend raw payload; token=synthetic-short" };
  const original = { ...detail };
  render(await reviewFooter(detail));
  expect(screen.getByText(/Last review attempt: Unable to complete the review/)).toBeInTheDocument();
  expect(screen.queryByText(/synthetic-short|PRIVATE_INTERNAL_CODE|raw payload/)).not.toBeInTheDocument();
  expect(detail).toEqual(original);
});

test("tenant review renders friendly status while retaining the canonical decision options", async () => {
  const rows = [{ value: "rejected", label: "Reject request" }];
  const listLookupValues = jest.fn().mockResolvedValue(rows);
  (createUiServerClient as jest.Mock).mockReturnValue({
    me: jest.fn().mockResolvedValue({ capabilities: ["tenant_signup_requests.review"] }),
    listLookupValues,
  });
  const footer = await reviewFooter({
    status: "rejected",
    review_decision: "rejected",
    review_reason: "Synthetic review reason",
  });
  render(footer);

  expect(listLookupValues).toHaveBeenCalledWith("tenant_signup_review_decision");
  expect(screen.getAllByText("Rejected")).toHaveLength(2);
  expect(screen.queryByText(/^rejected$/)).not.toBeInTheDocument();
  expect(screen.getByText(/Synthetic review reason/)).toBeInTheDocument();
  expect(findReviewForm(footer)?.props).toMatchObject({
    requestId,
    disabled: true,
    disabledMessage: "Only pending requests can be reviewed.",
    decisionOptions: rows,
  });
});
