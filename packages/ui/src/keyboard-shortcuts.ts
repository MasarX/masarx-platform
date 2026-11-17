"use client";

function normalizeShortcut(shortcut: string) {
  return shortcut.toLowerCase().replace(/\s+/g, "").trim();
}

export function isEditableTarget(target: EventTarget | null) {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (target.isContentEditable) return true;
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;
  const parts = normalized.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key) return false;

  const requiresCtrl = parts.includes("ctrl") || parts.includes("control");
  const requiresMeta =
    parts.includes("meta") ||
    parts.includes("cmd") ||
    parts.includes("command");
  const requiresShift = parts.includes("shift");
  const requiresAlt = parts.includes("alt") || parts.includes("option");
  const requiresMod = parts.includes("mod");

  if (requiresCtrl && !event.ctrlKey) return false;
  if (requiresMeta && !event.metaKey) return false;
  if (requiresShift && !event.shiftKey) return false;
  if (requiresAlt && !event.altKey) return false;
  if (requiresMod && !(event.metaKey || event.ctrlKey)) return false;

  return event.key.toLowerCase() === key;
}

export function formatShortcutLabel(shortcut: string) {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "";
  const parts = normalized.split("+").filter(Boolean);
  return parts
    .map((part) => {
      switch (part) {
        case "cmd":
        case "command":
        case "meta":
          return "Cmd";
        case "ctrl":
        case "control":
          return "Ctrl";
        case "shift":
          return "Shift";
        case "alt":
        case "option":
          return "Alt";
        case "mod":
          return "Ctrl/Cmd";
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    })
    .join("+");
}
