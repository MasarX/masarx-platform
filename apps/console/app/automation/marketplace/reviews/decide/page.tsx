import { PageHeader, Section, createUiTranslator } from "@masarx/ui";
import { withConsoleConfig } from "../../../../app-context";
import { MarketplacePage, first, type MarketplacePageProps } from "../../_components/marketplace-page";
import { AutomationMarketplaceReviewDecisionForm } from "../../_components/review-decision-form";
export default withConsoleConfig<MarketplacePageProps>(({ appBasePath }, { searchParams }) => {
  const t = createUiTranslator("ui.automationMarketplace");
  return <MarketplacePage capability="automation_marketplace.review">{access => <div className="space-y-6" data-testid="console-automation-marketplace-reviews-decide-ready"><PageHeader title={t("decideReview")} description={t("reviewDescription")} /><Section><AutomationMarketplaceReviewDecisionForm key={`${access.userId}/${first(searchParams.review_id)}`} access={access} appBasePath={appBasePath} defaultReviewId={first(searchParams.review_id)} /></Section></div>}</MarketplacePage>;
});
