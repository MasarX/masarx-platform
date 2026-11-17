import type { ReactNode } from "react";
import { getVerifiedAccessToken } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";
import { Button, EmptyState, createUiTranslator, hasCapability, resolveCapabilitySet, resolveSafeHref } from "@masarx/ui";
import { ResourcePage } from "../../../_components/resource-page";
import type { MarketplaceAccess } from "./marketplace-form";

export const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || null;
export const marketplaceHref = (base: string, path = "") => resolveSafeHref(base, `/automation/marketplace${path}`);
export const valueText = (value: unknown) => typeof value === "string" ? value : "";
export type MarketplaceSearch = Record<string, string | string[] | undefined>;
export type MarketplacePageProps = { searchParams: MarketplaceSearch };
export function unavailable() {
  const t = createUiTranslator("ui.automationMarketplace");
  return <EmptyState title={t("unavailable")} description={t("accessDenied")} testId="console-automation-marketplace-blocked" />;
}

export function MarketplaceResourcePage({ appKey, appBasePath, access, kind, searchParams, listingId }: { appKey: "console" | "portal"; appBasePath: string; access: MarketplaceAccess; kind: "listings" | "installs" | "connections" | "reviews"; searchParams: MarketplaceSearch; listingId?: string }) {
  const t = createUiTranslator("ui.automationMarketplace");
  const caps = resolveCapabilitySet(access.capabilities);
  const can = (cap: string) => hasCapability(caps, `automation_marketplace.${cap}`);
  const path = kind === "listings" ? listingId ? `/${encodeURIComponent(listingId)}` : "" : `/${kind}`;
  const href = marketplaceHref(appBasePath, path);
  if (!href) return unavailable();
  const resourceKey = { listings: "automation_asset_listings", installs: "automation_asset_installs", connections: "integration_connections", reviews: "automation_asset_reviews" }[kind];
  const link = (path: string, key: string, permitted = true, testId?: string) => {
    const url = marketplaceHref(appBasePath, path);
    return url && permitted ? <a className="text-sm text-ui-ink underline underline-offset-4" href={url} data-testid={testId}>{t(key)}</a> : null;
  };
  const state = (value: unknown) => ["private", "tenant_shared", "marketplace_public", "draft", "submitted", "pending", "approved", "rejected", "installed", "forked", "ready", "reauth_required", "revoked"].includes(valueText(value)) ? t(`options.${value}`) : t("unknown");
  return <div className="space-y-4"><nav aria-label={t("navigation")} className="flex flex-wrap gap-4">{link("", "marketplace")}{link("/installs", "installs")}{link("/connections", "connections")}{link("/reviews", "reviews")}</nav><ResourcePage
    appKey={appKey} resourceKey={resourceKey} searchParams={listingId ? { ...searchParams, id: listingId, detail_open: "1" } : searchParams} appBasePath={appBasePath} baseHref={href} testIdPrefix={`console-automation-marketplace${kind === "listings" ? listingId ? "-detail" : "" : `-${kind}`}`}
    headerActions={kind === "listings" && can("publish") ? <Button asChild size="sm">{link("/publish", "publish")}</Button> : kind === "connections" && can("manage_connections") ? <Button asChild size="sm">{link("/connections/manage", "newConnection")}</Button> : null}
    renderDetailFooter={({ detailId, detailError, detail }) => {
      if (!detailId || detailError || !detail || detail.id !== detailId) return null;
      const id = encodeURIComponent(detailId);
      const versionId = valueText(kind === "reviews" ? detail.listing_version_id : detail.latest_listing_version_id);
      return <div className="flex flex-wrap items-center gap-4 pt-3">
        {kind === "listings" ? <><span>{t("visibility")}: {state(detail.visibility)}</span><span>{t("publicationStatus")}: {state(detail.publication_status)}</span>{link(`/${id}`, "openListing")}{link(`/installs?listing_id=${id}`, "installs")}{link(`/reviews?listing_id=${id}`, "reviews")}{["workflow_template", "integration_plugin"].includes(valueText(detail.asset_kind)) && ["private", "tenant_shared", "marketplace_public"].includes(valueText(detail.visibility)) ? link(`/publish?listing_id=${id}&asset_kind=${encodeURIComponent(valueText(detail.asset_kind))}&visibility=${encodeURIComponent(valueText(detail.visibility))}`, "publishNewVersion", can("publish")) : null}{versionId ? link(`/install?listing_version_id=${encodeURIComponent(versionId)}`, "installCopy", can("install")) : null}</> : null}
        {kind === "installs" ? <><span>{t("status")}: {state(detail.install_status)}</span>{link(`/installs/manage?install_id=${id}`, "manageInstall", can("upgrade") || can("manage_connections"))}</> : null}
        {kind === "connections" ? <><span>{t("status")}: {state(detail.status)}</span>{link(`/connections/manage?connection_id=${id}`, "manageConnection", can("manage_connections"))}</> : null}
        {kind === "reviews" ? <><span data-testid="console-automation-marketplace-review-status">{t("reviewStatus")}: {state(detail.review_status)}</span><span>{t("listingVersionId")}: <code data-testid="console-automation-marketplace-review-listing-version">{versionId || t("unknown")}</code></span>{link(`/reviews/decide?review_id=${id}`, "decideReview", can("review"))}{versionId && detail.review_status === "approved" ? link(`/install?listing_version_id=${encodeURIComponent(versionId)}`, "installCopy", can("install")) : null}</> : null}
      </div>;
    }}
  /></div>;
}
export async function MarketplacePage({ capability, children }: { capability: string; children: (access: MarketplaceAccess, ui: ReturnType<typeof createUiServerClient>) => ReactNode | Promise<ReactNode> }) {
  try {
    const { user, accessToken } = await getVerifiedAccessToken({ allowCookieSet: false });
    if (!user || !accessToken) return unavailable();
    const ui = createUiServerClient();
    const me = await ui.me();
    const capabilities = me?.capabilities ?? [];
    if (!me?.user?.id || me.user.id !== user.id || !hasCapability(resolveCapabilitySet(capabilities), capability)) return unavailable();
    const scopeKey = `${me?.org?.id ?? ""}/${me?.access_scope?.scope_type ?? ""}/${me?.access_scope?.scope_id ?? ""}`;
    return await children({ userId: user.id, capabilities, scopeKey }, ui);
  } catch {
    return unavailable();
  }
}

export async function MarketplacePublishLink({ appBasePath, sourceId, assetKind }: { appBasePath: string; sourceId: string; assetKind: "integration_plugin" | "workflow_template" }) {
  const href = marketplaceHref(appBasePath, `/publish?asset_kind=${assetKind}&source_id=${encodeURIComponent(sourceId)}`);
  if (!sourceId || !href) return null;
  try {
    const { user, accessToken } = await getVerifiedAccessToken({ allowCookieSet: false });
    if (!user || !accessToken) return null;
    const me = await createUiServerClient().me();
    if (me?.user?.id !== user.id || !hasCapability(resolveCapabilitySet(me.capabilities), "automation_marketplace.publish")) return null;
  } catch { return null; }
  const t = createUiTranslator("ui.automationMarketplace");
  return <a className="ms-3 text-sm text-ui-ink underline underline-offset-4" href={href}>{t("publish")}</a>;
}
