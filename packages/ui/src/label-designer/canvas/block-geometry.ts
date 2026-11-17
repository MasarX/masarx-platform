import { DEFAULT_PAGE, POINTS_PER_INCH, type PageConfig, type TemplateBlock } from "./canvas-types";
import { getBarcodeConfig, normalizeBarcodeType } from "./barcode-types";

function finite(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Keep authored geometry in points inside the whole page, including oversized additions. */
export function fitBlockToPage(block: TemplateBlock, page: Partial<PageConfig>, previous?: TemplateBlock): TemplateBlock {
  if (previous && block.x === previous.x && block.y === previous.y &&
      block.width === previous.width && block.height === previous.height && block.align === previous.align &&
      block.max_width === previous.max_width && block.max_height === previous.max_height) return block;
  const pageWidth = Math.max(1, finite(page.width_inch, DEFAULT_PAGE.width_inch) * POINTS_PER_INCH);
  const pageHeight = Math.max(1, finite(page.height_inch, DEFAULT_PAGE.height_inch) * POINTS_PER_INCH);
  const width = Math.min(pageWidth, Math.max(0, finite(block.width ?? block.max_width, 0)));
  const height = Math.min(pageHeight, Math.max(0, finite(block.height ?? block.max_height, 0)));
  const anchored = ["text", "barcode", "image"].includes(block.type);
  const anchorOffset = anchored && block.align === "right" ? width
    : anchored && block.align === "center" ? width / 2 : 0;
  const extentWidth = block.type === "line" ? 0 : width;
  const extentHeight = block.type === "line" ? 0 : height;
  return {
    ...block,
    ...(block.width === undefined ? {} : { width }),
    ...(block.height === undefined ? {} : { height }),
    x: Math.min(Math.max(anchorOffset, finite(block.x, 0)), pageWidth - extentWidth + anchorOffset),
    y: Math.min(Math.max(0, finite(block.y, 0)), pageHeight - extentHeight),
  };
}

/** Defaults apply only to new blocks; existing designs are not silently rewritten. */
export function prepareAddedBlock(block: TemplateBlock, page: Partial<PageConfig>): TemplateBlock {
  const config = block.type === "barcode" ? getBarcodeConfig(block.barcode_type || "code128") : undefined;
  const width = block.type === "barcode" ? config?.defaultWidth ?? 180
    : block.type === "image" ? 80 : block.type === "line" ? 200 : block.type === "rect" ? 100 : 150;
  const height = block.type === "barcode" ? config?.defaultHeight ?? 60
    : block.type === "image" ? 40 : block.type === "line" ? 0 : block.type === "rect" ? 60 : 20;
  const next = { ...block, width: finite(block.width, width), height: finite(block.height, height) };
  if (block.type === "text") {
    next.font_size = finite(block.font_size, 12);
    next.fallback = block.fallback ?? block.value_path ?? "Text";
  } else if (block.type === "barcode") {
    next.barcode_type = normalizeBarcodeType(block.barcode_type || "code128");
    next.value_path = block.value_path ?? "barcode_value";
    const samples: Record<string, string> = { ean13: "590123412345", upca: "01234567890" };
    next.fallback = block.fallback ?? samples[next.barcode_type] ?? "TRACKING";
    next.human_readable = block.human_readable ?? false;
  }
  return fitBlockToPage(next, page);
}

export function placeAddedBlock(block: TemplateBlock, blocks: TemplateBlock[], page: Partial<PageConfig>) {
  const next = prepareAddedBlock(block, page);
  if (!["text", "barcode", "image"].includes(next.type)) return next;
  const bottoms = blocks.filter((item) => ["text", "barcode", "image"].includes(item.type))
    .map((item) => finite(item.y, 0) + finite(item.height, 20));
  // A full page may overlap, but an addition never escapes its bounds.
  return fitBlockToPage({ ...next, y: bottoms.length ? Math.max(...bottoms) + 8 : next.y }, page);
}
