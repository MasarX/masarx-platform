"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox } from "@masarx/ui";
import { Choice, Field, MarketplaceCancel, MarketplaceFeedback, jsonObject, marketplaceHref, readBack, requireResult, useMarketplaceAction, type MarketplaceFormProps } from "./marketplace-form";

type Props = MarketplaceFormProps & { defaultListingVersionId?: string | null; defaultTargetScopeType?: string | null; defaultTargetScopeId?: string | null };
export function AutomationMarketplaceInstallForm(props: Props) {
  const router = useRouter();
  const [listingVersionId, setVersion] = React.useState(props.defaultListingVersionId ?? "");
  const [scopeType, setScopeType] = React.useState(["tenant", "client", "sender"].includes(props.defaultTargetScopeType ?? "") ? props.defaultTargetScopeType! : "tenant");
  const [scopeId, setScopeId] = React.useState(props.defaultTargetScopeId ?? "");
  const [variables, setVariables] = React.useState("{}");
  const [bindings, setBindings] = React.useState("{}");
  const [activate, setActivate] = React.useState(false);
  const activationHintId = React.useId();
  const action = useMarketplaceAction(props, "automation_marketplace.install", props.defaultListingVersionId ?? "");
  const { t } = action;
  const disabled = action.pending || !action.allowed;
  return <form method="post" className="space-y-4" data-testid="automation-marketplace-install-form" onSubmit={event => {
    event.preventDefault();
    void action.run(async (ui, check) => {
      const result = await ui.installAutomationAsset({ listingVersionId: listingVersionId.trim(), targetScopeType: scopeType, targetScopeId: scopeId.trim(), variableValues: jsonObject(variables), connectionBindings: jsonObject(bindings), activate });
      check();
      const installId = requireResult(result.ok, result.install_id);
      const row = await readBack(ui, "automation_asset_installs", installId, row => row.install_status === "installed" && row.installed_from_listing_version_id === listingVersionId.trim() && row.target_scope_type === scopeType && row.target_scope_id === scopeId.trim());
      check();
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata as Record<string, unknown> : null;
      const activation = metadata?.activation_result && typeof metadata.activation_result === "object" ? metadata.activation_result as Record<string, unknown> : null;
      if (activate && (result.activation_result?.activated !== true || activation?.activated !== true)) throw new Error("activation_unconfirmed");
      const href = marketplaceHref(props.appBasePath, `/installs/manage?install_id=${encodeURIComponent(installId)}`);
      if (!href) throw new Error();
      router.push(href); router.refresh();
      return t("installed");
    });
  }}>
    <Field name="listing_version_id" label={t("listingVersionId")} value={listingVersionId} onChange={setVersion} disabled={disabled} required />
    <Choice name="target_scope_type" label={t("targetScopeType")} value={scopeType} onChange={setScopeType} options={["tenant", "client", "sender"]} disabled={disabled} />
    <Field name="target_scope_id" label={t("targetScopeId")} value={scopeId} onChange={setScopeId} disabled={disabled} required />
    <Field name="variables" label={t("variables")} value={variables} onChange={setVariables} rows={8} disabled={disabled} required />
    <Field name="bindings" label={t("bindings")} value={bindings} onChange={setBindings} rows={8} disabled={disabled} required />
    <p id={activationHintId}>{t("activationHint")}</p>
    <label className="flex items-center gap-3"><Checkbox name="activate" checked={activate} onChange={event => setActivate(event.target.checked)} disabled={disabled} aria-describedby={activationHintId} /><span>{t("activate")}</span></label>
    <MarketplaceFeedback {...action} />
    <Button type="submit" disabled={disabled}>{t("installCopy")}</Button>
    <MarketplaceCancel appBasePath={props.appBasePath} pending={action.pending} />
  </form>;
}
