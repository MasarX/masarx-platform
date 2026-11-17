const HEADER_TOP_PADDING_MIN = 16;
const HEADER_TOP_PADDING_OFFSET = 8;
const CONTENT_BOTTOM_PADDING_BASE = 16;
const NAV_MODAL_BOTTOM_PADDING_BASE = 24;

function normalizeInset(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

export function resolveHeaderTopPadding(insetTop: number) {
  const safeTop = normalizeInset(insetTop);
  return Math.max(HEADER_TOP_PADDING_MIN, safeTop + HEADER_TOP_PADDING_OFFSET);
}

export function resolveContentBottomPadding(insetBottom: number) {
  const safeBottom = normalizeInset(insetBottom);
  return CONTENT_BOTTOM_PADDING_BASE + safeBottom;
}

export function resolveNavModalBottomPadding(insetBottom: number) {
  const safeBottom = normalizeInset(insetBottom);
  return NAV_MODAL_BOTTOM_PADDING_BASE + safeBottom;
}
