import type { UiNavigation, UiNavigationItem } from "./index";

export function normalizeNavigation(input?: UiNavigation | null): UiNavigation {
  const normalizeItems = (
    items: UiNavigationItem[] | null | undefined
  ): UiNavigationItem[] => {
    if (!Array.isArray(items)) return [];
    return items.map((item) => ({
      ...item,
      items: normalizeItems(item.items),
    }));
  };

  const sections = Array.isArray(input?.sections)
    ? input.sections.map((section) => ({
        ...section,
        items: normalizeItems(section.items),
      }))
    : [];

  return {
    app: input?.app ?? null,
    sections,
  };
}

