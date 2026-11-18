import {
  walletForm, walletStorageKey, readWalletDraft, readWalletSummary, readWalletReceipt,
} from "../../../apps/fieldops/src/mobile-wallet";

const actor = "driver-1";
const scope = JSON.stringify(["org-1", "tenant", null]);

test("withdrawal amount remains an exact decimal string and draft is actor scoped", () => {
  expect(walletForm(" sar ", "0001.250")).toEqual({ currency: "SAR", amount: "0001.250" });
  for (const amount of ["0", "0.000", "-1", "1e3", "1.2.3", ""]) {
    expect(() => walletForm("SAR", amount)).toThrow();
  }
  expect(() => walletForm("POINTS", "1")).toThrow();
  const draft = { version: 1, actor, scope, currency: "SAR", amount: "0001.250", key: "stable:key" };
  expect(readWalletDraft(draft, actor, scope)).toEqual(draft);
  expect(readWalletDraft(draft, "other", scope)).toBeNull();
  expect(readWalletDraft({ ...draft, amount: "1.251" }, actor, "other")).toBeNull();
  expect(walletStorageKey(actor, scope)).not.toBe(walletStorageKey("other", scope));
});

test("wallet readback binds actor/currency and rejects unsafe numeric display", () => {
  const base = { organization_id: "org-1", driver_user_id: actor, currency: "SAR",
    balance: "123456789012345678.12", remitted_payout: "2.50",
    reserved_withdrawal: "1.25", available: "3.75" };
  expect(readWalletSummary(base, actor, "SAR", scope)).toMatchObject({
    balance: "123456789012345678.12", remitted_payout: "2.50", available: "3.75",
  });
  expect(readWalletSummary({ ...base, balance: 1.25 }, actor, "SAR", scope)?.balance).toBe("1.25");
  expect(readWalletSummary({ ...base, balance: 0.0001 }, actor, "SAR", scope)).toBeNull();
  expect(readWalletSummary({ ...base, balance: Number.MAX_SAFE_INTEGER + 1 }, actor, "SAR", scope)).toBeNull();
  expect(readWalletSummary({ ...base, driver_user_id: "other" }, actor, "SAR", scope)).toBeNull();
  expect(readWalletSummary({ ...base, organization_id: "other-org" }, actor, "SAR", scope)).toBeNull();
  expect(readWalletSummary({ ...base, currency: "USD" }, actor, "SAR", scope)).toBeNull();
});

test("only request task receipts are accepted; payout is never inferred", () => {
  const task = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";
  expect(readWalletReceipt({ status: "requested", task_id: task })).toEqual({
    status: "requested", taskId: task,
  });
  expect(readWalletReceipt({ status: "existing", task_id: task })).toEqual({
    status: "existing", taskId: task,
  });
  expect(readWalletReceipt({ status: "paid", task_id: task })).toBeNull();
  expect(readWalletReceipt({ status: "requested", task_id: "bad" })).toBeNull();
});
