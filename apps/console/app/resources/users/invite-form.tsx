"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Input, Select } from "@masarx/ui";

type Choice = { id: string; name: string };
export type InviteOptions = {
  user_types: { value: string; label: string; scope_type: string }[];
  roles: Choice[];
  clients: Choice[];
  senders: Choice[];
};

export function TenantUserInviteForm({ endpoint, options, targetUserId }: {
  endpoint: string; options?: InviteOptions; targetUserId?: string;
}) {
  const router = useRouter();
  const t = useTranslations("ui.tenantUsers");
  const [userType, setUserType] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");
  const intent = useRef<Record<string, unknown> | null>(null);
  const scope = options?.user_types.find((entry) => entry.value === userType)?.scope_type;
  const scopes = scope === "client" ? options?.clients : options?.senders;
  const scopeUnavailable = Boolean(scope && scope !== "tenant" && !scopes?.length);
  const locked = Boolean(requestId);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || (!intent.current && scopeUnavailable)) return;
    if (!intent.current) {
      const data = new FormData(event.currentTarget);
      const id = crypto.randomUUID();
      intent.current = targetUserId ? { request_id: id, action: "resend", target_user_id: targetUserId } : {
        request_id: id, action: "invite", email: data.get("email"), full_name: data.get("full_name"),
        user_type: userType, role_id: data.get("role_id"), access_scope_type: scope,
        access_scope_id: scope === "tenant" ? null : data.get("scope_id"),
      };
      setRequestId(id);
    }
    setPending(true);
    setMessage("");
    try {
      const result = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(intent.current) });
      const body = await result.json();
      if (!result.ok) {
        setMessage(t("failed"));
      } else if (body.ok === true && body.code === "invite_request_recorded"
          && body.request_id === intent.current.request_id) {
        setMessage(t("sent"));
        router.refresh();
      } else {
        setMessage(t("unknown"));
      }
    } catch {
      setMessage(t("unknown"));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" data-testid={targetUserId ? "tenant-user-resend" : "tenant-user-invite"}>
      {!targetUserId && options ? <>
        <p className="max-w-prose text-sm text-ui-muted">{t("authorityHint")}</p>
        <fieldset disabled={pending || locked} className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2 text-sm"><span>{t("email")}</span>
            <Input name="email" type="email" autoComplete="email" required maxLength={320} /></label>
          <label className="space-y-2 text-sm"><span>{t("fullName")}</span>
            <Input name="full_name" autoComplete="name" required maxLength={200} /></label>
          <label className="space-y-2 text-sm"><span>{t("userType")}</span>
            <Select value={userType} onChange={(event) => setUserType(event.target.value)} required>
              <option value="">{t("choose")}</option>
              {options.user_types.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select></label>
          <label className="space-y-2 text-sm"><span>{t("role")}</span>
            <Select name="role_id" required defaultValue=""><option value="">{t("choose")}</option>
              {options.roles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </Select></label>
          {scope && scope !== "tenant" && !scopeUnavailable ? <label className="space-y-2 text-sm"><span>{t("scope")}</span>
            <Select name="scope_id" required defaultValue="" key={scope}><option value="">{t("choose")}</option>
              {scopes?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
            </Select></label> : null}
        </fieldset>
      </> : null}
      <Button type="submit" disabled={pending} aria-busy={pending}>
        {pending ? t("working") : locked ? t("checkOutcome") : targetUserId ? t("resend") : t("invite")}
      </Button>
      <div role="status" aria-live="polite" className="space-y-2 text-sm">
        {!locked && scopeUnavailable ? <p>{t("noScopeOptions")}</p> : null}
        {message ? <p>{message}</p> : null}
        {requestId ? <p className="break-all">{t("requestId", { id: requestId })}</p> : null}
      </div>
    </form>
  );
}
