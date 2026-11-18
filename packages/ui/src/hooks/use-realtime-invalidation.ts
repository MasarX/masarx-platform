"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

type RealtimeChannel = {
  unsubscribe: () => void;
};

type SupabaseRealtimeClient = {
  channel: (name: string) => {
    on: (
      event: string,
      opts: { event: string; schema: string; table: string },
      callback: (payload: unknown) => void
    ) => { subscribe: () => RealtimeChannel };
  };
};

/**
 * Subscribes to Supabase Realtime postgres_changes for a table and
 * invalidates the matching React Query cache on any INSERT/UPDATE/DELETE.
 *
 * Usage:
 *   useRealtimeInvalidation(supabaseClient, "shipments", ["resource", "shipments"]);
 */
export function useRealtimeInvalidation(
  client: SupabaseRealtimeClient | null | undefined,
  table: string | null | undefined,
  queryKeyPrefix: readonly unknown[]
) {
  const queryClient = useQueryClient();
  // Stabilize the query key reference to prevent infinite re-subscription
  const stableKeyRef = React.useRef(queryKeyPrefix);
  stableKeyRef.current = queryKeyPrefix;

  React.useEffect(() => {
    if (!client || !table) return;

    const channelName = `realtime-invalidation-${table}`;
    const channel = client
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        () => {
          queryClient.invalidateQueries({
            queryKey: [...stableKeyRef.current],
          });
        }
      )
      .subscribe();

    return () => {
      channel.unsubscribe();
    };
  }, [client, table, queryClient]);
}
