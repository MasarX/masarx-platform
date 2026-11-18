"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button, resolveSafeHref } from "@masarx/ui";
import { Field, MarketplaceFeedback, jsonObject, readBack, requireResult, text, useMarketplaceAction, type MarketplaceFormProps } from "./marketplace-form";

type Props = MarketplaceFormProps & { defaultInstallId?: string | null; defaultStatus?: string | null; defaultCurrentListingVersionId?: string | null; defaultInstalledFromListingVersionId?: string | null; defaultInstalledResourceType?: string | null; defaultInstalledResourceId?: string | null; defaultForkedAt?: string | null; defaultUpgradeAvailable?: boolean | null; defaultPendingPluginVersionId?: string | null };
type Preview = { current: string; target: string; changes: boolean; forked: boolean };
export function AutomationMarketplaceInstallManageForm(props: Props) {
  const router = useRouter();
  const [installId, setInstallId] = React.useState(props.defaultInstallId ?? "");
  const [target, setTarget] = React.useState("");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [bindingKey, setBindingKey] = React.useState("");
  const [connectionId, setConnectionId] = React.useState("");
  const [bindingType, setBindingType] = React.useState("connection");
  const [config, setConfig] = React.useState("{}");
  const busy = React.useRef(false);
  const action = useMarketplaceAction(props, "automation_marketplace.upgrade", props.defaultInstallId ?? "", busy);
  const bindAction = useMarketplaceAction(props, "automation_marketplace.manage_connections", props.defaultInstallId ?? "", busy);
  const { t } = action;
  const pending = action.pending || bindAction.pending;
  const disabled = pending || !action.allowed;
  function upgrade(kind: "preview" | "apply" | "fork") {
    void action.run(async (ui, check) => {
      if (kind === "preview") {
        const result = await ui.previewAutomationAssetUpgrade({ installId: installId.trim(), targetListingVersionId: target.trim() || null });
        check(); requireResult(result.ok, result.install_id, installId.trim());
        const current = text(result.current_listing_version_id);
        const targetVersion = text(result.target_listing_version_id);
        if (!current || !targetVersion || (target.trim() && targetVersion !== target.trim())) throw new Error();
        await readBack(ui, "automation_asset_installs", installId.trim(), row => row.current_listing_version_id === current);
        check();
        setPreview({ current, target: targetVersion, changes: result.has_changes === true, forked: result.forked === true });
        router.refresh();
        return t("previewReady");
      }
      if (kind === "apply") {
        if (!preview || preview.forked || !preview.changes) throw new Error();
        await readBack(ui, "automation_asset_installs", installId.trim(), row => row.current_listing_version_id === preview.current && !row.forked_at);
        check();
        await readBack(ui, "automation_asset_listing_versions", preview.target, row => row.publication_status === "approved");
        check();
        const result = await ui.applyAutomationAssetUpgrade({ installId: installId.trim(), targetListingVersionId: preview.target });
        check(); requireResult(result.ok, result.install_id, installId.trim());
        const installed = await readBack(ui, "automation_asset_installs", installId.trim(), row => row.current_listing_version_id === preview.target && row.install_status === "installed");
        check();
        if (installed.installed_resource_type === "integration_plugin") {
          const staged = requireResult(result.runtime_activated === false, result.staged_plugin_version_id);
          const metadata = installed.metadata && typeof installed.metadata === "object" ? installed.metadata as Record<string, unknown> : null;
          if (metadata?.pending_plugin_version_id !== staged || !text(installed.installed_resource_id)) throw new Error();
          await readBack(ui, "integration_plugin_versions", staged, row => row.plugin_id === installed.installed_resource_id && row.status === "approved");
          check(); setPreview(null); router.refresh(); return t("upgradeCopied");
        }
        if (installed.installed_resource_type !== "workflow_template") throw new Error();
        setPreview(null); router.refresh(); return t("upgradeApplied");
      }
      const result = await ui.forkAutomationAssetInstall({ installId: installId.trim() });
      check(); requireResult(result.ok, result.install_id, installId.trim());
      await readBack(ui, "automation_asset_installs", installId.trim(), row => row.install_status === "forked" && Boolean(text(row.forked_at)));
      check(); setPreview(null); router.refresh();
      return t("forked");
    });
  }
  const stagedHref = props.defaultInstalledResourceType === "integration_plugin" && props.defaultInstalledResourceId && props.defaultPendingPluginVersionId ? resolveSafeHref(props.appBasePath, `/integrations/plugins/${encodeURIComponent(props.defaultInstalledResourceId)}/versions/${encodeURIComponent(props.defaultPendingPluginVersionId)}`) : null;
  return <div className="space-y-6" data-testid="automation-marketplace-install-manage-form">
    <dl className="grid gap-3 break-words text-sm md:grid-cols-2" data-testid="automation-marketplace-install-manage-state">
      <div><dt>{t("status")}</dt><dd>{["installed", "forked", "pending"].includes(props.defaultStatus ?? "") ? t(`options.${props.defaultStatus}`) : t("unknown")}</dd></div>
      <div><dt>{t("currentVersion")}</dt><dd data-testid="automation-marketplace-install-current-version">{props.defaultCurrentListingVersionId || t("unknown")}</dd></div>
      <div><dt>{t("originVersion")}</dt><dd>{props.defaultInstalledFromListingVersionId || t("unknown")}</dd></div>
      <div><dt>{t("installedResource")}</dt><dd>{props.defaultInstalledResourceId || t("unknown")}</dd></div>
      <div><dt>{t("forked")}</dt><dd>{t(props.defaultForkedAt ? "yes" : "no")}</dd></div>
      <div><dt>{t("upgradeAvailable")}</dt><dd data-testid="automation-marketplace-install-upgrade-available">{t(props.defaultUpgradeAvailable === true ? "yes" : props.defaultUpgradeAvailable === false ? "no" : "unknown")}</dd></div>
    </dl>
    {stagedHref ? <p>{t("upgradeCopied")} <a className="underline underline-offset-4" href={stagedHref}>{t("openStagedVersion")}</a></p> : null}
    <Field name="install_id" label={t("installId")} value={installId} onChange={value => { setInstallId(value); setPreview(null); }} disabled={pending} required />
    <Field name="target_version" label={t("targetVersion")} value={target} onChange={value => { setTarget(value); setPreview(null); }} disabled={pending} />
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={disabled || !installId.trim()} onClick={() => upgrade("preview")}>{t("previewUpgrade")}</Button><Button type="button" disabled={disabled || !preview?.changes || preview.forked} onClick={() => upgrade("apply")}>{t("applyUpgrade")}</Button><Button type="button" variant="ghost" disabled={disabled || !installId.trim()} onClick={() => upgrade("fork")}>{t("markForked")}</Button></div>
    {preview ? <dl role="status" className="break-words text-sm" data-testid="automation-marketplace-upgrade-preview"><dt>{t("currentVersion")}</dt><dd>{preview.current}</dd><dt>{t("targetVersion")}</dt><dd>{preview.target}</dd><dt>{t("hasChanges")}</dt><dd>{t(preview.changes ? "yes" : "no")}</dd><dt>{t("forked")}</dt><dd>{t(preview.forked ? "yes" : "no")}</dd></dl> : null}
    <MarketplaceFeedback {...action} />
    <form method="post" className="space-y-4" onSubmit={event => {
      event.preventDefault(); if (pending) return;
      void bindAction.run(async (ui, check) => {
        const result = await ui.bindIntegrationConnectionInstall({ installId: installId.trim(), bindingKey: bindingKey.trim(), connectionId: connectionId.trim(), bindingType: bindingType.trim(), config: jsonObject(config) });
        check(); requireResult(result.ok, result.install_id, installId.trim()); requireResult(result.ok, result.connection_id, connectionId.trim());
        const id = requireResult(result.ok, result.binding_id);
        await readBack(ui, "automation_asset_install_bindings", id, row => row.install_id === installId.trim() && row.connection_id === connectionId.trim() && row.binding_key === bindingKey.trim());
        check(); router.refresh(); return t("bindingSaved");
      });
    }}><h2 className="text-base font-semibold">{t("bindConnection")}</h2><p>{t("bindingCopyHint")}</p>
      <Field name="binding_key" label={t("bindingKey")} value={bindingKey} onChange={setBindingKey} required disabled={pending || !bindAction.allowed} />
      <Field name="connection_id" label={t("connectionId")} value={connectionId} onChange={setConnectionId} required disabled={pending || !bindAction.allowed} />
      <Field name="binding_type" label={t("bindingType")} value={bindingType} onChange={setBindingType} required disabled={pending || !bindAction.allowed} />
      <Field name="binding_config" label={t("bindingConfig")} value={config} onChange={setConfig} rows={5} disabled={pending || !bindAction.allowed} />
      <MarketplaceFeedback {...bindAction} /><Button type="submit" disabled={pending || !bindAction.allowed || !installId.trim()}>{t("bindConnection")}</Button>
    </form>
  </div>;
}
