"use client";

import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { Textarea } from "./textarea";

export type TenantSignupRequestCreateState = {
  status: "idle" | "error" | "success";
  message?: string;
  requestHref?: string;
};

type TenantSignupRequestCreateFormProps = {
  action: (
    prevState: TenantSignupRequestCreateState,
    formData: FormData,
  ) => Promise<TenantSignupRequestCreateState>;
  testIdPrefix: string;
};

const fields = [
  { name: "email", label: "Email (required)", type: "email", required: true },
  { name: "full_name", label: "Full name (required)", required: true },
  { name: "organization_name", label: "Organization name (required)", required: true },
  { name: "organization_slug", label: "Organization slug" },
  { name: "website_url", label: "Website", type: "url" },
  { name: "phone", label: "Phone", type: "tel" },
  { name: "locale", label: "Locale" },
] as const;

export function TenantSignupRequestCreateForm({
  action,
  testIdPrefix,
}: TenantSignupRequestCreateFormProps) {
  const [state, formAction, isPending] = React.useActionState(action, { status: "idle" });

  return (
    <form action={formAction} className="max-w-2xl space-y-4" data-testid={`${testIdPrefix}-form`}>
      <fieldset disabled={isPending} className="space-y-4">
        <legend className="sr-only">Organization signup request</legend>
        {fields.map((field) => {
          const id = `${testIdPrefix}-${field.name}`;
          const identifier = ["email", "organization_slug", "website_url", "locale"].includes(field.name);
          return (
            <div key={field.name} className="space-y-2">
              <label htmlFor={id} className="block text-sm text-ui-ink">{field.label}</label>
              <Input
                id={id}
                name={field.name}
                type={"type" in field ? field.type : "text"}
                required={"required" in field && field.required}
                autoComplete="off"
                autoCapitalize={identifier ? "none" : undefined}
                autoCorrect={identifier ? "off" : undefined}
                spellCheck={identifier ? false : undefined}
                className="min-h-12 text-base"
                data-testid={id}
              />
            </div>
          );
        })}
        <div className="space-y-2">
          <label htmlFor={`${testIdPrefix}-notes`} className="block text-sm text-ui-ink">Notes</label>
          <Textarea id={`${testIdPrefix}-notes`} name="notes" rows={3} className="text-base" />
        </div>
        <Button type="submit" className="min-h-12" data-testid={`${testIdPrefix}-submit`}>
          {isPending ? "Queuing..." : "Queue request for review"}
        </Button>
      </fieldset>
      <p className="text-sm text-ui-muted">This only queues a request. Approval and account activation remain separate.</p>
      <div role="status" aria-live="polite" aria-atomic="true" data-testid={`${testIdPrefix}-status`}>
        {state.message ? <p className="text-sm text-ui-ink">{state.message}</p> : null}
        {state.status === "success" && state.requestHref ? (
          <a href={state.requestHref} className="text-sm underline">View organization request</a>
        ) : null}
      </div>
    </form>
  );
}
