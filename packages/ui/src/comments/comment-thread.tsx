"use client";

import * as React from "react";
import { Button } from "../button";
import { createUiTranslator } from "../i18n";
import { Textarea } from "../textarea";
import { cn } from "../utils";

export type Comment = {
  id: string;
  userId: string;
  userName?: string | null;
  body: string;
  createdAt: string;
};

type CommentThreadProps = {
  comments: Comment[];
  onSubmit?: (body: string) => Promise<void>;
  currentUserId?: string | null;
  className?: string;
  /** Message shown when the comment list is empty. */
  emptyMessage?: string | null;
  /** Secondary hint shown below the empty message. */
  emptyHint?: string | null;
};

function formatCommentTime(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Threaded comment display with input for adding new comments.
 * Integrates into resource detail panels.
 */
export function CommentThread({
  comments,
  onSubmit,
  currentUserId,
  className,
  emptyMessage,
  emptyHint,
}: CommentThreadProps) {
  const t = createUiTranslator("ui.commentThread");
  const [body, setBody] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || !onSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(body.trim());
      setBody("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-3">
        {comments.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <svg className="h-8 w-8 text-ui-muted/50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <p className="text-sm font-medium text-ui-muted">{emptyMessage ?? t("noComments")}</p>
            {emptyHint ? (<p className="max-w-xs text-xs text-ui-muted/70">{emptyHint}</p>) : null}
          </div>
        ) : (
          comments.map((comment) => {
            const isOwn = currentUserId && comment.userId === currentUserId;
            return (
              <div key={comment.id} className="flex gap-3">
                <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold", isOwn ? "bg-ui-accent/20 text-ui-accent" : "bg-ui-highlight text-ui-muted")}>
                  {(comment.userName ?? "?").charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ui-ink">{comment.userName ?? t("unknownUser")}</span>
                    <time className="text-[10px] text-ui-muted">{formatCommentTime(comment.createdAt)}</time>
                  </div>
                  <p className="mt-0.5 text-sm text-ui-ink whitespace-pre-wrap">{comment.body}</p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {onSubmit ? (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("placeholder")} rows={2} disabled={submitting} className="flex-1 text-sm" />
          <Button type="submit" size="sm" disabled={!body.trim() || submitting} loading={submitting}>{t("send")}</Button>
        </form>
      ) : null}
    </div>
  );
}
