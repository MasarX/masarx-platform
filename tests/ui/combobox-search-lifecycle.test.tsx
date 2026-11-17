import { act, renderHook } from "@testing-library/react";
import { useComboboxSearch } from "../../packages/ui/src/use-combobox-search";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("disabling remote search cancels the debounce and clears loading", () => {
  const fetcher = jest.fn(async () => [{ label: "Alpha", value: "alpha" }]);
  const { result, rerender } = renderHook(({ enabled }) => useComboboxSearch({ fetcher, enabled }), {
    initialProps: { enabled: true },
  });
  act(() => result.current.search("alpha"));
  expect(result.current.loading).toBe(true);
  rerender({ enabled: false });
  act(() => jest.advanceTimersByTime(300));
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
  expect(result.current.results).toEqual([]);
});

test("results from an in-flight search cannot return after disabling", async () => {
  let resolve!: (results: { label: string; value: string }[]) => void;
  const fetcher = jest.fn(() => new Promise<{ label: string; value: string }[]>((done) => { resolve = done; }));
  const { result, rerender } = renderHook(({ enabled }) => useComboboxSearch({ fetcher, enabled }), {
    initialProps: { enabled: true },
  });
  act(() => result.current.search("alpha"));
  act(() => jest.advanceTimersByTime(300));
  expect(fetcher).toHaveBeenCalledTimes(1);
  rerender({ enabled: false });
  await act(async () => resolve([{ label: "Old result", value: "old" }]));
  expect(result.current.results).toEqual([]);
  expect(result.current.loading).toBe(false);
});

test("a previous query cannot overwrite a newer result", async () => {
  const pending: ((results: { label: string; value: string }[]) => void)[] = [];
  const fetcher = jest.fn(() => new Promise<{ label: string; value: string }[]>((done) => { pending.push(done); }));
  const { result } = renderHook(() => useComboboxSearch({ fetcher }));
  act(() => result.current.search("first"));
  act(() => jest.advanceTimersByTime(300));
  act(() => result.current.search("second"));
  act(() => jest.advanceTimersByTime(300));
  await act(async () => pending[1]([{ label: "Second", value: "second" }]));
  await act(async () => pending[0]([{ label: "First", value: "first" }]));
  expect(result.current.results).toEqual([{ label: "Second", value: "second" }]);
  expect(result.current.loading).toBe(false);
});
