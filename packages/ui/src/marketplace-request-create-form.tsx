"use client";

import * as React from "react";
import { Button } from "./button";
import { Input } from "./input";
import { JsonSchemaForm } from "./json-schema-form";
import { RelationField } from "./relation-field";
import { Select } from "./select";
import { Textarea } from "./textarea";

export type MarketplaceRequestCreateState = {
  status: "idle" | "error" | "success";
  message?: string;
  requestId?: string;
  requestStatus?: string;
};

export type MarketplaceRequestKindOption = {
  kindKey: string;
  label: string;
  description?: string | null;
  schema?: unknown;
  uiConfig?: Record<string, unknown> | null;
};

export type MarketplacePrivatePoolOption = { organizationId: string; label: string };

type MarketplaceRequestCreateFormProps = {
  action: (
    prevState: MarketplaceRequestCreateState,
    formData: FormData,
  ) => Promise<MarketplaceRequestCreateState>;
  requestKinds: MarketplaceRequestKindOption[];
  privatePoolOptions?: MarketplacePrivatePoolOption[];
  defaultKindKey?: string | null;
  testIdPrefix: string;
};

const initialState: MarketplaceRequestCreateState = { status: "idle" };

function normalizeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function MarketplaceRequestCreateForm({
  action,
  requestKinds,
  privatePoolOptions,
  defaultKindKey,
  testIdPrefix,
}: MarketplaceRequestCreateFormProps) {
  const [state, formAction, isPending] = React.useActionState(action, initialState);
  const [kindKey, setKindKey] = React.useState(
    defaultKindKey || requestKinds[0]?.kindKey || "",
  );
  const [payload, setPayload] = React.useState<unknown>({});
  const [privatePoolIds, setPrivatePoolIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!kindKey && requestKinds[0]?.kindKey) {
      setKindKey(requestKinds[0].kindKey);
    }
  }, [kindKey, requestKinds]);

  const selectedKind = React.useMemo(
    () => requestKinds.find((entry) => entry.kindKey === kindKey) ?? null,
    [kindKey, requestKinds],
  );

  React.useEffect(() => {
    const schema = normalizeObject(selectedKind?.schema);
    const properties = normalizeObject(schema.properties);
    if (Object.keys(properties).length === 0) {
      setPayload({});
      return;
    }
    setPayload((current: unknown) => {
      if (current && typeof current === "object" && !Array.isArray(current)) {
        return current;
      }
      return {};
    });
  }, [selectedKind?.kindKey, selectedKind?.schema]);

  const formTitle =
    typeof selectedKind?.uiConfig?.["form_title"] === "string"
      ? String(selectedKind.uiConfig?.["form_title"])
      : selectedKind?.label || "New marketplace request";

  if (requestKinds.length === 0) {
    return (
      <div
        className="rounded-2xl border border-ui-border bg-ui-surface/80 p-4 text-sm text-ui-muted"
        data-testid={`${testIdPrefix}-empty`}
      >
        No request kinds are currently available for this scope.
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6" data-testid={`${testIdPrefix}-form`}>
      <input type="hidden" name="payload_json" value={JSON.stringify(payload ?? {})} />

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Request kind
          </span>
          <Select
            name="request_kind_key"
            value={kindKey}
            onChange={(event) => setKindKey(event.target.value)}
            disabled={isPending}
            data-testid={`${testIdPrefix}-kind`}
          >
            {requestKinds.map((kind) => (
              <option key={kind.kindKey} value={kind.kindKey}>
                {kind.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Title
          </span>
          <Input
            name="title"
            placeholder={formTitle}
            required
            disabled={isPending}
            data-testid={`${testIdPrefix}-title`}
          />
        </label>
      </div>

      <label className="space-y-2 text-sm text-ui-ink">
        <span className="text-xs uppercase tracking-wide text-ui-muted">
          Summary
        </span>
        <Textarea
          name="summary"
          rows={3}
          placeholder={selectedKind?.description || "Scope, SLA, and key execution notes"}
          disabled={isPending}
          data-testid={`${testIdPrefix}-summary`}
        />
      </label>

      {privatePoolOptions ? (
        <fieldset className="space-y-2 text-sm text-ui-ink" data-testid={`${testIdPrefix}-private-pool`}>
          <legend className="text-xs tracking-wide text-ui-muted">Private pool organizations</legend>
          <input type="hidden" name="private_pool_json" value={JSON.stringify(privatePoolIds)} />
          <RelationField
            mode="multi"
            value={privatePoolIds}
            onChange={(value) => setPrivatePoolIds(Array.isArray(value) ? value : [])}
            options={privatePoolOptions.map(({ organizationId, label }) => ({ value: organizationId, label }))}
            disabled={isPending || privatePoolOptions.length === 0}
            placeholder="Select visible marketplace suppliers"
          />
        </fieldset>
      ) : (
        <label className="space-y-2 text-sm text-ui-ink">
          <span className="text-xs uppercase tracking-wide text-ui-muted">
            Private pool organization IDs
          </span>
          <Textarea
            name="private_pool_csv"
            rows={3}
            placeholder="org-id-1, org-id-2"
            disabled={isPending}
            data-testid={`${testIdPrefix}-private-pool`}
          />
        </label>
      )}

      <div className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-ui-muted">
          Request payload
        </div>
        <div className="rounded-2xl border border-ui-border bg-ui-surface/70 p-4">
          <JsonSchemaForm
            schema={selectedKind?.schema ?? { type: "object", properties: {} }}
            value={payload}
            onChange={setPayload}
            disabled={isPending}
            testIdPrefix={`${testIdPrefix}-payload`}
          />
        </div>
      </div>

      <label className="flex items-center gap-3 text-sm text-ui-ink">
        <input
          type="checkbox"
          name="publish_after_create"
          value="1"
          className="h-4 w-4 rounded border-ui-border"
          disabled={isPending}
          data-testid={`${testIdPrefix}-publish-now`}
        />
        <span>Publish immediately after create</span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={isPending} data-testid={`${testIdPrefix}-submit`}>
          {isPending ? "Saving..." : "Create request"}
        </Button>
        <span className="text-xs text-ui-muted">
          The exact fields change by request kind and schema rows.
        </span>
      </div>

      {state.status === "error" ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm text-ui-muted"
          data-testid={`${testIdPrefix}-error`}
        >
          {state.message ?? "Request creation failed."}
        </div>
      ) : null}

      {state.status === "success" ? (
        <div
          className="rounded-2xl border border-ui-border bg-ui-surface/80 p-3 text-sm"
          data-testid={`${testIdPrefix}-success`}
        >
          {state.message ?? "Request created."}
        </div>
      ) : null}
    </form>
  );
}
