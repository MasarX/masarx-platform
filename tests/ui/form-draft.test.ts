import { act, renderHook } from "@testing-library/react";
import { clearFormDrafts, useFormDraft } from "../../packages/ui/src/use-form-draft";

const SCOPE = { userId: "actor-a", tenantId: "tenant-a", formId: "pickup" };
const OTHER_SCOPE = { ...SCOPE, tenantId: "tenant-b" };
const STORAGE_KEY = 'masarx:form-draft:v1:["actor-a","tenant-a","pickup"]';
const OTHER_STORAGE_KEY = 'masarx:form-draft:v1:["actor-a","tenant-b","pickup"]';
const VALUES = { parcels: 4 };

function seedDraft(savedAt = Date.now()) {
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ values: VALUES, savedAt }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

test("saves after the debounce and restores on remount", () => {
  const { unmount } = renderHook(() => useFormDraft({ scope: SCOPE, values: VALUES }));
  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  act(() => jest.advanceTimersByTime(1000));
  unmount();

  const defaults = { parcels: 0 };
  const { result } = renderHook(() => useFormDraft({ scope: SCOPE, values: defaults }));
  expect(result.current.hasDraft).toBe(true);
  expect(result.current.restoredDraft).toEqual(VALUES);
  act(() => jest.advanceTimersByTime(1000));
  expect(JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)!).values).toEqual(VALUES);
  act(() => result.current.acceptDraft());
  expect(result.current.hasDraft).toBe(false);
});

test.each(["clearDraft", "discardDraft"] as const)("%s removes the draft and cancels a pending save", (method) => {
  seedDraft();
  const { result } = renderHook(() => useFormDraft({ scope: SCOPE, values: VALUES }));
  expect(result.current.hasDraft).toBe(true);

  act(() => result.current[method]());
  act(() => jest.advanceTimersByTime(1000));

  expect(result.current.hasDraft).toBe(false);
  expect(result.current.restoredDraft).toBeNull();
  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("saves immediately and reloads values written to storage", () => {
  const { result } = renderHook(() => useFormDraft({ scope: SCOPE, values: VALUES }));
  expect(result.current.hasDraft).toBe(false);

  act(() => result.current.saveDraftNow());
  act(() => expect(result.current.reloadDraft()).toEqual(VALUES));

  expect(result.current.hasDraft).toBe(true);
  expect(result.current.restoredDraft).toEqual(VALUES);
});

test("removes expired drafts", () => {
  seedDraft(Date.now() - 25 * 60 * 60 * 1000);
  const { result } = renderHook(() => useFormDraft({ scope: SCOPE, values: VALUES }));
  expect(result.current.hasDraft).toBe(false);
  expect(result.current.restoredDraft).toBeNull();
  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("does not autosave or save immediately during submission", () => {
  const { result, rerender } = renderHook(
    ({ isSubmitting }) => useFormDraft({ scope: SCOPE, values: VALUES, isSubmitting }),
    { initialProps: { isSubmitting: false } },
  );
  rerender({ isSubmitting: true });
  act(() => result.current.saveDraftNow());
  act(() => jest.advanceTimersByTime(1000));
  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
});

test("does not expose a draft under a different identity or save without a scope", () => {
  seedDraft();
  const { result, rerender } = renderHook(
    ({ scope }: { scope: typeof SCOPE | null }) => useFormDraft({ scope, values: VALUES }),
    { initialProps: { scope: SCOPE } },
  );
  expect(result.current.restoredDraft).toEqual(VALUES);

  rerender({ scope: { ...SCOPE, userId: "actor-b" } });
  expect(result.current.restoredDraft).toBeNull();
  expect(result.current.hasDraft).toBe(false);

  rerender({ scope: null });
  act(() => result.current.saveDraftNow());
  act(() => jest.advanceTimersByTime(1000));
  expect(window.sessionStorage.length).toBe(1);
});

test("scope changes cancel the old timer and wait for new values before saving", () => {
  const { result, rerender } = renderHook(
    ({ scope, parcels }) => useFormDraft({ scope, values: { parcels } }),
    { initialProps: { scope: SCOPE, parcels: 4 } },
  );

  rerender({ scope: OTHER_SCOPE, parcels: 4 });
  act(() => result.current.saveDraftNow());
  act(() => jest.advanceTimersByTime(1000));
  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(window.sessionStorage.getItem(OTHER_STORAGE_KEY)).toBeNull();

  rerender({ scope: OTHER_SCOPE, parcels: 2 });
  act(() => jest.advanceTimersByTime(1000));
  expect(JSON.parse(window.sessionStorage.getItem(OTHER_STORAGE_KEY)!).values).toEqual({ parcels: 2 });
});

test("new values objects cannot overwrite a draft pending restore", () => {
  seedDraft();
  const { result, rerender } = renderHook(
    ({ parcels }) => useFormDraft({ scope: SCOPE, values: { parcels } }),
    { initialProps: { parcels: 0 } },
  );
  const stored = window.sessionStorage.getItem(STORAGE_KEY);

  rerender({ parcels: 1 });
  act(() => result.current.saveDraftNow());
  act(() => jest.advanceTimersByTime(1000));
  rerender({ parcels: 2 });
  act(() => jest.advanceTimersByTime(1000));
  expect(result.current.hasDraft).toBe(true);
  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe(stored);
});

test("sign-out clears every draft key and prevents queued writes", () => {
  const { result } = renderHook(() => useFormDraft({ scope: SCOPE, values: VALUES }));
  seedDraft();
  window.sessionStorage.setItem(OTHER_STORAGE_KEY, "other draft");
  window.sessionStorage.setItem("theme", "dark");

  act(() => clearFormDrafts());
  act(() => result.current.saveDraftNow());
  act(() => jest.advanceTimersByTime(1000));

  expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  expect(window.sessionStorage.getItem(OTHER_STORAGE_KEY)).toBeNull();
  expect(window.sessionStorage.getItem("theme")).toBe("dark");
});
