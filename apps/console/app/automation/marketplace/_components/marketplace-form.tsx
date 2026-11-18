"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createUiClient } from "@masarx/api";
import { Button, Input, Textarea, createUiTranslator, hasCapability, resolveCapabilitySet, resolveSafeHref, useToast } from "@masarx/ui";

export type MarketplaceAccess = { userId: string; capabilities: string[]; scopeKey?: string };
export type MarketplaceFormProps = { appBasePath: string; access: MarketplaceAccess };
export const selectClasses = "min-h-10 w-full rounded-xl border border-ui-border bg-ui-surface px-3 py-2 text-base text-ui-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ui-accent";
export const marketplaceHref = (base: string, path = "") => resolveSafeHref(base, `/automation/marketplace${path}`);
export const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
export function jsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyntaxError();
  return parsed as Record<string, unknown>;
}
export function requireResult(ok: boolean, id: unknown, expected?: string) {
  if (ok !== true || !text(id) || (expected && id !== expected)) throw new Error("unconfirmed_result");
  return text(id);
}
export async function readBack(ui: ReturnType<typeof createUiClient>, resource: string, id: string, matches: (row: Record<string, unknown>) => boolean) {
  const row = await ui.getResource(resource, id);
  if (!row || row.id !== id || !matches(row)) throw new Error("unconfirmed_readback");
  return row;
}

export function useMarketplaceAction({ access, appBasePath }: MarketplaceFormProps, capability: string, identity: string, sharedBusy?: React.MutableRefObject<boolean>) {
  const t = createUiTranslator("ui.automationMarketplace");
  const { toast } = useToast();
  const [pending, setPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<{ error: boolean; message: string } | null>(null);
  const localBusy = React.useRef(false);
  const busy = sharedBusy ?? localBusy;
  const mounted = React.useRef(true);
  const snapshot = `${access.userId}/${access.scopeKey ?? ""}/${access.capabilities.join(",")}/${identity}/${appBasePath}`;
  const latest = React.useRef(snapshot);
  React.useLayoutEffect(() => { latest.current = snapshot; }, [snapshot]);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const allowed = Boolean(access.userId && marketplaceHref(appBasePath) && hasCapability(resolveCapabilitySet(access.capabilities), capability));
  async function run(task: (ui: ReturnType<typeof createUiClient>, check: () => void) => Promise<string | void>) {
    if (busy.current || !allowed) return;
    busy.current = true;
    setPending(true);
    setFeedback(null);
    const current = () => mounted.current && latest.current === snapshot;
    const check = () => { if (!current()) throw new Error("stale_request"); };
    try {
      const ui = createUiClient();
      const me = await ui.me();
      check();
      if (me?.user?.id !== access.userId || !hasCapability(resolveCapabilitySet(me?.capabilities), capability)) throw new Error("access_changed");
      const scopeKey = `${me?.org?.id ?? ""}/${me?.access_scope?.scope_type ?? ""}/${me?.access_scope?.scope_id ?? ""}`;
      if (access.scopeKey !== undefined && scopeKey !== access.scopeKey) throw new Error("scope_changed");
      const message = await task(ui, check);
      check();
      if (message) {
        setFeedback({ error: false, message });
        toast({ tone: "success", title: message });
      }
    } catch (error) {
      if (current()) {
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        const message = t(error instanceof SyntaxError ? "invalidJson" : code === "rpc_outcome_unconfirmed" ? "outcomeUnconfirmed" : code === "oauth_reauth_required" ? "oauthReauthRequired" : "actionFailed");
        setFeedback({ error: true, message });
        toast({ tone: "error", title: message });
      }
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return { t, pending, allowed, run, feedback };
}

export function MarketplaceFeedback({ pending, allowed, feedback }: Pick<ReturnType<typeof useMarketplaceAction>, "pending" | "allowed" | "feedback">) {
  const t = createUiTranslator("ui.automationMarketplace");
  if (!allowed) return <p role="alert">{t("accessDenied")}</p>;
  if (feedback) return <p role={feedback.error ? "alert" : "status"}>{feedback.message}</p>;
  return pending ? <p role="status">{t("working")}</p> : null;
}

export function Field({ name, label, value, onChange, disabled, required, rows, type = "text", hint }: {
  name: string; label: string; value: string; onChange: (value: string) => void; disabled?: boolean; required?: boolean; rows?: number; type?: string; hint?: string;
}) {
  const id = React.useId();
  const props = { id, name, value, disabled, required, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value), "aria-describedby": hint ? `${id}-hint` : undefined };
  return <div className="space-y-2 text-sm">
    <label htmlFor={id} className="block font-medium text-ui-ink">{label}</label>
    {rows ? <Textarea {...props} rows={rows} className="font-mono text-base" spellCheck={false} /> : <Input {...props} type={type} className="text-base" autoComplete={type === "password" ? "new-password" : "off"} />}
    {hint ? <p id={`${id}-hint`} className="text-ui-muted">{hint}</p> : null}
  </div>;
}

export function Choice({ name, label, value, onChange, options, disabled }: { name: string; label: string; value: string; onChange: (value: string) => void; options: string[]; disabled?: boolean }) {
  const id = React.useId();
  const t = createUiTranslator("ui.automationMarketplace");
  return <div className="space-y-2 text-sm"><label htmlFor={id} className="block font-medium text-ui-ink">{label}</label><select id={id} name={name} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className={selectClasses}>{options.map(option => <option key={option} value={option}>{t(`options.${option}`)}</option>)}</select></div>;
}

export function MarketplaceCancel({ appBasePath, pending, path = "" }: { appBasePath: string; pending: boolean; path?: string }) {
  const router = useRouter();
  const t = createUiTranslator("ui.automationMarketplace");
  const href = marketplaceHref(appBasePath, path);
  return <Button type="button" variant="ghost" disabled={pending || !href} onClick={() => { if (href) router.push(href); }}>{t("cancel")}</Button>;
}
