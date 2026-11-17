"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@masarx/ui";
import { Choice, Field, MarketplaceCancel, MarketplaceFeedback, marketplaceHref, readBack, requireResult, text, useMarketplaceAction, type MarketplaceFormProps } from "./marketplace-form";

export function AutomationMarketplaceReviewDecisionForm(props: MarketplaceFormProps & { defaultReviewId?: string | null }) {
  const router = useRouter();
  const [reviewId, setReviewId] = React.useState(props.defaultReviewId ?? "");
  const [decision, setDecision] = React.useState("approved");
  const [notes, setNotes] = React.useState("");
  const action = useMarketplaceAction(props, "automation_marketplace.review", props.defaultReviewId ?? "");
  const { t } = action;
  const disabled = action.pending || !action.allowed;
  return <form method="post" className="space-y-4" data-testid="automation-marketplace-review-decision-form" onSubmit={event => {
    event.preventDefault();
    void action.run(async (ui, check) => {
      const result = await ui.decideAutomationAssetReview({ reviewId: reviewId.trim(), decision, decisionNotes: notes || null });
      check();
      requireResult(result.ok, result.review_id, reviewId.trim());
      const review = await readBack(ui, "automation_asset_reviews", reviewId.trim(), row => row.review_status === decision);
      check();
      const versionId = text(review.listing_version_id);
      if (!versionId) throw new Error();
      const version = await readBack(ui, "automation_asset_listing_versions", versionId, row => row.publication_status === decision);
      check();
      const listingId = text(version.listing_id);
      await readBack(ui, "automation_asset_listings", listingId, row => decision === "approved" ? row.publication_status === "approved" && row.latest_listing_version_id === versionId : row.latest_listing_version_id === versionId ? row.publication_status === "rejected" : row.publication_status === "approved");
      check();
      const href = marketplaceHref(props.appBasePath, `/reviews?id=${encodeURIComponent(reviewId.trim())}&detail_open=1`);
      if (!href) throw new Error();
      router.push(href); router.refresh();
      return t("reviewSaved");
    });
  }}>
    <Field name="review_id" label={t("reviewId")} value={reviewId} onChange={setReviewId} required disabled={disabled} />
    <Choice name="decision" label={t("decision")} value={decision} onChange={setDecision} options={["approved", "rejected"]} disabled={disabled} />
    <Field name="notes" label={t("decisionNotes")} value={notes} onChange={setNotes} rows={5} disabled={disabled} />
    <MarketplaceFeedback {...action} />
    <Button type="submit" disabled={disabled}>{t("applyDecision")}</Button>
    <MarketplaceCancel appBasePath={props.appBasePath} pending={action.pending} path="/reviews" />
  </form>;
}
