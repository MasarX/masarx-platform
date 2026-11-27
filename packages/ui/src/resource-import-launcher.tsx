"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "./button";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "./drawer";
import { ResourceImportPage } from "./resource-import-page";
import { createUiTranslator } from "./i18n";
import { buildHref } from "./url";
import { useResourceListInvalidate } from "./hooks/use-resource-query";
import { useToast } from "./use-toast";
import { buildResourceImportRecordHref } from "./resource-import-handoff";

type ResourceImportLauncherProps = {
  appBasePath: string;
  resourceKey: string;
  allowed: boolean;
  disabledReason?: string | null;
  returnTo?: string | null;
  testIdPrefix?: string | null;
};

export function ResourceImportLauncher({
  appBasePath,
  resourceKey,
  allowed,
  disabledReason,
  returnTo,
  testIdPrefix,
}: ResourceImportLauncherProps) {
  const router = useRouter();
  const t = createUiTranslator("ui.resourcePage");
  const tl = createUiTranslator("ui.resourceImport.launcher");
  const invalidateResourceList = useResourceListInvalidate(resourceKey);
  const { toast } = useToast();
  const reasonId = React.useId();
  const normalizedDisabledReason = disabledReason?.trim() ?? "";
  const [open, setOpen] = React.useState(false);
  const openImportedRecord = React.useCallback((resource: string, id: string) => {
    const href = buildResourceImportRecordHref(appBasePath, resource, id, returnTo);
    if (!href) return;
    setOpen(false);
    router.push(href);
  }, [appBasePath, returnTo, router]);
  const standaloneHref = React.useMemo(
    () =>
      buildHref(`${appBasePath}/imports/new`, {
        resource: resourceKey,
        return_to: returnTo || undefined,
      }),
    [appBasePath, resourceKey, returnTo],
  );

  const handleReportReady = () => {
    void invalidateResourceList().catch(() => {
      toast({
        title: tl("refreshFailedTitle"),
        description: tl("refreshFailedDescription"),
        tone: "error",
      });
    });
  };

  if (!allowed) {
    return (
      <>
        <Button type="button" size="sm" variant="ghost" disabled
          title={normalizedDisabledReason || undefined}
          aria-describedby={normalizedDisabledReason ? reasonId : undefined}>
          {t("actions.import")}
        </Button>
        {normalizedDisabledReason ? <span id={reasonId} className="sr-only">{normalizedDisabledReason}</span> : null}
      </>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid={testIdPrefix ? `${testIdPrefix}-launcher` : undefined}
      >
        {t("actions.import")}
      </Button>

      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent
          side="right"
          className="w-[min(100vw,1120px)] max-w-[min(100vw,1120px)] overflow-y-auto p-0"
        >
          <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-ui-border/40 bg-ui-paper/95 px-5 py-4 backdrop-blur">
            <DrawerHeader className="min-w-0">
              <DrawerTitle>{tl("title")}</DrawerTitle>
              <DrawerDescription>
                {tl("description")}
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="ghost">
                <a href={standaloneHref}>{tl("openFullPage")}</a>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                {tl("close")}
              </Button>
            </div>
          </div>

          <div className="p-5">
            <ResourceImportPage
              appBasePath={appBasePath}
              initialResourceKey={resourceKey}
              initialReturnTo={returnTo}
              presentation="drawer"
              testIdPrefix={testIdPrefix}
              onReportReady={handleReportReady}
              onOpenImportedRecord={openImportedRecord}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
