"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@masarx/ui";
import { Choice, Field, MarketplaceCancel, MarketplaceFeedback, jsonObject, marketplaceHref, readBack, requireResult, useMarketplaceAction, type MarketplaceFormProps } from "./marketplace-form";

type Props = MarketplaceFormProps & { defaultListingId?: string | null; defaultAssetKind?: string | null; defaultSourceId?: string | null; defaultTitle?: string | null; defaultSummary?: string | null; defaultVisibility?: string | null };
const manifestDefault = { display: { title: "", summary: "" }, docs: {}, variable_schema: { keys: [] }, connection_requirements: { bindings: [] }, dependency_requirements: { required_assets: [] }, capability_requirements: [], install_constraints: { allowed_scope_placeholders: [] }, egress_profile: {}, compatibility: {}, artifact_hash: "" };
export function AutomationMarketplacePublishForm(props: Props) {
  const router = useRouter();
  const [assetKind, setAssetKind] = React.useState(props.defaultAssetKind === "integration_plugin" ? "integration_plugin" : "workflow_template");
  const [sourceId, setSourceId] = React.useState(props.defaultSourceId ?? "");
  const [title, setTitle] = React.useState(props.defaultTitle ?? "");
  const [summary, setSummary] = React.useState(props.defaultSummary ?? "");
  const [visibility, setVisibility] = React.useState(["private", "tenant_shared", "marketplace_public"].includes(props.defaultVisibility ?? "") ? props.defaultVisibility! : "private");
  const [notes, setNotes] = React.useState("");
  const [manifest, setManifest] = React.useState(JSON.stringify(manifestDefault, null, 2));
  const [docs, setDocs] = React.useState("{}");
  const action = useMarketplaceAction(props, "automation_marketplace.publish", `${props.defaultListingId ?? ""}/${props.defaultSourceId ?? ""}`);
  const { t } = action;
  const disabled = action.pending || !action.allowed;
  return <form method="post" className="space-y-4" data-testid="automation-marketplace-publish-form" onSubmit={event => {
    event.preventDefault();
    void action.run(async (ui, check) => {
      const previous = props.defaultListingId ? await readBack(ui, "automation_asset_listings", props.defaultListingId, row => row.asset_kind === assetKind) : null;
      check();
      const created = await ui.createAutomationAssetListing({ listingId: props.defaultListingId || null, assetKind, sourceId: sourceId.trim(), title: title.trim() || null, summary: summary.trim() || null, visibility, manifest: jsonObject(manifest), docs: jsonObject(docs), notes: notes || null });
      check();
      const listingId = requireResult(created.ok, created.listing_id, props.defaultListingId || undefined);
      const versionId = requireResult(created.ok, created.listing_version_id);
      let destination = `/${encodeURIComponent(listingId)}`;
      const preservesApproved = previous?.publication_status === "approved";
      const matchesRoot = (row: Record<string, unknown>, status: "draft" | "submitted") => preservesApproved ? row.latest_listing_version_id === previous.latest_listing_version_id && row.publication_status === "approved" : row.latest_listing_version_id === versionId && row.publication_status === status && row.visibility === visibility;
      await readBack(ui, "automation_asset_listings", listingId, row => matchesRoot(row, "draft"));
      check();
      await readBack(ui, "automation_asset_listing_versions", versionId, row => row.listing_id === listingId && row.publication_status === "draft");
      check();
      if (visibility === "marketplace_public") {
        const submitted = await ui.submitAutomationAssetReview({ listingVersionId: versionId, submissionNotes: notes || null });
        check();
        requireResult(submitted.ok, submitted.listing_version_id, versionId);
        const reviewId = requireResult(submitted.ok, submitted.review_id);
        destination = `/reviews?id=${encodeURIComponent(reviewId)}&detail_open=1`;
        await readBack(ui, "automation_asset_reviews", reviewId, row => row.listing_version_id === versionId && row.review_status === "pending");
        check();
        await readBack(ui, "automation_asset_listings", listingId, row => matchesRoot(row, "submitted"));
        check();
        await readBack(ui, "automation_asset_listing_versions", versionId, row => row.publication_status === "submitted");
        check();
      } else {
        const published = await ui.publishAutomationAssetVersion({ listingVersionId: versionId, visibility });
        check();
        requireResult(published.ok, published.listing_version_id, versionId);
        await readBack(ui, "automation_asset_listings", listingId, row => row.latest_listing_version_id === versionId && row.publication_status === "approved" && row.visibility === visibility);
        check();
        await readBack(ui, "automation_asset_listing_versions", versionId, row => row.publication_status === "approved");
        check();
      }
      const href = marketplaceHref(props.appBasePath, destination);
      if (!href) throw new Error();
      router.push(href); router.refresh();
      return t(visibility === "marketplace_public" ? "reviewSubmitted" : "published");
    });
  }}>
    {props.defaultListingId ? <div className="space-y-2"><input type="hidden" name="listing_id" value={props.defaultListingId} /><p>{t("newVersionHint")} <code>{props.defaultListingId}</code></p></div> : null}
    <div className="grid gap-4 md:grid-cols-2"><Choice name="asset_kind" label={t("assetKind")} value={assetKind} onChange={setAssetKind} options={["workflow_template", "integration_plugin"]} disabled={disabled} /><Choice name="visibility" label={t("visibility")} value={visibility} onChange={setVisibility} options={["private", "tenant_shared", "marketplace_public"]} disabled={disabled} /></div>
    <Field name="source_id" label={t("sourceId")} value={sourceId} onChange={setSourceId} disabled={disabled} required />
    <Field name="title" label={t("listingTitle")} value={title} onChange={setTitle} disabled={disabled} />
    <Field name="summary" label={t("summary")} value={summary} onChange={setSummary} disabled={disabled} />
    <Field name="notes" label={t("notes")} value={notes} onChange={setNotes} disabled={disabled} rows={3} />
    <Field name="manifest" label={t("manifest")} value={manifest} onChange={setManifest} disabled={disabled} rows={14} required />
    <Field name="docs" label={t("docs")} value={docs} onChange={setDocs} disabled={disabled} rows={5} required />
    <MarketplaceFeedback {...action} />
    <Button type="submit" disabled={disabled}>{t("createListing")}</Button>
    <MarketplaceCancel appBasePath={props.appBasePath} pending={action.pending} />
  </form>;
}
