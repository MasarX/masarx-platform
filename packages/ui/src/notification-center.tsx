"use client";

import * as React from "react";
import { cn } from "./utils";
import { Badge } from "./badge";
import { createUiTranslator } from "./i18n";

export type Notification = {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  readAt?: string | null;
  createdAt: string;
};

type NotificationCenterProps = {
  notifications: Notification[];
  unreadCount: number;
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  onNotificationClick?: (notification: Notification) => void;
  className?: string;
};

const typeIcons: Record<string, string> = {
  shipment: "\uD83D\uDCE6",
  exception: "\u26A0\uFE0F",
  workflow: "\u2699\uFE0F",
  system: "\uD83D\uDD14",
};

function formatNotificationTime(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Notification center with bell icon, badge count, and dropdown panel.
 * Integrates with the context strip header.
 */
export function NotificationCenter({
  notifications,
  unreadCount,
  onMarkRead,
  onMarkAllRead,
  onNotificationClick,
  className,
}: NotificationCenterProps) {
  const t = createUiTranslator("ui.notificationCenter");
  const [open, setOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);

  // Close on click outside
  React.useEffect(() => {
    if (!open) return;
    function handleClick(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className={cn("relative", className)} ref={panelRef}>
      {/* Bell icon button */}
      <button
        type="button"
        className="relative inline-flex items-center justify-center rounded-lg p-2 text-ui-muted transition hover:bg-ui-highlight hover:text-ui-ink"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
        aria-expanded={open}
      >
        <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
          <path
            fillRule="evenodd"
            d="M10 2a6 6 0 0 0-6 6c0 1.887-.454 3.665-1.257 5.234a.75.75 0 0 0 .67 1.016H16.587a.75.75 0 0 0 .67-1.016A11.954 11.954 0 0 1 16 8a6 6 0 0 0-6-6ZM8 17.25a2 2 0 0 0 4 0H8Z"
            clipRule="evenodd"
          />
        </svg>
        {unreadCount > 0 ? (
          <span className="absolute -end-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[rgb(var(--ui-danger))] px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {/* Dropdown panel */}
      {open ? (
        <div className="absolute end-0 top-full z-[60] mt-2 w-80 rounded-xl border border-ui-border bg-ui-paper shadow-lg motion-safe:animate-fade-in">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-ui-border/30 px-4 py-3">
            <span className="text-sm font-semibold text-ui-ink">{t("title")}</span>
            {unreadCount > 0 && onMarkAllRead ? (
              <button
                type="button"
                className="text-xs text-ui-accent hover:underline"
                onClick={onMarkAllRead}
              >
                {t("markAllRead")}
              </button>
            ) : null}
          </div>

          {/* Notification list */}
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-8 text-center text-sm text-ui-muted">
                {t("noNotifications")}
              </div>
            ) : (
              notifications.map((notif) => {
                const isUnread = !notif.readAt;
                return (
                  <button
                    key={notif.id}
                    type="button"
                    className={cn(
                      "flex w-full gap-3 px-4 py-3 text-left transition hover:bg-ui-highlight/50",
                      isUnread && "bg-ui-accent/5"
                    )}
                    onClick={() => {
                      onMarkRead?.(notif.id);
                      onNotificationClick?.(notif);
                      setOpen(false);
                    }}
                  >
                    <span className="mt-0.5 text-base">
                      {typeIcons[notif.type] ?? typeIcons.system}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn("text-sm", isUnread ? "font-medium text-ui-ink" : "text-ui-muted")}>
                          {notif.title}
                        </span>
                        {isUnread ? (
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ui-accent" />
                        ) : null}
                      </div>
                      {notif.body ? (
                        <p className="mt-0.5 text-xs text-ui-muted line-clamp-2">{notif.body}</p>
                      ) : null}
                      <time className="mt-1 text-[10px] text-ui-muted/60">
                        {formatNotificationTime(notif.createdAt)}
                      </time>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
