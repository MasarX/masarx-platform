import { normalizeReviewDecisionOptions } from "./review-decision-options";
import "server-only";

import { labelFromKey } from "./resource-query";

import { createUiServerClient } from "@masarx/api/server";
import { UiMe } from "@masarx/api";
import {
  createServerReachableFetch,
  getVerifiedAccessToken,
} from "@masarx/auth/server";
import { getPublicConfig } from "@masarx/config";
import { revalidatePath } from "next/cache";
import { Badge } from "./badge";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import {
  TenantSignupReviewForm,
  TenantSignupReviewState,
} from "./tenant-signup-review-form";
import {
  TenantSignupRequestCreateForm,
  type TenantSignupRequestCreateState,
} from "./tenant-signup-request-create-form";
import { formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

type TenantSignupRequestsPageProps = {
  appKey: "console" | "portal";
  searchParams: SearchParams;
  appBasePath: string;
  baseHref: string;
  testIdPrefix: string;
  description?: string;
};

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeDecision(raw: string): "approved" | "rejected" | "" {
  const value = raw.trim().toLowerCase();
  if (value === "approve" || value === "approved") return "approved";
  if (value === "reject" || value === "rejected") return "rejected";
  return "";
}

function isDisallowedHostedRedirectHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  );
}

function normalizeHostedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (isDisallowedHostedRedirectHost(url.hostname)) {
      return null;
    }
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      return url.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function resolveDefaultInviteRedirect(value: string | null): string | null {
  const explicit = normalizeHostedUrl(value ?? "");
  if (explicit) return explicit;

  const portalBaseUrl = String(process.env.PORTAL_BASE_URL || "").trim();
  if (!portalBaseUrl) return null;
  return normalizeHostedUrl(`${portalBaseUrl.replace(/\/+$/g, "")}/auth/callback`);
}

/**
 * Console organization requests queue page (tenant signup approvals).
 */
export async function TenantSignupRequestsPage({
  appKey,
  searchParams,
  appBasePath,
  baseHref,
  testIdPrefix,
  description,
}: TenantSignupRequestsPageProps) {
  const ui = createUiServerClient();
  const decisionOptions = normalizeReviewDecisionOptions(
    await (ui.listLookupValues?.("tenant_signup_review_decision") ?? Promise.resolve([])).catch(() => []),
  );
  let me: UiMe | null = null;
  let meError: string | null = null;

  try {
    me = await ui.me();
  } catch (error) {
    meError = formatUiError(error, "Unable to load current reviewer profile.");
  }

  const statusFilter = firstValue(searchParams.status);
  const effectiveSearchParams = statusFilter
    ? searchParams
    : { ...searchParams, status: "pending" };

  const canReview = hasCapability(
    resolveCapabilitySet(me?.capabilities ?? null),
    "tenant_signup_requests.review",
  );
  const canCreate = canReview && me?.access_scope?.scope_type === "platform";

  const reviewTelemetry = me
    ? {
        settingsResolutionId: me.settings_resolution_id ?? null,
        scopeType: me.access_scope?.scope_type ?? null,
        scopeId: me.access_scope?.scope_id ?? null,
        scopeValue: null,
      }
    : null;

  async function submitReview(
    _prevState: TenantSignupReviewState,
    formData: FormData,
  ): Promise<TenantSignupReviewState> {
    "use server";
    const requestId = String(formData.get("request_id") ?? "").trim();
    const decision = normalizeDecision(String(formData.get("decision") ?? ""));
    const reason = String(formData.get("reason") ?? "").trim();
    const inviteRedirectRaw = String(formData.get("invite_redirect_to") ?? "").trim();

    if (!uuidRegex.test(requestId)) {
      return { status: "error", message: "Invalid request id." };
    }

    if (!decision) {
      return { status: "error", message: "Select a valid decision." };
    }

    const inviteRedirectTo = normalizeHostedUrl(inviteRedirectRaw);
    if (inviteRedirectRaw && !inviteRedirectTo) {
      return {
        status: "error",
        message: "Invite redirect must be a hosted non-localhost http/https URL.",
      };
    }
    if (decision === "approved" && !inviteRedirectTo) {
      return {
        status: "error",
        message: "Invite redirect is required for approvals and must use a hosted callback URL.",
      };
    }

    let supabaseUrl = "";
    try {
      supabaseUrl = getPublicConfig().supabaseUrl;
    } catch {
      return { status: "error", message: "Review service is unavailable. Try again later." };
    }

    if (!supabaseUrl) {
      return { status: "error", message: "Review service is unavailable. Try again later." };
    }

    const { accessToken, error: sessionError } =
      await getVerifiedAccessToken({ allowCookieSet: false });

    if (sessionError || !accessToken) {
      return {
        status: "error",
        message: "Sign in again before reviewing this request.",
      };
    }

    const endpoint = `${supabaseUrl.replace(/\/+$/g, "")}/functions/v1/tenant-signup-review`;
    const serverFetch = createServerReachableFetch(supabaseUrl) ?? fetch;

    let response: Response;
    try {
      response = await serverFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          request_id: requestId,
          decision,
          reason: reason || null,
          invite_redirect_to: inviteRedirectTo,
          metadata: {
            source: "console.organizations.requests",
            app_base_path: appBasePath,
          },
        }),
      });
    } catch (error) {
      return {
        status: "error",
        message: formatUiError(error, "Unable to send the review. Check your connection and try again."),
      };
    }

    const payload = await response.json().catch(() => null);
    const payloadRecord = payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;

    if (!response.ok || payloadRecord?.ok === false) {
      const err = payloadRecord?.error && typeof payloadRecord.error === "object"
        ? (payloadRecord.error as Record<string, unknown>)
        : null;
      const fallback = response.status === 401
        ? "Sign in again before reviewing this request."
        : response.status === 403
          ? "You do not have permission to review this request. Contact your administrator."
          : "Unable to complete the review. Try again or contact your administrator.";
      const message = response.status >= 500 || response.status === 401 || response.status === 403
        ? fallback
        : formatUiError(err?.message, fallback);
      return { status: "error", message };
    }

    revalidatePath(baseHref);
    return {
      status: "success",
      message: decision === "approved"
        ? "Organization request approved and activated."
        : "Organization request rejected.",
    };
  }

  async function submitCreate(
    _prevState: TenantSignupRequestCreateState,
    formData: FormData,
  ): Promise<TenantSignupRequestCreateState> {
    "use server";
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const fullName = String(formData.get("full_name") ?? "").trim();
    const organizationName = String(formData.get("organization_name") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !fullName || !organizationName) {
      return { status: "error", message: "Enter a valid email, full name, and organization name." };
    }
    const { accessToken, error } = await getVerifiedAccessToken({ allowCookieSet: false });
    if (error || !accessToken) {
      return { status: "error", message: "Authenticated reviewer session is required." };
    }
    try {
      // The RPC reasserts the current platform reviewer; no actor or tenant scope comes from the form.
      const result = await createUiServerClient().rpc<Record<string, unknown>>(
        "tenant_signup_request_create_reviewer_v1",
        {
          p_input: {
            email,
            full_name: fullName,
            organization_name: organizationName,
            organization_slug: String(formData.get("organization_slug") ?? "").trim() || null,
            website_url: String(formData.get("website_url") ?? "").trim() || null,
            phone: String(formData.get("phone") ?? "").trim() || null,
            notes: String(formData.get("notes") ?? "").trim() || null,
            locale: String(formData.get("locale") ?? "").trim() || null,
          },
        },
      );
      const requestId = typeof result?.id === "string" ? result.id : "";
      const status = typeof result?.status === "string" ? result.status : "";
      if (result?.ok !== true || !uuidRegex.test(requestId) || !["pending", "approved", "rejected"].includes(status)
        || (status !== "pending" && result.deduped !== true)) {
        const failure = result?.error && typeof result.error === "object"
          ? (result.error as Record<string, unknown>)
          : null;
        return { status: "error", message: typeof failure?.code === "string" ? failure.code : "Unable to queue organization request." };
      }
      revalidatePath(baseHref);
      const params = new URLSearchParams({ id: requestId, status });
      return {
        status: "success",
        message: result.deduped === true
          ? `Existing organization request reused (${status}).`
          : "Organization request queued for review.",
        requestHref: `${baseHref}?${params.toString()}`,
      };
    } catch (error) {
      return { status: "error", message: formatUiError(error, "Organization request creation failed.") };
    }
  }

  return (
    <div className="space-y-6">
      {canCreate ? (
        <Section title="Queue organization request" description="Create a pending request for the platform review queue; no account is activated.">
          <TenantSignupRequestCreateForm action={submitCreate} testIdPrefix={`${testIdPrefix}-create`} />
        </Section>
      ) : null}
      <ResourcePage
      appKey={appKey}
      resourceKey="tenant_signup_requests"
      searchParams={effectiveSearchParams}
      appBasePath={appBasePath}
      baseHref={baseHref}
      description={
        description ??
        "Review and decide incoming organization signup requests."
      }
      testIdPrefix={testIdPrefix}
      renderDetailFooter={({ detail, detailError, detailId }) => {
        if (!detail || detailError) return null;

        const status = stringValue(detail.status) ?? "unknown";
        const decision = stringValue(detail.review_decision);
        const reviewedAt = stringValue(detail.reviewed_at);
        const reviewedBy = stringValue(detail.reviewed_by);
        const reviewReason = stringValue(detail.review_reason);
        const lastErrorCode = stringValue(detail.last_error_code);
        const lastErrorMessage = stringValue(detail.last_error_message);
        const inviteEmailSentAt = stringValue(detail.invite_email_sent_at);
        const defaultInviteRedirectTo = resolveDefaultInviteRedirect(
          stringValue(detail.invite_redirect_to),
        );

        const isPending = status === "pending";

        let blockedMessage: string | undefined;
        if (!canReview) {
          blockedMessage = meError
            ? `Reviewer context unavailable: ${meError}`
            : "You do not have permission to review organization requests. Contact your administrator.";
        } else if (!isPending) {
          blockedMessage = "Only pending requests can be reviewed.";
        }

        return (
          <Section
            title="Review request"
            description="Approve to activate tenant onboarding and send invite access, or reject with a reason."
            collapsible
            collapseKey="tenant-signup-requests.review"
          >
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-ui-muted">
                <span>Status</span>
                <Badge tone={isPending ? "neutral" : "accent"}>{labelFromKey(status)}</Badge>
                {decision ? <Badge tone="accent">{labelFromKey(decision)}</Badge> : null}
                {reviewedBy ? <span className="text-xs">Reviewer: {reviewedBy}</span> : null}
                {reviewedAt ? <span className="text-xs">Reviewed at: {reviewedAt}</span> : null}
                {inviteEmailSentAt ? <span className="text-xs">Invite sent: {inviteEmailSentAt}</span> : null}
              </div>

              {reviewReason ? (
                <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-xs text-ui-muted">
                  Review reason: {reviewReason}
                </div>
              ) : null}

              {lastErrorCode || lastErrorMessage ? (
                <div className="rounded-xl border border-ui-border bg-ui-surface/80 p-3 text-xs text-ui-muted">
                  Last review attempt: {formatUiError(lastErrorMessage, "Unable to complete the review. Contact your administrator.")}
                </div>
              ) : null}

              <TenantSignupReviewForm
                decisionOptions={decisionOptions}
                action={submitReview}
                requestId={detailId}
                disabled={Boolean(blockedMessage)}
                disabledMessage={blockedMessage}
                defaultInviteRedirectTo={defaultInviteRedirectTo}
                testIdPrefix={`${testIdPrefix}-review`}
                telemetry={reviewTelemetry}
              />
            </div>
          </Section>
        );
      }}
      />
    </div>
  );
}
