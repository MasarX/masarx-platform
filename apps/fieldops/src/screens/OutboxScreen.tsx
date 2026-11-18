import * as React from "react";
import { EmptyState } from "../components/EmptyState";
import { IllustrationOutboxClear } from "../illustrations";

export function OutboxEmptyState({ title }: { title: string }) {
  return (
    <EmptyState
      title={title}
      icon={<IllustrationOutboxClear size={96} />}
      testID="mobile-outbox-empty-state"
    />
  );
}
