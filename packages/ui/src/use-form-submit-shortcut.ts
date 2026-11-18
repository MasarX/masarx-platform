"use client";

import { useCallback, useEffect } from "react";
import { isEditableTarget } from "./keyboard-shortcuts";

type UseFormSubmitShortcutOptions = {
  /** React ref to the <form> element */
  formRef: React.RefObject<HTMLFormElement | null>;
  /** Whether the form is currently submitting (disables the shortcut) */
  isSubmitting?: boolean;
  /** Whether the shortcut is enabled (default: true) */
  enabled?: boolean;
};

/**
 * Adds a Ctrl+Enter (or Cmd+Enter on macOS) keyboard shortcut to submit a form.
 * Only fires when focus is inside an editable element (input, textarea, select,
 * or contentEditable) so it does not conflict with other global shortcuts.
 */
export function useFormSubmitShortcut({
  formRef,
  isSubmitting,
  enabled = true,
}: UseFormSubmitShortcutOptions) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled || isSubmitting) return;
      if (event.key !== "Enter") return;
      if (!event.ctrlKey && !event.metaKey) return;

      // Only trigger when focus is inside an editable field
      if (!isEditableTarget(event.target)) return;

      const form = formRef.current;
      if (!form) return;

      // Check if the form element is an ancestor of the focused element
      if (!form.contains(event.target as Node)) return;

      event.preventDefault();
      event.stopPropagation();

      // Use requestSubmit to trigger validation and submit handlers
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
      } else {
        form.submit();
      }
    },
    [formRef, isSubmitting, enabled],
  );

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, handleKeyDown]);
}
