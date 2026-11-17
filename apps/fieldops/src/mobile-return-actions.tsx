import type { UiCommandDefinition } from "@masarx/api";
import type { createMobileClient } from "@masarx/auth/mobile";
import { createOutbox, normalizeOutboxDisplay } from "@masarx/mobile-core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { assertMobileCommandSelection, hasMobileCommandDisabledState } from "./mobile-action-feedback";
import { mobileActionAccessibility } from "./mobile-action-accessibility";
import { type AcceptedReturnScan, verifiedReturnScanReceipt } from "./mobile-return-scan";
import type { FieldOpsStrings } from "./i18n";

type Props = {
  strings: FieldOpsStrings["returnActions"];
  accepted: AcceptedReturnScan | null;
  actorId: string;
  client: ReturnType<typeof createMobileClient>;
  outbox: ReturnType<typeof createOutbox>;
  commands: UiCommandDefinition[];
  canComplete: boolean;
  online: boolean;
  syncing: boolean;
  drivingLocked: boolean;
  onSync: () => void;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function MobileReturnActions(props: Props) {
  const { strings, accepted, actorId, client, outbox, commands, canComplete, online, syncing, drivingLocked, onSync } = props;
  const queryClient = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const selected = accepted?.actor === actorId ? accepted : null;
  const readback = useQuery({
    queryKey: ["return-scan-readback", actorId, selected?.scanEventId],
    queryFn: async ({ signal }) => {
      const result = await client.schema("api").rpc("ui_get_return_to_branch_scan_readback_v1",
        { p_scan_event_id: selected!.scanEventId }).abortSignal(signal);
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: Boolean(online && selected),
    staleTime: 0,
  });
  const verified = Boolean(selected && !readback.isFetching && verifiedReturnScanReceipt(readback.data, selected));
  if (!commands.length) return null;

  const queue = async (command: UiCommandDefinition) => {
    if (!selected || !online || !verified || !canComplete || drivingLocked || busy || syncing ||
      !["return_to_branch.reinduct", "return_to_branch.escalate"].includes(command.key) ||
      command.schema_category !== "resource:return_to_branch_scan" ||
      command.execution?.rpc !== "ui_execute_return_to_branch_action_v1") return;
    setBusy(true);
    setMessage(null);
    try {
      assertMobileCommandSelection(command, selected.scanEventId);
      const fresh = await readback.refetch();
      const actor = await client.auth.getUser();
      if (fresh.error || !verifiedReturnScanReceipt(fresh.data, selected) ||
        actor.error || actor.data.user?.id !== selected.actor) {
        throw new Error(strings.actorMismatch);
      }
      await outbox.enqueue({
        rpc: "ui_execute_return_to_branch_action_v1",
        display: normalizeOutboxDisplay({ actionLabel: command.key === "return_to_branch.reinduct" ? strings.reinduct : strings.escalate,
          targetLabel: selected.barcode }),
        args: {
          p_action_key: command.key, p_resource_key: "return_to_branch_scan",
          p_selection_ids: [selected.scanEventId], p_selection_id: selected.scanEventId,
          p_selection_count: 1, p_params: {},
        },
      });
      queryClient.invalidateQueries({ queryKey: ["outbox", "count"] });
      queryClient.invalidateQueries({ queryKey: ["outbox", "entries"] });
      setMessage(strings.queued);
      if (!syncing) onSync();
    } catch (error) {
      setMessage(error instanceof Error && error.message === strings.actorMismatch ? strings.actorMismatch : strings.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ padding: 12, gap: 8 }}>
      <Text>{strings.title}</Text>
      <Text>{verified ? strings.verified : strings.waiting}</Text>
      {selected ? <Text>{strings.scan(selected.barcode, selected.scanEventId)}</Text> : null}
      {readback.isError ? <Text>{strings.readbackUnavailable}</Text> : null}
      {selected && readback.isFetching ? <Text>{strings.refreshing}</Text> : null}
      {verified ? (
        <Text>{strings.serverState(
          String(record(readback.data).shipment_status ?? strings.unknown),
          String(record(readback.data).next_action ?? strings.pending),
          String(record(readback.data).dispatch_exception_review_task_id ?? strings.none))}</Text>
      ) : null}
      {commands.map(command => {
        const retired = hasMobileCommandDisabledState(command);
        const reason = String(record(command).disabled_reason ?? record(command).reason ?? "");
        const label = command.key === "return_to_branch.reinduct" ? strings.reinduct :
          command.key === "return_to_branch.escalate" ? strings.escalate :
          command.key === "return_to_branch.otp_pickup_release" ? strings.otpRelease :
          command.key === "return_to_branch.discard" ? strings.discard : command.label;
        const disabled = retired || !verified || !canComplete || !online || syncing || drivingLocked || busy;
        const hint = retired ? reason === "otp_issuer_verifier_authority_unavailable" ? strings.otpDisabled :
            reason === "physical_discard_custody_finance_policy_unavailable" ? strings.discardDisabled : strings.disabledUnknown :
          !online ? strings.onlineHint :
          !verified ? strings.verifiedHint :
          !canComplete ? strings.capabilityHint :
          drivingLocked ? strings.drivingHint : strings.readyHint;
        return (
          <Pressable key={command.key} testID={`mobile-return-action-${command.key}`}
            {...mobileActionAccessibility(hint, disabled, busy)}
            disabled={disabled}
            onPress={() => { void queue(command); }}
            style={{ padding: 10, borderWidth: 1, borderRadius: 8, opacity: disabled ? 0.6 : 1 }}>
            <Text>{label}</Text>
            {retired ? <Text>{hint}</Text> : null}
          </Pressable>
        );
      })}
      {message ? <Text>{message}</Text> : null}
      {selected ? <Pressable accessibilityRole="button" onPress={() => { void readback.refetch(); }}>
        <Text>{strings.refresh}</Text>
      </Pressable> : null}
    </View>
  );
}
