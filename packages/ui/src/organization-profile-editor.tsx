import "server-only";
import { createUiServerClient } from "@masarx/api/server";
import { hasCapability, resolveCapabilitySet } from "./capabilities";
import { createUiTranslator } from "./i18n";
import { OrganizationProfileForm } from "./organization-profile-form";

export async function OrganizationProfileEditor({ organizationId }: { organizationId: string }) {
  const t = createUiTranslator("ui.organizationProfile");
  let me;
  try {
    me = await createUiServerClient().me();
  } catch {
    return <p className="text-sm text-ui-muted" role="status">{t("loadFailed")}</p>;
  }
  if (!me.user?.id || !hasCapability(resolveCapabilitySet(me.capabilities), "organizations.write")) {
    return <p className="text-sm text-ui-muted" role="status">{t("readOnly")}</p>;
  }
  return <OrganizationProfileForm key={`${me.user.id}:${organizationId}`} organizationId={organizationId} />;
}
