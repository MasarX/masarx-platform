import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { UiMe } from "@masarx/api";
import { getVerifiedAccessToken } from "@masarx/auth/server";
import { getPublicConfig } from "@masarx/config";
import { revalidatePath } from "next/cache";
import { Badge } from "./badge";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import {
  TenantSignupReviewForm,
  TenantSignupReviewState,
} from "./tenant-signup-review-form";
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
      return { status: "error", message: "Supabase runtime configuration is unavailable." };
    }

    if (!supabaseUrl) {
      return { status: "error", message: "Supabase runtime URL is missing." };
    }

    const { accessToken, error: sessionError } =
      await getVerifiedAccessToken({ allowCookieSet: false });

    if (sessionError || !accessToken) {
      return {
        status: "error",
        message: "Authenticated reviewer session is required.",
      };
    }

    const endpoint = `${supabaseUrl.replace(/\/+$/g, "")}/functions/v1/tenant-signup-review`;

    let response: Response;
    try {
      response = await fetch(endpoint, {
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
        message: formatUiError(error, "Review request failed before reaching the API."),
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
      const message =
        (typeof err?.message === "string" && err.message.trim()) ||
        (typeof err?.code === "string" && err.code.trim()) ||
        `Review request failed with status ${response.status}.`;
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

  return (
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
            : "Your account is missing tenant_signup_requests.review capability.";
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
                <Badge tone={isPending ? "neutral" : "accent"}>{status}</Badge>
                {decision ? <Badge tone="accent">{decision}</Badge> : null}
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
                  Last error{lastErrorCode ? ` (${lastErrorCode})` : ""}
                  {lastErrorMessage ? `: ${lastErrorMessage}` : "."}
                </div>
              ) : null}

              <TenantSignupReviewForm
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
  );
}
