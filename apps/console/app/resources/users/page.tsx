import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getVerifiedAccessToken } from "@masarx/auth";
import { Button } from "@masarx/ui";
import { ResourcePage } from "../../_components/resource-page";
import { withConsoleConfig } from "../../app-context";
import { TenantUserInviteForm } from "./invite-form";

type Props = { searchParams: Record<string, string | string[] | undefined> };
export default withConsoleConfig<Props>(async ({ appKey, appBasePath }, { searchParams }) => {
  const t = await getTranslations("ui.tenantUsers");
  const { client, user, error } = await getVerifiedAccessToken({ allowCookieSet: false });
  const authority = !error && user ? await client.rpc("tenant_user_invite_options_v1") : null;
  const canManage = authority !== null && !authority.error;
  return <ResourcePage appKey={appKey} appBasePath={appBasePath} resourceKey="users"
    searchParams={searchParams} testIdPrefix="console-resource"
    headerActionsCapability="users.manage"
    headerActions={canManage ? <Button asChild><Link href={`${appBasePath}/resources/users/invite`}>{t("invite")}</Link></Button> : null}
    renderDetailFooter={({ detail, detailError, detailId }) => canManage && detail && !detailError
      ? <TenantUserInviteForm endpoint={`${appBasePath}/api/tenant-user-invite`} targetUserId={detailId} /> : null} />;
});
