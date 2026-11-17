"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { cn } from "./utils";

type ResourcePageSplitLayoutProps = {
  enabled: boolean;
  storageKey: string;
  defaultDetailWidth?: number;
  minDetailWidth?: number;
  maxDetailWidth?: number;
  testIdPrefix?: string | null;
  table: React.ReactNode;
  detail: React.ReactNode;
};

function clampWidth(value: number, bounds: { min: number; max: number }) {
  if (!Number.isFinite(value)) return bounds.min;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

function resolveWidthBounds(params: {
  minDetailWidth: number;
  maxDetailWidth: number;
  containerWidth: number;
}) {
  const { minDetailWidth, maxDetailWidth, containerWidth } = params;
  const minLeftPreferred = Math.floor(containerWidth * 0.3);
  const minLeft = Math.max(240, Math.min(420, minLeftPreferred));
  const maxFromContainer = Math.max(
    minDetailWidth,
    Math.floor(containerWidth - minLeft)
  );
  const max = Math.min(maxDetailWidth, maxFromContainer);
  return {
    min: Math.min(minDetailWidth, max),
    max: Math.max(minDetailWidth, max),
  };
}

function resolveAutoDetailWidth(params: {
  minDetailWidth: number;
  maxDetailWidth: number;
  containerWidth: number;
}) {
  const { minDetailWidth, maxDetailWidth, containerWidth } = params;
  const bounds = resolveWidthBounds({ minDetailWidth, maxDetailWidth, containerWidth });
  const preferredWidth = Math.round(containerWidth * 0.36);
  return clampWidth(preferredWidth, bounds);
}

function readStoredWidth(storageKey: string) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistWidth(storageKey: string, width: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // ignore storage failures
  }
}

export function ResourcePageSplitLayout({
  enabled,
  storageKey,
  defaultDetailWidth = 440,
  minDetailWidth = 320,
  maxDetailWidth = 960,
  testIdPrefix,
  table,
  detail,
}: ResourcePageSplitLayoutProps) {
  const t = useTranslations("ui.resourcePage.detail");
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const widthRef = React.useRef(defaultDetailWidth);
  const widthModeRef = React.useRef<"auto" | "stored" | "manual">("auto");
  const dragRef = React.useRef<
    | { mode: "pointer"; rect: DOMRect; pointerId: number }
    | { mode: "mouse"; rect: DOMRect }
    | null
  >(null);
  const [detailWidth, setDetailWidth] = React.useState(defaultDetailWidth);
  const [isDragging, setIsDragging] = React.useState(false);

  const resizerTestId = testIdPrefix ? `${testIdPrefix}-detail-resizer` : undefined;
  const panelTestId = testIdPrefix
    ? `${testIdPrefix}-detail-panel-container`
    : undefined;

  React.useEffect(() => {
    widthRef.current = detailWidth;
  }, [detailWidth]);

  const clampToContainer = React.useCallback(
    (candidate: number, rect: DOMRect | null) => {
      const measuredWidth = rect?.width ?? 0;
      const containerWidth =
        measuredWidth > 0 ? measuredWidth : window.innerWidth;
      const bounds = resolveWidthBounds({
        minDetailWidth,
        maxDetailWidth,
        containerWidth,
      });
      return clampWidth(candidate, bounds);
    },
    [maxDetailWidth, minDetailWidth]
  );

  const resolveAutoWidth = React.useCallback(
    (rect: DOMRect | null) => {
      const measuredWidth = rect?.width ?? 0;
      const containerWidth = measuredWidth > 0 ? measuredWidth : window.innerWidth;
      return resolveAutoDetailWidth({
        minDetailWidth,
        maxDetailWidth,
        containerWidth,
      });
    },
    [maxDetailWidth, minDetailWidth]
  );

  const setClampedWidth = React.useCallback((next: number) => {
    widthRef.current = next;
    setDetailWidth(next);
  }, []);

  React.useEffect(() => {
    const rect = containerRef.current?.getBoundingClientRect() ?? null;
    const stored = readStoredWidth(storageKey);
    if (stored === null) {
      widthModeRef.current = "auto";
      setClampedWidth(resolveAutoWidth(rect));
      return;
    }
    widthModeRef.current = "stored";
    setClampedWidth(clampToContainer(stored, rect));
  }, [clampToContainer, resolveAutoWidth, setClampedWidth, storageKey]);

  React.useEffect(() => {
    const handleResize = () => {
      const rect = containerRef.current?.getBoundingClientRect() ?? null;
      if (widthModeRef.current === "auto") {
        const preferred = resolveAutoWidth(rect);
        if (preferred !== widthRef.current) {
          setClampedWidth(preferred);
        }
        return;
      }
      const next = clampToContainer(widthRef.current, rect);
      if (next !== widthRef.current) {
        setClampedWidth(next);
      }
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [clampToContainer, resolveAutoWidth, setClampedWidth]);

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      if (event.pointerType === "mouse") return;
      const rect = containerRef.current?.getBoundingClientRect() ?? null;
      if (!rect) return;
      dragRef.current = { mode: "pointer", rect, pointerId: event.pointerId };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      setIsDragging(true);
      document.body.style.userSelect = "none";
    },
    []
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode !== "pointer") return;
      if (event.pointerId !== drag.pointerId) return;
      const nextWidth = drag.rect.right - event.clientX;
      setClampedWidth(clampToContainer(nextWidth, drag.rect));
    },
    [clampToContainer, setClampedWidth]
  );

  const stopDragging = React.useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    setIsDragging(false);
    widthModeRef.current = "manual";
    persistWidth(storageKey, widthRef.current);
  }, [storageKey]);

  const handlePointerUp = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!dragRef.current) return;
      if (dragRef.current.mode !== "pointer") return;
      if (event.pointerId !== dragRef.current.pointerId) return;
      stopDragging();
    },
    [stopDragging]
  );

  const handleLostPointerCapture = React.useCallback(() => {
    stopDragging();
  }, [stopDragging]);

  const handleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      if (dragRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect() ?? null;
      if (!rect) return;
      dragRef.current = { mode: "mouse", rect };
      event.preventDefault();
      setIsDragging(true);
      document.body.style.userSelect = "none";

      const handleMove = (moveEvent: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        if (drag.mode !== "mouse") return;
        const nextWidth = drag.rect.right - moveEvent.clientX;
        setClampedWidth(clampToContainer(nextWidth, drag.rect));
      };

      const handleUp = () => {
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        stopDragging();
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [clampToContainer, setClampedWidth, stopDragging]
  );

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      const rect = containerRef.current?.getBoundingClientRect() ?? null;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const next = clampToContainer(widthRef.current + 24, rect);
        widthModeRef.current = "manual";
        setClampedWidth(next);
        persistWidth(storageKey, next);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = clampToContainer(widthRef.current - 24, rect);
        widthModeRef.current = "manual";
        setClampedWidth(next);
        persistWidth(storageKey, next);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const next = clampToContainer(defaultDetailWidth, rect);
        widthModeRef.current = "manual";
        setClampedWidth(next);
        persistWidth(storageKey, next);
      }
    },
    [clampToContainer, defaultDetailWidth, setClampedWidth, storageKey]
  );

  const handleDoubleClick = React.useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect() ?? null;
    const next = clampToContainer(defaultDetailWidth, rect);
    widthModeRef.current = "manual";
    setClampedWidth(next);
    persistWidth(storageKey, next);
  }, [clampToContainer, defaultDetailWidth, setClampedWidth, storageKey]);

  if (!enabled) {
    return (
      <div className="space-y-4">
        {table}
        {detail ? <div>{detail}</div> : null}
      </div>
    );
  }

  return (
    <div
      ref={containerRef as React.Ref<HTMLDivElement>}
      className="space-y-4 md:flex md:items-start md:gap-4 md:space-y-0"
    >
      <div className="space-y-3 md:min-w-0 md:flex-1">{table}</div>
      <div
        className={cn(
          "relative w-full md:flex-none md:w-[var(--ui-detail-panel-width)]",
          !isDragging && "transition-[width] duration-200 ease-out"
        )}
        style={{ ["--ui-detail-panel-width" as any]: `${detailWidth}px` }}
        data-testid={panelTestId}
      >
        <button
          type="button"
          data-testid={resizerTestId}
          aria-label={t("resizeAria")}
          title={t("resizeHint")}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onLostPointerCapture={handleLostPointerCapture}
          onMouseDown={handleMouseDown}
          onKeyDown={handleKeyDown}
          onDoubleClick={handleDoubleClick}
          className={cn(
            "hidden md:block",
            "absolute -left-3 top-0 z-30 h-full w-6 cursor-col-resize",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-ui-paper"
          )}
        >
          <span className="sr-only">{t("resizeAria")}</span>
          <span className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-ui-border/70" />
        </button>
        {detail}
      </div>
    </div>
  );
}
