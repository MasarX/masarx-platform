export type WalletRequestDraft = {
  version: 1;
  actor: string;
  scope: string;
  currency: string;
  amount: string;
  key: string;
  taskId?: string;
};

export function walletForm(currencyInput: string, amountInput: string) {
  const currency = currencyInput.trim().toUpperCase();
  const amount = amountInput.trim();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("wallet-invalid-currency");
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(amount) || amount.length > 30 || !/[1-9]/.test(amount)) {
    throw new Error("wallet-invalid-amount");
  }
  return { currency, amount };
}

export function walletStorageKey(actor: string, scope: string) {
  return `fieldops_wallet_request_v1:${encodeURIComponent(actor)}:${encodeURIComponent(scope)}`;
}

export function readWalletDraft(value: unknown, actor: string, scope: string): WalletRequestDraft | null {
  if (!value || typeof value !== "object") return null;
  const draft = value as Record<string, unknown>;
  if (draft.version !== 1 || draft.actor !== actor || draft.scope !== scope ||
      typeof draft.currency !== "string" || typeof draft.amount !== "string" ||
      typeof draft.key !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(draft.key)) return null;
  try {
    const form = walletForm(draft.currency, draft.amount);
    if (form.currency !== draft.currency || form.amount !== draft.amount) return null;
  } catch { return null; }
  if (draft.taskId != null && (typeof draft.taskId !== "string" || !draft.taskId)) return null;
  return draft as WalletRequestDraft;
}

export function walletScopeOrganization(scope: string): string | null {
  try {
    const parts: unknown = JSON.parse(scope);
    return Array.isArray(parts) && parts.length === 3 &&
      typeof parts[0] === "string" && parts[0] ? parts[0] : null;
  } catch { return null; }
}

export function readWalletSummary(value: unknown, actor: string, currency: string, scope: string) {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.driver_user_id !== actor || row.currency !== currency ||
      row.organization_id !== walletScopeOrganization(scope)) return null;
  const fields = ["balance", "remitted_payout", "reserved_withdrawal", "available"] as const;
  const amounts = {} as Record<(typeof fields)[number], string>;
  for (const field of fields) {
    const value = row[field];
    // JSON numbers can lose precision. Accept only safely representable milli-units;
    // exact arbitrary-scale finance values require a server decimal-string contract.
    const decimal = typeof value === "string" ? value
      : typeof value === "number" && Number.isSafeInteger(value * 1000) ? String(value) : "";
    if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(decimal) ||
        (field !== "balance" && decimal.startsWith("-"))) return null;
    amounts[field] = decimal;
  }
  return { currency, ...amounts };
}

export function readWalletReceipt(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if ((row.status !== "requested" && row.status !== "existing") ||
      typeof row.task_id !== "string" || !/^[0-9a-f-]{36}$/i.test(row.task_id)) return null;
  return { status: row.status, taskId: row.task_id };
}
