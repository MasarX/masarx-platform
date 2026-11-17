import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { useUndoRedo } from "../../packages/ui/src/label-designer/use-undo-redo";

function useEditor(enabled = true, key = "draft-a") {
  const [value, setValue] = React.useState("initial");
  return { value, setValue, ...useUndoRedo(value, setValue, enabled, key) };
}

test("history availability reacts to add, undo, redo and same-value edits", () => {
  const { result } = renderHook(() => useEditor());
  expect(result.current.canUndo).toBe(false);
  act(() => result.current.setValue("edited JSON"));
  expect(result.current.canUndo).toBe(true);
  act(() => result.current.undo());
  expect(result.current.value).toBe("initial");
  expect(result.current.canRedo).toBe(true);
  act(() => result.current.redo());
  expect(result.current.value).toBe("edited JSON");
  expect(result.current.canRedo).toBe(false);
  act(() => result.current.setValue("edited JSON"));
  act(() => result.current.undo());
  expect(result.current.value).toBe("initial");
  expect(result.current.canUndo).toBe(false);
});

test("caps history at 50 snapshots and clears redo after a new edit", () => {
  const { result } = renderHook(() => useEditor());
  for (let index = 1; index <= 55; index++) act(() => result.current.setValue(String(index)));
  for (let index = 0; index < 50; index++) act(() => result.current.undo());
  expect(result.current.value).toBe("5");
  expect(result.current.canUndo).toBe(false);
  act(() => result.current.setValue("new branch"));
  expect(result.current.canRedo).toBe(false);
});

test("readonly shortcuts and callbacks cannot mutate, and switching drafts resets history", () => {
  const { result, rerender } = renderHook(({ enabled, key }) => useEditor(enabled, key), { initialProps: { enabled: true, key: "a" } });
  act(() => result.current.setValue("changed"));
  rerender({ enabled: false, key: "a" });
  act(() => { result.current.undo(); window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true })); });
  expect(result.current.value).toBe("changed");
  rerender({ enabled: true, key: "b" });
  expect(result.current.canUndo).toBe(false);
  expect(result.current.canRedo).toBe(false);
});
