"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "./button";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "./drawer";
import { ResourceImportPage } from "./resource-import-page";
import { buildHref } from "./url";

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
  const [open, setOpen] = React.useState(false);
  const [refreshOnClose, setRefreshOnClose] = React.useState(false);
  const standaloneHref = React.useMemo(
    () =>
      buildHref(`${appBasePath}/imports/new`, {
        resource: resourceKey,
        return_to: returnTo || undefined,
      }),
    [appBasePath, resourceKey, returnTo],
  );

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen && refreshOnClose) {
        setRefreshOnClose(false);
        router.refresh();
      }
    },
    [refreshOnClose, router],
  );

  if (!allowed) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled
        title={disabledReason ?? undefined}
      >
        Import
      </Button>
    );
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => handleOpenChange(true)}
        data-testid={testIdPrefix ? `${testIdPrefix}-launcher` : undefined}
      >
        Import
      </Button>

      <Drawer open={open} onOpenChange={handleOpenChange}>
        <DrawerContent
          side="right"
          className="w-[min(100vw,1120px)] max-w-[min(100vw,1120px)] overflow-y-auto p-0"
        >
          <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-ui-border/40 bg-ui-paper/95 px-5 py-4 backdrop-blur">
            <DrawerHeader className="min-w-0">
              <DrawerTitle>Universal import</DrawerTitle>
              <DrawerDescription>
                Stay on the current table, upload a file, review the dry-run, and approve the import without leaving the page.
              </DrawerDescription>
            </DrawerHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="ghost">
                <a href={standaloneHref}>Open full page</a>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
              >
                Close
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
              onReportReady={() => setRefreshOnClose(true)}
            />
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
