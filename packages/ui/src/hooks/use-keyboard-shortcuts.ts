"use client";

import * as React from "react";
import {
  isEditableTarget,
  isSequenceShortcut,
  matchesShortcut,
  parseSequenceKeys,
} from "../keyboard-shortcuts";

export type ShortcutDef = {
  /** Key combo string, e.g. "mod+k", "?", "g s" (space-separated for sequences) */
  combo: string;
  /** Action to execute */
  action: () => void;
  /** Optional guard — shortcut only fires when this returns true */
  when?: () => boolean;
  /** Description for help modal display */
  description?: string;
  /** Context group for help modal */
  group?: string;
};

/** Maximum time (ms) between keys in a sequence before the buffer resets. */
const SEQUENCE_TIMEOUT_MS = 800;

/**
 * Registers global keyboard shortcuts that fire on keydown.
 * Automatically suppresses shortcuts when the user is typing in an input/textarea.
 *
 * Supports both modifier combos ("mod+k") and key sequences ("g s").
 * Sequences must be typed within SEQUENCE_TIMEOUT_MS between each key.
 *
 * Usage:
 *   useKeyboardShortcuts([
 *     { combo: "?", action: () => setHelpOpen(true), description: "Show shortcuts help" },
 *     { combo: "/", action: () => searchRef.current?.focus(), description: "Focus search" },
 *     { combo: "mod+k", action: () => setPaletteOpen(true), description: "Command palette" },
 *     { combo: "g s", action: () => navigate("/shipments"), description: "Go to shipments" },
 *   ]);
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDef[]) {
  const shortcutsRef = React.useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const sequenceBufferRef = React.useRef<string[]>([]);
  const sequenceTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    function resetSequence() {
      sequenceBufferRef.current = [];
      if (sequenceTimerRef.current) {
        clearTimeout(sequenceTimerRef.current);
        sequenceTimerRef.current = null;
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.repeat || isEditableTarget(event.target)) {
        resetSequence();
        return;
      }

      const pressedKey = event.key.toLowerCase();

      // First: try non-sequence (modifier/single-key) shortcuts
      for (const shortcut of shortcutsRef.current) {
        if (isSequenceShortcut(shortcut.combo)) continue;
        if (shortcut.when && !shortcut.when()) continue;
        if (matchesShortcut(event, shortcut.combo)) {
          resetSequence();
          event.preventDefault();
          event.stopPropagation();
          shortcut.action();
          return;
        }
      }

      // Collect sequence shortcuts
      const sequenceShortcuts = shortcutsRef.current.filter(
        (s) => isSequenceShortcut(s.combo)
      );
      if (sequenceShortcuts.length === 0) return;

      if (pressedKey.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
        resetSequence();
        return;
      }

      // Reset timer for the next key in the sequence
      if (sequenceTimerRef.current) clearTimeout(sequenceTimerRef.current);
      sequenceBufferRef.current.push(pressedKey);
      sequenceTimerRef.current = setTimeout(resetSequence, SEQUENCE_TIMEOUT_MS);

      const buffer = sequenceBufferRef.current;

      for (const shortcut of sequenceShortcuts) {
        if (shortcut.when && !shortcut.when()) continue;
        const keys = parseSequenceKeys(shortcut.combo);
        if (keys.length !== buffer.length) continue;
        if (keys.every((k, i) => k === buffer[i])) {
          resetSequence();
          event.preventDefault();
          event.stopPropagation();
          shortcut.action();
          return;
        }
      }

      // If no sequence shortcuts could possibly match the current buffer, reset
      const couldMatch = sequenceShortcuts.some((s) => {
        const keys = parseSequenceKeys(s.combo);
        if (keys.length < buffer.length) return false;
        return keys.slice(0, buffer.length).every((k, i) => k === buffer[i]);
      });
      if (!couldMatch) resetSequence();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      resetSequence();
    };
  }, []);
}
