/* eslint-disable no-console */
const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const normalizeNodeId = (nodeId) => {
  if (!nodeId) return '';
  return String(nodeId).trim().replace(/-/g, ':');
};

const parseFigmaUrl = (urlStr) => {
  try {
    const u = new URL(String(urlStr));
    const parts = u.pathname.split('/').filter(Boolean);
    const designIdx = parts.indexOf('design');
    if (designIdx === -1 || !parts[designIdx + 1]) return null;
    const fileKey = parts[designIdx + 1];
    const nodeParam = u.searchParams.get('node-id') || u.searchParams.get('node_id');
    const nodeId = normalizeNodeId(nodeParam || '');
    if (!fileKey || !nodeId) return null;
    return { fileKey, nodeId };
  } catch {
    return null;
  }
};

const parseTag = (name) => {
  const n = String(name || '').trim();
  const lower = n.toLowerCase();
  const match = (prefix) => {
    if (lower.startsWith(`${prefix}:`)) return n.slice(prefix.length + 1).trim();
    if (lower.startsWith(`${prefix}/`)) return n.slice(prefix.length + 1).trim();
    return null;
  };
  const sectionKey = match('section');
  if (sectionKey) return { kind: 'section', key: sectionKey };
  const fieldKey = match('field');
  if (fieldKey) return { kind: 'field', key: fieldKey };
  return null;
};

const hasAbsBox = (node) => node && node.absoluteBoundingBox
  && typeof node.absoluteBoundingBox.x === 'number'
  && typeof node.absoluteBoundingBox.y === 'number'
  && typeof node.absoluteBoundingBox.width === 'number'
  && typeof node.absoluteBoundingBox.height === 'number';

const walk = (node, visit, ctx = {}) => {
  if (!node || typeof node !== 'object') return;
  visit(node, ctx);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) {
    walk(child, visit, ctx);
  }
};

const findNode = (root, pred) => {
  let found = null;
  walk(root, (node) => {
    if (found) return;
    if (pred(node)) found = node;
  });
  return found;
};

const LABEL_FRAME_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE']);

const findMatchingFrames = (root, expectedWidthPx, expectedHeightPx, tolerancePx = 2) => {
  const matches = [];
  walk(root, (node) => {
    if (!node || !LABEL_FRAME_TYPES.has(node.type)) return;
    if (!hasAbsBox(node)) return;
    const w = node.absoluteBoundingBox.width;
    const h = node.absoluteBoundingBox.height;
    if (Math.abs(w - expectedWidthPx) <= tolerancePx && Math.abs(h - expectedHeightPx) <= tolerancePx) {
      matches.push(node);
    }
  });
  return matches;
};

const resolveRootFrame = (root, opts) => {
  const expectedWidthPx = opts.expectedWidthPx;
  const expectedHeightPx = opts.expectedHeightPx;
  const tolerancePx = opts.tolerancePx ?? 2;

  if (root && LABEL_FRAME_TYPES.has(root.type) && hasAbsBox(root)) {
    const { width, height } = root.absoluteBoundingBox;
    if (Math.abs(width - expectedWidthPx) <= tolerancePx && Math.abs(height - expectedHeightPx) <= tolerancePx) {
      return root;
    }
  }

  const matches = findMatchingFrames(root, expectedWidthPx, expectedHeightPx, tolerancePx);
  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    const list = matches
      .slice(0, 5)
      .map((node) => `${node.id} "${node.name}" ${node.absoluteBoundingBox.width}x${node.absoluteBoundingBox.height}`)
      .join(', ');
    throw new Error(`Multiple candidate label frames match ${expectedWidthPx}x${expectedHeightPx}px: ${list}${matches.length > 5 ? ', ...' : ''}`);
  }

  const rootInfo = root && hasAbsBox(root)
    ? `${root.id || '(no id)'} "${root.name || '(no name)'}" ${root.absoluteBoundingBox.width}x${root.absoluteBoundingBox.height}`
    : '(no bounding box)';
  throw new Error(`No label frame found matching ${expectedWidthPx}x${expectedHeightPx}px under node (${rootInfo})`);
};

const convertAbsBoxToPt = (absBox, rootAbsBox, pagePt, scale) => {
  const relX = absBox.x - rootAbsBox.x;
  const relY = absBox.y - rootAbsBox.y; // top-origin
  const widthPt = absBox.width * scale.x;
  const heightPt = absBox.height * scale.y;
  const xPt = relX * scale.x;
  const yTopPt = relY * scale.y;
  const yPt = pagePt.height - (yTopPt + heightPt); // convert to PDF bottom-origin
  return {
    x_pt: Number(xPt.toFixed(2)),
    y_pt: Number(yPt.toFixed(2)),
    width_pt: Number(widthPt.toFixed(2)),
    height_pt: Number(heightPt.toFixed(2)),
  };
};

const inside = (box, container, tol = 0.5) => (
  box.x >= container.x - tol
  && box.y >= container.y - tol
  && (box.x + box.width) <= (container.x + container.width + tol)
  && (box.y + box.height) <= (container.y + container.height + tol)
);

const extractTaggedWaybillGeometry = (rootNode, opts) => {
  const pageWidthInch = toNumber(opts.pageWidthInch) ?? 4;
  const pageHeightInch = toNumber(opts.pageHeightInch) ?? 6;
  const dpi = toNumber(opts.dpi) ?? 203;

  const expectedWidthPx = Math.round(pageWidthInch * dpi);
  const expectedHeightPx = Math.round(pageHeightInch * dpi);

  const rootFrame = resolveRootFrame(rootNode, {
    expectedWidthPx,
    expectedHeightPx,
    tolerancePx: opts.tolerancePx ?? 2,
  });

  const rootAbsBox = rootFrame.absoluteBoundingBox;
  const pagePt = { width: pageWidthInch * 72, height: pageHeightInch * 72 };
  const scale = { x: pagePt.width / rootAbsBox.width, y: pagePt.height / rootAbsBox.height };
  const scaleDelta = Math.abs(scale.x - scale.y) / (scale.x || 1);
  if (scaleDelta > 0.01) {
    throw new Error(`Non-uniform scale detected: scaleX=${scale.x.toFixed(6)} scaleY=${scale.y.toFixed(6)} (check frame aspect ratio)`);
  }

  const exportRoot = findNode(rootFrame, (node) => String(node?.name || '').trim().toLowerCase() === 'export')
    || findNode(rootFrame, (node) => String(node?.name || '').trim().toLowerCase() === '__export__');
  if (!exportRoot) {
    throw new Error('Missing EXPORT group inside the label frame. Add a group named "EXPORT" and place section/field tags under it.');
  }

  const sectionsAbs = new Map();
  const fieldsAbs = [];

  const stack = [];
  const walkTagged = (node) => {
    const tag = parseTag(node.name);
    const isSection = tag && tag.kind === 'section';
    const isField = tag && tag.kind === 'field';

    if (isSection) stack.push(tag.key);
    if (tag && (isSection || isField) && hasAbsBox(node)) {
      const sectionKey = isField ? (stack.length ? stack[stack.length - 1] : null) : tag.key;
      const abs = node.absoluteBoundingBox;
      if (isSection) {
        sectionsAbs.set(tag.key, abs);
      } else {
        fieldsAbs.push({ field_key: tag.key, section_key: sectionKey, abs });
      }
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walkTagged(child);

    if (isSection) stack.pop();
  };
  walkTagged(exportRoot);

  if (sectionsAbs.size === 0) {
    throw new Error('No section tags found. Add frames named like "section:header", "section:sender", etc. under EXPORT.');
  }
  if (fieldsAbs.length === 0) {
    throw new Error('No field tags found. Add rectangles/text named like "field:tracking_barcode", etc. under EXPORT.');
  }

  // Assign section by containment for fields without an ancestor section.
  const sectionsListAbs = Array.from(sectionsAbs.entries()).map(([k, abs]) => ({ section_key: k, abs }));
  for (const f of fieldsAbs) {
    if (f.section_key) continue;
    const matches = sectionsListAbs.filter((s) => inside(f.abs, s.abs, 1));
    if (matches.length === 1) f.section_key = matches[0].section_key;
    else if (matches.length === 0) throw new Error(`Field ${f.field_key} is not inside any section box; nest it under section:* or place it within a section rectangle.`);
    else throw new Error(`Field ${f.field_key} matches multiple sections (${matches.map((m) => m.section_key).join(', ')}); nest it under the correct section.`);
  }

  const sections = sectionsListAbs
    .map((s) => ({
      section_key: s.section_key,
      ...convertAbsBoxToPt(s.abs, rootAbsBox, pagePt, scale),
    }))
    .sort((a, b) => (b.y_pt - a.y_pt) || a.section_key.localeCompare(b.section_key));

  const fields = fieldsAbs
    .map((f) => ({
      section_key: f.section_key,
      field_key: f.field_key,
      ...convertAbsBoxToPt(f.abs, rootAbsBox, pagePt, scale),
    }))
    .sort((a, b) => (b.y_pt - a.y_pt) || a.field_key.localeCompare(b.field_key));

  return {
    source: 'figma',
    dpi,
    page_pt: { width: pagePt.width, height: pagePt.height },
    root_frame: { id: rootFrame.id, name: rootFrame.name, width_px: rootAbsBox.width, height_px: rootAbsBox.height },
    sections,
    fields,
  };
};

module.exports = {
  normalizeNodeId,
  parseFigmaUrl,
  extractTaggedWaybillGeometry,
};
