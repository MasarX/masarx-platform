"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type FormDraftScope = { userId: string; tenantId: string; formId: string };

type UseFormDraftOptions<T> = {
  scope: FormDraftScope | null;
  /** Form values permitted to persist in the current browser tab. */
  values: T;
  isSubmitting?: boolean;
  debounceMs?: number;
};

type Restoration<T> = { key: string; values: T | null; pending: boolean };

const STORAGE_PREFIX = "masarx:form-draft:v1:";
const MAX_DRAFT_AGE_MS = 24 * 60 * 60 * 1000;
let draftSession = 0;

export function clearFormDrafts() {
  draftSession++;
  try {
    const storage = window.sessionStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(STORAGE_PREFIX)) storage.removeItem(key);
    }
  } catch {
    // Sign-out must still work when browser storage is unavailable.
  }
}

function serializeValues(values: unknown): string | undefined {
  try {
    return JSON.stringify(values);
  } catch {
    return undefined;
  }
}

function readDraft<T>(key: string): T | null {
  try {
    const storageKey = `${STORAGE_PREFIX}${key}`;
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const draft = JSON.parse(raw) as { values?: T; savedAt: number };
    if (!Number.isFinite(draft.savedAt) || Date.now() - draft.savedAt > MAX_DRAFT_AGE_MS) {
      window.sessionStorage.removeItem(storageKey);
      return null;
    }
    return draft.values ?? null;
  } catch {
    return null;
  }
}

export function useFormDraft<T>({
  scope,
  values,
  isSubmitting,
  debounceMs = 1000,
}: UseFormDraftOptions<T>) {
  const key = scope?.userId && scope.tenantId && scope.formId
    ? JSON.stringify([scope.userId, scope.tenantId, scope.formId])
    : null;
  const [restoration, setRestoration] = useState<Restoration<T> | null>(null);
  const [session] = useState(() => draftSession);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = session === draftSession && restoration?.key === key ? restoration : null;
  const pending = current?.pending ?? false;
  const serialized = serializeValues(values);
  const owner = useRef({ key, serialized, blocked: false });

  useEffect(() => {
    if (owner.current.key !== key) {
      // Keep ignoring the previous scope's values even if they are cloned on re-render.
      owner.current = { key, serialized, blocked: true };
    } else if (owner.current.serialized !== serialized) {
      owner.current = { key, serialized, blocked: false };
    }
  }, [key, serialized]);

  const reloadDraft = useCallback(() => {
    if (!key || session !== draftSession) return null;
    const draft = readDraft<T>(key);
    if (draft !== null) clearTimeout(timer.current);
    setRestoration(draft === null ? null : { key, values: draft, pending: true });
    return draft;
  }, [key, session]);

  const canSave = useCallback(() => (
    key !== null && serialized !== undefined && !isSubmitting && !pending &&
    session === draftSession && owner.current.key === key &&
    owner.current.serialized === serialized && !owner.current.blocked
  ), [key, serialized, isSubmitting, pending, session]);

  const saveDraftNow = useCallback(() => {
    if (!canSave()) return;
    clearTimeout(timer.current);
    try {
      window.sessionStorage.setItem(
        `${STORAGE_PREFIX}${key}`,
        `{"values":${serialized},"savedAt":${Date.now()}}`,
      );
    } catch {
      // A storage restriction or full quota must leave the form usable.
    }
  }, [canSave, key, serialized]);

  useEffect(() => {
    if (!canSave()) return;
    timer.current = setTimeout(saveDraftNow, debounceMs);
    return () => clearTimeout(timer.current);
  }, [canSave, saveDraftNow, debounceMs]);

  useEffect(() => {
    // A restored draft takes precedence over the initial autosave.
    reloadDraft();
  }, [reloadDraft]);

  const acceptDraft = useCallback(() => {
    setRestoration((current) => current && { ...current, pending: false });
  }, []);

  const clearDraft = useCallback(() => {
    if (!key || session !== draftSession) return;
    clearTimeout(timer.current);
    if (owner.current.key === key) owner.current.blocked = true;
    setRestoration(null);
    try {
      window.sessionStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    } catch {
      // Storage may be unavailable even after a successful form submission.
    }
  }, [key, session]);

  return {
    restoredDraft: current?.values ?? null,
    hasDraft: pending,
    acceptDraft,
    discardDraft: clearDraft,
    clearDraft,
    saveDraftNow,
    reloadDraft,
  };
}
