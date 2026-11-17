"use client";

import type { TranslateFn } from "./types";
import type { ResourceViewEntry, SaveStatus } from "./view-types";
import { Button } from "../button";
import { Checkbox } from "../checkbox";
import { Input } from "../input";
import { ConfirmDialog } from "../confirm-dialog";

type ViewPanelProps = {
  t: TranslateFn;
  viewScopeValue?: string | null;
  settingsResolutionValue?: string | null;
  viewError?: string | null;
  canManageViews: boolean;
  activeView: ResourceViewEntry | null;
  viewsCount: number;
  saveOpen: boolean;
  deleteOpen: boolean;
  saveName: string;
  saveDefault: boolean;
  saveStatus: SaveStatus;
  saveDisabled: boolean;
  onToggleSave: () => void;
  onToggleDelete: () => void;
  onSaveNameChange: (value: string) => void;
  onSaveDefaultChange: (value: boolean) => void;
  onSaveView: (mode: "new" | "update") => void;
  onDeleteView: () => void;
  testIdPrefix?: string | null;
};

export function TableViewPanel({
  t,
  viewScopeValue,
  settingsResolutionValue,
  viewError,
  canManageViews,
  activeView,
  viewsCount,
  saveOpen,
  deleteOpen,
  saveName,
  saveDefault,
  saveStatus,
  saveDisabled,
  onToggleSave,
  onToggleDelete,
  onSaveNameChange,
  onSaveDefaultChange,
  onSaveView,
  onDeleteView,
  testIdPrefix,
}: ViewPanelProps) {
  const showEmpty = viewsCount === 0;
  const resolvedTestIdPrefix = testIdPrefix?.trim() || "";
  const panelTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-views-panel`
    : undefined;
  const updateTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-update`
    : undefined;
  const deleteToggleTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-delete-toggle`
    : undefined;
  const saveToggleTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-save-toggle`
    : undefined;
  const saveNameTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-save-name`
    : undefined;
  const saveDefaultTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-save-default`
    : undefined;
  const saveCreateTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-save-create`
    : undefined;
  const saveUpdateTestId = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-save-update-current`
    : undefined;
  const deleteDialogPrefix = resolvedTestIdPrefix
    ? `${resolvedTestIdPrefix}-view-delete`
    : undefined;

  return (
    <div className="text-sm" data-testid={panelTestId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1 text-sm text-ui-ink">
            <div className="text-xs font-medium text-ui-muted">
              {t("views.activeLabel")}
            </div>
            <div className="font-medium text-ui-ink">
              {activeView?.label ?? t("views.activeFallback")}
            </div>
          </div>
          {viewScopeValue || settingsResolutionValue ? (
            <div className="space-y-1 text-xs">
              {viewScopeValue ? (
                <>
                  <div className="text-[10px] font-medium text-ui-muted">
                    {t("views.scopeLabel")}
                  </div>
                  <div className="text-ui-ink">{viewScopeValue}</div>
                </>
              ) : null}
              {settingsResolutionValue ? (
                <>
                  <div className="text-[10px] font-medium text-ui-muted">
                    {t("views.settingsResolutionLabel")}
                  </div>
                  <div className="font-mono text-ui-ink">
                    {settingsResolutionValue}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
          {canManageViews ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onSaveView("update")}
                disabled={!activeView || saveDisabled}
                data-testid={updateTestId}
              >
                {t("views.update")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onToggleDelete}
                disabled={!activeView}
                data-testid={deleteToggleTestId}
              >
                {deleteOpen ? t("views.closeDelete") : t("views.delete")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onToggleSave}
                data-testid={saveToggleTestId}
              >
                {saveOpen ? t("views.closeSave") : t("views.saveNew")}
              </Button>
            </div>
          ) : null}
        </div>
        {!canManageViews ? (
          <span className="text-xs text-ui-muted">{t("views.disabled")}</span>
        ) : null}
      </div>
      {viewError ? (
        <div className="mt-3 rounded-lg border border-ui-border/40 bg-ui-highlight/30 p-2 text-xs text-ui-ink">
          {viewError}
        </div>
      ) : null}
      {showEmpty ? (
        <div className="mt-3 text-xs text-ui-muted">{t("views.empty")}</div>
      ) : null}
      {saveOpen ? (
        <div className="mt-4 grid gap-3">
          <label className="space-y-2 text-sm text-ui-ink">
            <span className="text-xs font-medium text-ui-muted">
              {t("views.nameLabel")}
            </span>
            <Input
              autoFocus
              value={saveName}
              onChange={(event) => onSaveNameChange(event.target.value)}
              placeholder={t("views.namePlaceholder")}
              className="w-full"
              data-testid={saveNameTestId}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-ui-ink">
            <Checkbox
              checked={saveDefault}
              onChange={(event) => onSaveDefaultChange(event.target.checked)}
              data-testid={saveDefaultTestId}
            />
            <span>{t("views.setDefault")}</span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={() => onSaveView("new")}
              disabled={saveDisabled}
              data-testid={saveCreateTestId}
            >
              {t("views.create")}
            </Button>
            {activeView ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onSaveView("update")}
                disabled={saveDisabled}
                data-testid={saveUpdateTestId}
              >
                {t("views.updateCurrent")}
              </Button>
            ) : null}
            {saveStatus.status !== "idle" ? (
              <span
                className={
                  saveStatus.status === "error"
                    ? "text-xs font-semibold text-ui-ink"
                    : "text-xs text-ui-muted"
                }
                role="status"
                aria-live="polite"
              >
                {saveStatus.message}
              </span>
            ) : null}
          </div>
        </div>
      ) : saveStatus.status !== "idle" ? (
        <div
          className={
            saveStatus.status === "error"
              ? "mt-3 text-xs font-semibold text-ui-ink"
              : "mt-3 text-xs text-ui-muted"
          }
          role="status"
          aria-live="polite"
        >
          {saveStatus.message}
        </div>
      ) : null}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={() => onToggleDelete()}
        onConfirm={onDeleteView}
        title={t("views.deleteTitle")}
        description={t("views.deleteNote")}
        confirmLabel={t("views.confirmDelete")}
        cancelLabel={t("views.cancel")}
        tone="danger"
        testIdPrefix={deleteDialogPrefix}
        actionKey="view.delete"
      />
    </div>
  );
}
