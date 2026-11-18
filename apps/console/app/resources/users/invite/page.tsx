import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getVerifiedAccessToken } from "@masarx/auth";
import { withConsoleConfig } from "../../../app-context";
import { TenantUserInviteForm, type InviteOptions } from "../invite-form";

export default withConsoleConfig(async ({ appBasePath }) => {
  const t = await getTranslations("ui.tenantUsers");
  const { client, user, error } = await getVerifiedAccessToken({ allowCookieSet: false });
  const result = !error && user ? await client.rpc("tenant_user_invite_options_v1") : null;
  const noOptions = result?.data?.user_types?.length === 0 || result?.data?.roles?.length === 0;
  const state = error || !user ? "auth-required"
    : result?.error?.code === "42501" ? "blocked"
    : !result?.data || result.error ? "error" : noOptions ? "blocked" : "ready";
  return <section className="space-y-6" data-testid={`console-tenant-user-invite-${state}`}>
    <Link className="text-sm text-ui-accent underline underline-offset-4" href={`${appBasePath}/resources/users`}>{t("back")}</Link>
    <h1 className="text-2xl font-semibold text-ui-ink">{t("invite")}</h1>
    {!result?.data || result.error || noOptions ? <p role="alert">{t(noOptions ? "noOptions" : "forbidden")}</p>
      : <TenantUserInviteForm endpoint={`${appBasePath}/api/tenant-user-invite`} options={result.data as InviteOptions} />}
  </section>;
});
