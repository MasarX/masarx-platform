import * as React from "react";

function createContextStore<T>(initial: T) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getServerSnapshot: () => initial,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(value: T) {
      if (Object.is(snapshot, value)) return;
      snapshot = value;
      listeners.forEach((listener) => listener());
    },
  };
}

export type ContextStore<T> = ReturnType<typeof createContextStore<T>>;

export function useContextStore<T>(value: T): ContextStore<T> {
  // Stable context lets mounted readers update without invalidating pending streamed boundaries.
  const [store] = React.useState(() => createContextStore(value));
  React.useEffect(() => store.publish(value), [store, value]);
  return store;
}

const readEmptySnapshot = () => null;
const subscribeToEmptyStore = () => () => undefined;

export function useContextStoreValue<T>(store: ContextStore<T> | null): T | null {
  return React.useSyncExternalStore<T | null>(
    store?.subscribe ?? subscribeToEmptyStore,
    store?.getSnapshot ?? readEmptySnapshot,
    store?.getServerSnapshot ?? readEmptySnapshot
  );
}
