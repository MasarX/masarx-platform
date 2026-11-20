"use client";

import * as React from "react";

type SupabaseClient = {
  channel: (name: string) => unknown;
  removeChannel: (channel: unknown) => void;
};

type RealtimeContextValue = {
  client: SupabaseClient | null;
};

const RealtimeContext = React.createContext<RealtimeContextValue>({
  client: null,
});

/**
 * Provides a Supabase client for realtime subscriptions.
 * Wrap your app with this provider to enable `useRealtimeInvalidation`.
 */
export function RealtimeProvider({
  client,
  children,
}: {
  client: SupabaseClient | null;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ client }), [client]);
  return (
    <RealtimeContext.Provider value={value}>
      {children}
    </RealtimeContext.Provider>
  );
}

/**
 * Returns the Supabase client from the nearest RealtimeProvider,
 * or null if none is available.
 */
export function useRealtimeClient(): SupabaseClient | null {
  return React.useContext(RealtimeContext).client;
}
