import * as React from "react";

const MAX_HISTORY = 50;

type UndoRedoState = {
  past: string[];
  future: string[];
  present: string;
  documentKey?: string;
};

export function useUndoRedo(
  currentValue: string,
  onChange: (value: string) => void,
  enabled = true,
  documentKey?: string,
) {
  const [history, setHistory] = React.useState<UndoRedoState>({ past: [], future: [], present: currentValue, documentKey });
  // Adjust controlled-value history before rendering children; no ref-backed UI or effect refresh.
  if (history.documentKey !== documentKey) {
    setHistory({ past: [], future: [], present: currentValue, documentKey });
  } else if (history.present !== currentValue) {
    setHistory({ ...history, past: [...history.past, history.present].slice(-MAX_HISTORY), future: [], present: currentValue });
  }

  const undo = React.useCallback(() => {
    if (!enabled) return;
    const { past, future, present } = history;
    if (past.length === 0) return;
    const previous = past[past.length - 1]!;
    setHistory({
      documentKey,
      present: previous,
      past: past.slice(0, -1),
      future: [present, ...future].slice(0, MAX_HISTORY),
    });
    onChange(previous);
  }, [documentKey, enabled, history, onChange]);

  const redo = React.useCallback(() => {
    if (!enabled) return;
    const { past, future, present } = history;
    if (future.length === 0) return;
    const next = future[0]!;
    setHistory({
      documentKey,
      present: next,
      past: [...past, present].slice(-MAX_HISTORY),
      future: future.slice(1),
    });
    onChange(next);
  }, [documentKey, enabled, history, onChange]);

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  // Keyboard shortcuts
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!enabled) return;
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
  }, [enabled, redo, undo]);

  return { undo, redo, canUndo, canRedo };
}
