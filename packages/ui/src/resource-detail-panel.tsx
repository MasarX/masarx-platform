"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "./drawer";
import { stripBasePath } from "./navigation-paths";
import { resolveSafeAppBasePath } from "./url-guard";

const DESKTOP_QUERY = "(min-width: 768px)";

function useIsDesktop() {
  const [isDesktop, setIsDesktop] = React.useState(() => {
    if (typeof window === "undefined") return true;
    return window.matchMedia(DESKTOP_QUERY).matches;
  });

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia(DESKTOP_QUERY);
    const handleChange = () => setIsDesktop(media.matches);
    handleChange();
    if (media.addEventListener) {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }
    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, []);

  return isDesktop;
}

type ResourceDetailPanelProps = {
  open: boolean;
  title: string;
  detailToggleHref?: string | null;
  appBasePath?: string;
  onClose?: () => void;
  children: React.ReactNode;
};

export function ResourceDetailPanel({
  open,
  title,
  detailToggleHref,
  appBasePath,
  onClose,
  children,
}: ResourceDetailPanelProps) {
  const router = useRouter();
  const isDesktop = useIsDesktop();
  const [drawerOpen, setDrawerOpen] = React.useState(open && !isDesktop);
  const safeBasePath = React.useMemo(
    () => resolveSafeAppBasePath(appBasePath ?? ""),
    [appBasePath]
  );
  const routerHref = React.useMemo(
    () =>
      detailToggleHref
        ? stripBasePath(detailToggleHref, safeBasePath ?? undefined)
        : null,
    [detailToggleHref, safeBasePath]
  );

  React.useEffect(() => {
    setDrawerOpen(open && !isDesktop);
  }, [open, isDesktop]);

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (isDesktop) return;
      setDrawerOpen(nextOpen);
      if (nextOpen === open) return;
      if (onClose && !nextOpen) {
        onClose();
        return;
      }
      if (!routerHref) return;
      router.push(routerHref);
    },
    [isDesktop, onClose, open, router, routerHref]
  );

  if (isDesktop) {
    return (
      <aside aria-label={title} className="h-full overflow-y-auto md:sticky md:top-4 md:max-h-[calc(100vh-6.5rem)]">
        <div className="space-y-3 rounded-xl border border-ui-accent/20 bg-ui-surface p-5 shadow-soft ring-1 ring-ui-accent/10">
          {children}
        </div>
      </aside>
    );
  }

  return (
    <Drawer open={drawerOpen} onOpenChange={handleOpenChange}>
      <DrawerContent
        side="right"
        aria-describedby={undefined}
        className="w-full max-w-[min(100vw,38rem)] p-4 sm:p-5"
      >
        <DrawerHeader>
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
        </DrawerHeader>
        <div className="space-y-3">{children}</div>
      </DrawerContent>
    </Drawer>
  );
}
