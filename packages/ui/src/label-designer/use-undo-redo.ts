import * as React from "react";

const MAX_HISTORY = 50;

type UndoRedoState = {
  past: string[];
  future: string[];
};

export function useUndoRedo(
  currentValue: string,
  onChange: (value: string) => void,
) {
  const historyRef = React.useRef<UndoRedoState>({ past: [], future: [] });
  const lastPushedRef = React.useRef<string>(currentValue);

  const pushSnapshot = React.useCallback(
    (value: string) => {
      if (value === lastPushedRef.current) return;
      const { past } = historyRef.current;
      const nextPast = [...past, lastPushedRef.current].slice(-MAX_HISTORY);
      historyRef.current = { past: nextPast, future: [] };
      lastPushedRef.current = value;
    },
    [],
  );

  const undo = React.useCallback(() => {
    const { past, future } = historyRef.current;
    if (past.length === 0) return;
    const previous = past[past.length - 1]!;
    historyRef.current = {
      past: past.slice(0, -1),
      future: [lastPushedRef.current, ...future].slice(0, MAX_HISTORY),
    };
    lastPushedRef.current = previous;
    onChange(previous);
  }, [onChange]);

  const redo = React.useCallback(() => {
    const { past, future } = historyRef.current;
    if (future.length === 0) return;
    const next = future[0]!;
    historyRef.current = {
      past: [...past, lastPushedRef.current].slice(-MAX_HISTORY),
      future: future.slice(1),
    };
    lastPushedRef.current = next;
    onChange(next);
  }, [onChange]);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  // Push snapshot on value changes (debounced by caller or on meaningful actions)
  React.useEffect(() => {
    pushSnapshot(currentValue);
  }, [currentValue, pushSnapshot]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // Don't intercept when focus is in text inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redo, undo]);

  return { undo, redo, canUndo, canRedo };
}
