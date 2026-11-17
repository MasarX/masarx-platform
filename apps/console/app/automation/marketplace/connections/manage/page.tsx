import { PageHeader, Section, createUiTranslator } from "@masarx/ui";
import { withConsoleConfig } from "../../../../app-context";
import { MarketplacePage, first, unavailable, valueText, type MarketplacePageProps } from "../../_components/marketplace-page";
import { AutomationMarketplaceConnectionForm } from "../../_components/connection-form";
export default withConsoleConfig<MarketplacePageProps>(({ appBasePath }, { searchParams }) => {
  const t = createUiTranslator("ui.automationMarketplace");
  return <MarketplacePage capability="automation_marketplace.manage_connections">{async (access, ui) => {
    const id = first(searchParams.connection_id);
    const row = id ? await ui.getResource("integration_connections", id) : null;
    if (id && row?.id !== id) return unavailable();
    const oauth = id && row?.auth_type === "oauth2_authorization_code_pkce" ? await ui.rpc<{ configured: boolean; connection_id?: string }>("integration_connection_oauth_context_v1", { p_connection_id: id }).catch(() => null) : null;
    return <div className="space-y-6" data-testid="console-automation-marketplace-connections-manage-ready"><PageHeader title={t(id ? "manageConnection" : "newConnection")} description={t("connectionDescription")} /><Section><AutomationMarketplaceConnectionForm key={`${access.userId}/${id ?? "new"}`} access={access} appBasePath={appBasePath} defaultConnectionId={id} defaultOwnerScopeType={valueText(row?.owner_scope_type)} defaultOwnerScopeId={valueText(row?.owner_scope_id)} defaultProviderId={valueText(row?.provider_id)} defaultProviderKey={valueText(row?.provider_key)} defaultName={valueText(row?.name)} defaultAuthType={valueText(row?.auth_type)} defaultSecretStorageMode={valueText(row?.secret_storage_mode)} defaultStatus={valueText(row?.status)} defaultRuntimeAuthConfigId={valueText(row?.runtime_auth_config_id)} defaultExpiresAt={valueText(row?.expires_at)} defaultLastTestedAt={valueText(row?.last_tested_at)} defaultLastRotatedAt={valueText(row?.last_rotated_at)} defaultRevokedAt={valueText(row?.revoked_at)} defaultOauthConfigured={oauth?.configured === true && oauth.connection_id === id} /></Section></div>;
  }}</MarketplacePage>;
});
