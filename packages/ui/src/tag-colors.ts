export type TagColor = {
  bg: string;
  text: string;
};

/**
 * Notion-inspired 10-color pastel palette.
 * Each color has a light tinted bg and a readable dark fg.
 * Order: gray, brown, orange, yellow, green, blue, purple, pink, red, default.
 */
const TAG_PALETTE: TagColor[] = [
  /* gray    */ { bg: "bg-[var(--tag-gray-bg)]", text: "text-[var(--tag-gray-text)]" },
  /* brown   */ { bg: "bg-[var(--tag-brown-bg)]", text: "text-[var(--tag-brown-text)]" },
  /* orange  */ { bg: "bg-[var(--tag-orange-bg)]", text: "text-[var(--tag-orange-text)]" },
  /* yellow  */ { bg: "bg-[var(--tag-yellow-bg)]", text: "text-[var(--tag-yellow-text)]" },
  /* green   */ { bg: "bg-[var(--tag-green-bg)]", text: "text-[var(--tag-green-text)]" },
  /* blue    */ { bg: "bg-[var(--tag-blue-bg)]", text: "text-[var(--tag-blue-text)]" },
  /* purple  */ { bg: "bg-[var(--tag-purple-bg)]", text: "text-[var(--tag-purple-text)]" },
  /* pink    */ { bg: "bg-[var(--tag-pink-bg)]", text: "text-[var(--tag-pink-text)]" },
  /* red     */ { bg: "bg-[var(--tag-red-bg)]", text: "text-[var(--tag-red-text)]" },
  /* default */ { bg: "bg-ui-highlight", text: "text-ui-muted" },
];

const DEFAULT_TAG_COLOR: TagColor = {
  bg: "bg-ui-highlight",
  text: "text-ui-muted",
};

/**
 * Hash a string to a stable index in the palette.
 */
export function hashTagColor(value: string): number {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % TAG_PALETTE.length;
}

/**
 * Resolve a tag color by looking up in an optional color map,
 * falling back to hash-based assignment.
 */
export function resolveTagColor(
  value: string,
  colorMap?: Record<string, TagColor> | null
): TagColor {
  if (!value) return DEFAULT_TAG_COLOR;
  if (colorMap?.[value]) return colorMap[value];
  return TAG_PALETTE[hashTagColor(value)] ?? DEFAULT_TAG_COLOR;
}

export { TAG_PALETTE, DEFAULT_TAG_COLOR };
