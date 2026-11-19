// MessageThread.tsx — chat-style conversation surface.
//
// Operator messages render right-aligned with the accent fill; customer
// messages stay left-aligned on the surface fill; system messages center as
// muted, smaller annotations. Optional `composer` prop enables a textarea +
// Send button at the bottom; Cmd+Enter (or Ctrl+Enter on non-Mac) submits.
//
// The list itself is `role="log" aria-live="polite"` so screen readers
// announce new messages without reading the entire thread; the composer has
// an explicit `<label>` even though it's visually-hidden so AT can describe
// it accurately.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from './Button';

export type MessageRole = 'operator' | 'customer' | 'system';

export interface MessageAuthor {
  id: string;
  name: string;
  role: MessageRole;
  initials?: string;
}

export interface MessageAttachment {
  id: string;
  name: string;
  href?: string;
}

export interface ThreadMessage {
  id: string;
  /** ISO timestamp. */
  at: string;
  author: MessageAuthor;
  body: string;
  attachments?: MessageAttachment[];
}

export interface MessageThreadComposer {
  onSubmit: (body: string) => Promise<void> | void;
  placeholder?: string;
  /** Defaults to "send-message" so a11y tests can target it. */
  inputId?: string;
  /** Capability to gate submit (passed straight to Button). */
  capability?: string;
  disabled?: boolean;
  /** Optional helper text rendered below the textarea. */
  hint?: ReactNode;
}

export interface MessageThreadProps {
  messages: ThreadMessage[];
  composer?: MessageThreadComposer;
  className?: string;
  /** Override automatic scrolling-to-bottom on mount. */
  autoScroll?: boolean;
}

function autoInitials(name: string): string {
  const parts = (name || '??').trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}

function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function MessageThread({
  messages,
  composer,
  className,
  autoScroll = true,
}: MessageThreadProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages.length, autoScroll]);

  const submit = async () => {
    if (!composer) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await composer.onSubmit(trimmed);
      setDraft('');
      setSubmitError(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to send message.');
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === 'Enter' && meta) {
      event.preventDefault();
      void submit();
    }
  };

  const wrapClasses = ['primitive-msg', className].filter(Boolean).join(' ');
  const inputId = composer?.inputId ?? 'send-message';

  return (
    <div className={wrapClasses}>
      <div
        ref={listRef}
        className="primitive-msg__list"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Conversation"
        tabIndex={0}
      >
        {messages.map((m) => {
          const at = new Date(m.at);
          const initials = m.author.initials ?? autoInitials(m.author.name);
          return (
            <div key={m.id} className={`primitive-msg__row primitive-msg__row--${m.author.role}`}>
              {m.author.role !== 'system' ? (
                <span
                  className="primitive-msg__avatar"
                  aria-hidden="true"
                  title={m.author.name}
                >
                  {initials}
                </span>
              ) : null}
              <div className="primitive-msg__bubble">
                {m.author.role !== 'system' ? (
                  <div className="primitive-msg__meta">
                    <span className="primitive-msg__author">{m.author.name}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={m.at}>{fmtTime(at)}</time>
                  </div>
                ) : null}
                <div>{m.body}</div>
                {m.attachments && m.attachments.length > 0 ? (
                  <div className="primitive-msg__attach">
                    {m.attachments.map((a) =>
                      a.href ? (
                        <a key={a.id} href={a.href} className="primitive-msg__attach-item">
                          {a.name}
                        </a>
                      ) : (
                        <span key={a.id} className="primitive-msg__attach-item">
                          {a.name}
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {composer ? (
        <form className="primitive-msg__composer" onSubmit={onSubmit}>
          <div className="primitive-msg__composer-area">
            <label htmlFor={inputId}>Send message</label>
            <textarea
              id={inputId}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={composer.placeholder ?? 'Type a message…'}
              onKeyDown={onKeyDown}
              disabled={busy || composer.disabled}
              rows={2}
            />
            {composer.hint ? (
              <span className="primitive-msg__composer-hint">{composer.hint}</span>
            ) : (
              <span className="primitive-msg__composer-hint">⌘⏎ to send</span>
            )}
            {submitError ? (
              <span className="primitive-msg__composer-hint primitive-msg__composer-hint--error">
                {submitError}
              </span>
            ) : null}
          </div>
          <Button
            type="submit"
            kind="primary"
            label={busy ? 'Sending…' : 'Send'}
            disabled={busy || composer.disabled || !draft.trim()}
            capability={composer.capability}
          />
        </form>
      ) : null}
    </div>
  );
}
