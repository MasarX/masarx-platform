import { normalizeReviewDecisionOptions } from "./review-decision-options";
import "server-only";

import { createUiServerClient } from "@masarx/api/server";
import { UiMe } from "@masarx/api";
import {
  createServerReachableFetch,
  getVerifiedAccessToken,
} from "@masarx/auth/server";
import { getPublicConfig } from "@masarx/config";
import { Badge } from "./badge";
import { ResourcePage } from "./resource-page";
import { Section } from "./section";
import {
  MarketplaceParticipantReviewForm,
  MarketplaceParticipantReviewState,
} from "./marketplace-participant-review-form";
import { formatUiError } from "./utils";
import { hasCapability, resolveCapabilitySet } from "./capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

type MarketplaceParticipantRequestsPageProps = {
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

function normalizeDecision(raw: string): "approved" | "rejected" | "request_additional_docs" | "" {
  const value = raw.trim().toLowerCase();
  if (value === "approve" || value === "approved") return "approved";
  if (value === "reject" || value === "rejected") return "rejected";
  if (["request_additional_docs", "request-docs", "request_docs", "additional_docs"].includes(value)) {
    return "request_additional_docs";
  }
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

export async function MarketplaceParticipantRequestsPage({
  appKey,
  searchParams,
  appBasePath,
  baseHref,
  testIdPrefix,
  description,
}: MarketplaceParticipantRequestsPageProps) {
  const ui = createUiServerClient();
  const reviewDecisionOptions = normalizeReviewDecisionOptions(
    await (ui.listLookupValues?.("marketplace_participant_request_review_decision") ?? Promise.resolve([])).catch(() => []),
    ["approved", "rejected", "request_additional_docs"],
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
    "marketplace_participant_requests.review",
  );

  async function submitReview(
    _prevState: MarketplaceParticipantReviewState,
    formData: FormData,
  ): Promise<MarketplaceParticipantReviewState> {
    "use server";
    const requestId = String(formData.get("request_id") ?? "").trim();
    const participantTypeKey = String(formData.get("participant_type_key") ?? "").trim();
    const decision = normalizeDecision(String(formData.get("decision") ?? ""));
    const reason = String(formData.get("reason") ?? "").trim();
    const inviteRedirectRaw = String(formData.get("invite_redirect_to") ?? "").trim();
    const requestedDocuments = [...new Set(String(formData.get("requested_documents") ?? "")
      .split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];

    if (!uuidRegex.test(requestId)) {
      return { status: "error", message: "Invalid request id." };
    }

    if (!decision) {
      return { status: "error", message: "Select a valid decision." };
    }

    if (decision === "request_additional_docs" && requestedDocuments.some((value) => value.length > 100)) {
      return { status: "error", message: "Each requested document type must be at most 100 characters." };
    }

    const inviteRedirectTo = normalizeHostedUrl(inviteRedirectRaw);
    if (inviteRedirectRaw && !inviteRedirectTo) {
      return {
        status: "error",
        message: "Invite redirect must be a hosted non-localhost http/https URL.",
      };
    }
    if (decision === "approved" && participantTypeKey === "freelancer_driver" && !inviteRedirectTo) {
      return {
        status: "error",
        message: "Freelancer-driver approvals require a hosted invite redirect.",
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

    // Server actions can legally refresh auth cookies; allow that here so
    // reviewer submissions do not fail when the browser session only needs a
    // server-side token refresh.
    const { accessToken, error: sessionError } =
      await getVerifiedAccessToken({ allowCookieSet: true });

    if (sessionError || !accessToken) {
      return {
        status: "error",
        message: "Authenticated reviewer session is required.",
      };
    }

    const endpoint = `${supabaseUrl.replace(/\/+$/g, "")}/functions/v1/marketplace-participant-review`;
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
            source: "console.marketplace.reviews",
            app_base_path: appBasePath,
            ...(decision === "request_additional_docs" ? { requested_documents: requestedDocuments } : {}),
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

    if (decision === "request_additional_docs") {
      const result = payloadRecord?.result as Record<string, unknown> | undefined;
      if (payloadRecord?.ok !== true || result?.ok !== true || result.status !== "pending"
        || result.decision !== "request_additional_docs") {
        return { status: "error", message: "The API did not confirm a pending additional-document review. Reload the request before retrying." };
      }
    }

    return {
      status: "success",
      message:
        decision === "approved"
          ? "Marketplace participant approved."
          : decision === "request_additional_docs"
          ? "Additional documents requested. The application remains pending."
          : "Marketplace participant rejected.",
    };
  }

  return (
    <ResourcePage
      appKey={appKey}
      resourceKey="marketplace_participant_requests"
      searchParams={effectiveSearchParams}
      appBasePath={appBasePath}
      baseHref={baseHref}
      description={
        description ??
        "Review freelancer-driver and provider-tenant marketplace onboarding requests."
      }
      testIdPrefix={testIdPrefix}
      renderDetailFooter={({ detail, detailError, detailId }) => {
        if (!detail || detailError) return null;

        const status = stringValue(detail.status) ?? "unknown";
        const decision = stringValue(detail.review_decision);
        const requestedDocuments = Array.isArray(detail.requested_documents)
          ? detail.requested_documents.filter((value): value is string => typeof value === "string") : [];
        const reviewedAt = stringValue(detail.reviewed_at);
        const reviewedBy = stringValue(detail.reviewed_by);
        const reviewReason = stringValue(detail.review_reason);
        const lastErrorCode = stringValue(detail.last_error_code);
        const lastErrorMessage = stringValue(detail.last_error_message);
        const participantTypeKey = stringValue(detail.requested_participant_type_key);
        const inviteRedirectTo = resolveDefaultInviteRedirect(
          stringValue(detail.invite_redirect_to),
        );

        const isPending = status === "pending";

        return (
          <div className="space-y-4">
            <Section title="Review status" collapsible={false}>
              <div className="flex flex-wrap gap-2 text-xs text-ui-muted">
                <Badge>{status}</Badge>
                {participantTypeKey ? <Badge>{participantTypeKey}</Badge> : null}
                {decision ? <Badge>{decision}</Badge> : null}
              </div>
              {reviewedAt || reviewedBy ? (
                <p className="mt-3 text-sm text-ui-muted">
                  Reviewed {reviewedAt ? `at ${reviewedAt}` : ""}{" "}
                  {reviewedBy ? `by ${reviewedBy}` : ""}.
                </p>
              ) : null}
              {reviewReason ? (
                <p className="mt-3 text-sm text-ui-muted">{reviewReason}</p>
              ) : null}
              {decision === "request_additional_docs" && requestedDocuments.length ? (
                <div className="mt-3 text-sm text-ui-muted" data-testid={`${testIdPrefix}-requested-documents`}>
                  <p>Requested documents</p>
                  <ul className="list-inside list-disc">
                    {requestedDocuments.map((document) => <li key={document}>{document}</li>)}
                  </ul>
                </div>
              ) : null}
            </Section>

            {lastErrorCode || lastErrorMessage ? (
              <Section title="Provisioning error" collapsible={false}>
                <div className="space-y-2 rounded-2xl border border-ui-border bg-ui-surface/80 p-4">
                  {lastErrorCode ? (
                    <p className="text-sm text-ui-ink">Code: {lastErrorCode}</p>
                  ) : null}
                  {lastErrorMessage ? (
                    <p className="text-sm text-ui-muted">{lastErrorMessage}</p>
                  ) : null}
                </div>
              </Section>
            ) : null}

            <Section title="Apply review" collapsible={false}>
              {canReview ? (
                <MarketplaceParticipantReviewForm
                  decisionOptions={reviewDecisionOptions}
                  action={submitReview}
                  requestId={detailId}
                  participantTypeKey={participantTypeKey}
                  disabled={!isPending}
                  disabledMessage={
                    isPending
                      ? undefined
                      : "This request has already been processed."
                  }
                  defaultInviteRedirectTo={inviteRedirectTo}
                  testIdPrefix={`${testIdPrefix}-review`}
                />
              ) : (
                <div className="rounded-2xl border border-ui-border bg-ui-surface/80 p-4 text-sm text-ui-muted">
                  {meError
                    ? meError
                    : "Marketplace participant review capability is required."}
                </div>
              )}
            </Section>
          </div>
        );
      }}
    />
  );
}
