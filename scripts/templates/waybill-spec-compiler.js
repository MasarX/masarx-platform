/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const applyGeometryTransforms = (fields, mapping, errors) => {
  const raw = Array.isArray(fields) ? fields : [];
  const transforms = Array.isArray(mapping.geometry_transforms) ? mapping.geometry_transforms : [];
  if (transforms.length === 0) return raw;

  const byKey = new Map(raw.filter((f) => f && f.field_key).map((f) => [f.field_key, { ...f }]));

  const applyTableColumns = (t) => {
    const cols = Array.isArray(t.columns) ? t.columns : [];
    const ratios = Array.isArray(t.ratios) ? t.ratios : [];
    if (cols.length < 2) {
      errors.push('geometry_transforms.table_columns requires at least 2 columns');
      return;
    }
    if (ratios.length !== cols.length) {
      errors.push(`geometry_transforms.table_columns ratios length ${ratios.length} != columns length ${cols.length}`);
      return;
    }

    const boxes = cols.map((c) => {
      const boxKey = c.box_field_key;
      const geom = byKey.get(boxKey);
      if (!geom) {
        errors.push(`Missing geometry for table column box_field_key=${boxKey}`);
        return null;
      }
      return { boxKey, geom, fieldKeys: Array.isArray(c.field_keys) ? c.field_keys : [] };
    });
    if (boxes.some((b) => !b)) return;

    const left = Math.min(...boxes.map((b) => b.geom.x_pt));
    const right = Math.max(...boxes.map((b) => b.geom.x_pt + b.geom.width_pt));
    const totalWidth = right - left;
    if (!(totalWidth > 0)) {
      errors.push('geometry_transforms.table_columns has non-positive total width');
      return;
    }

    const ratioSum = ratios.reduce((acc, r) => acc + (Number.isFinite(Number(r)) ? Number(r) : 0), 0);
    if (!(ratioSum > 0)) {
      errors.push('geometry_transforms.table_columns ratios sum must be > 0');
      return;
    }

    let cursor = left;
    for (let i = 0; i < boxes.length; i += 1) {
      const ratio = Number(ratios[i]);
      const newWidth = totalWidth * (ratio / ratioSum);
      const box = boxes[i];
      const oldBox = box.geom;
      const oldBoxX = Number(oldBox.x_pt);
      const oldBoxW = Number(oldBox.width_pt);
      const oldBoxRight = oldBoxX + oldBoxW;
      const newBox = {
        x_pt: cursor,
        width_pt: newWidth,
      };

      const applyField = (fieldKey) => {
        const f = byKey.get(fieldKey);
        if (!f) {
          errors.push(`Missing geometry for table column field_key=${fieldKey} (box=${box.boxKey})`);
          return;
        }
        const padLeft = Number(f.x_pt) - oldBoxX;
        const padRight = oldBoxRight - (Number(f.x_pt) + Number(f.width_pt));
        const nextX = newBox.x_pt + padLeft;
        const nextWidth = newBox.width_pt - padLeft - padRight;
        f.x_pt = Number(nextX.toFixed(2));
        f.width_pt = Number(Math.max(0, nextWidth).toFixed(2));
      };

      // Always apply the box geometry itself if present.
      applyField(box.boxKey);
      for (const fieldKey of box.fieldKeys) applyField(fieldKey);

      cursor += newWidth;
    }
  };

  for (const t of transforms) {
    if (!t || typeof t !== 'object') continue;
    const type = String(t.type || '').toLowerCase();
    if (type === 'table_columns') applyTableColumns(t);
  }

  // Return fields in original order (best-effort), with updates applied.
  return raw.map((f) => (f && f.field_key && byKey.has(f.field_key) ? byKey.get(f.field_key) : f));
};

const computeSectionBoxes = (fields, sectionKeys) => {
  const bySection = new Map();
  for (const f of fields) {
    if (!f || !f.section_key) continue;
    if (!bySection.has(f.section_key)) bySection.set(f.section_key, []);
    bySection.get(f.section_key).push(f);
  }

  const sections = [];
  for (const key of sectionKeys) {
    const list = bySection.get(key) || [];
    if (list.length === 0) {
      sections.push({ section_key: key, missing: true });
      continue;
    }
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const f of list) {
      minX = Math.min(minX, f.x_pt);
      minY = Math.min(minY, f.y_pt);
      maxX = Math.max(maxX, f.x_pt + f.width_pt);
      maxY = Math.max(maxY, f.y_pt + f.height_pt);
    }
    sections.push({
      section_key: key,
      x: Number(minX.toFixed(2)),
      y: Number(minY.toFixed(2)),
      width: Number((maxX - minX).toFixed(2)),
      height: Number((maxY - minY).toFixed(2)),
    });
  }

  return sections;
};

const applySectionOverrides = (sections, overrides = {}) => sections.map((s, idx) => {
  const o = overrides[s.section_key] || {};
  const merged = { ...s, ...o };
  if (merged.z_index == null) merged.z_index = idx;
  if (merged.padding_top == null) merged.padding_top = o.padding_top || 0;
  if (merged.padding_right == null) merged.padding_right = o.padding_right || 0;
  if (merged.padding_bottom == null) merged.padding_bottom = o.padding_bottom || 0;
  if (merged.padding_left == null) merged.padding_left = o.padding_left || 0;
  delete merged.missing;
  return merged;
});

const anchorXFromAlign = (geom, align) => {
  if (!geom) return 0;
  const left = geom.x_pt;
  const width = geom.width_pt;
  if (align === 'center') return left + width / 2;
  if (align === 'right') return left + width;
  return left;
};

const pushSectionSeparatorBlocks = (outBlocks, sectionsByKey, defs = [], errors = []) => {
  for (const def of defs) {
    if (!def || typeof def !== 'object') continue;
    const strokeWidth = def.stroke_width != null ? Number(def.stroke_width) : 1;
    const color = def.color || '#000000';

    let x1 = null;
    let x2 = null;
    let y = null;

    if (Array.isArray(def.between) && def.between.length === 2) {
      const [aKey, bKey] = def.between;
      const a = sectionsByKey.get(aKey);
      const b = sectionsByKey.get(bKey);
      if (!a || !b) {
        errors.push(`Missing geometry for section separator between ${aKey} and ${bKey}`);
        continue;
      }
      const prevBottom = a.y;
      const nextTop = b.y + b.height;
      y = def.mode === 'next_top' ? nextTop : def.mode === 'prev_bottom' ? prevBottom : (prevBottom + nextTop) / 2;
      x1 = Math.min(a.x, b.x);
      x2 = Math.max(a.x + a.width, b.x + b.width);
    } else if (def.at_top_of) {
      const s = sectionsByKey.get(def.at_top_of);
      if (!s) {
        errors.push(`Missing geometry for section separator at_top_of ${def.at_top_of}`);
        continue;
      }
      y = s.y + s.height;
      x1 = s.x;
      x2 = s.x + s.width;
    } else if (def.at_bottom_of) {
      const s = sectionsByKey.get(def.at_bottom_of);
      if (!s) {
        errors.push(`Missing geometry for section separator at_bottom_of ${def.at_bottom_of}`);
        continue;
      }
      y = s.y;
      x1 = s.x;
      x2 = s.x + s.width;
    }

    if (x1 == null || x2 == null || y == null) continue;
    outBlocks.push({
      type: 'line',
      x: Number(x1.toFixed(2)),
      y: Number(y.toFixed(2)),
      width: Number(x2.toFixed(2)),
      height: Number(y.toFixed(2)),
      stroke_width: strokeWidth,
      color,
    });
  }
};

const compileWaybillSpec = (geometry, mapping, opts = {}) => {
  const allowMissing = !!opts.allowMissing;
  const errors = [];

  const rawFields = Array.isArray(geometry.fields) ? geometry.fields : [];
  const fields = applyGeometryTransforms(rawFields, mapping, errors);
  const geomByKey = new Map(fields.filter((f) => f.field_key).map((f) => [f.field_key, f]));

  const page = mapping.page || {};
  const pageConfig = {
    width_inch: page.width_inch || 4,
    height_inch: page.height_inch || 6,
    margin_inch: page.margin_inch || 0.12,
    dpi: page.dpi || 203,
    orientation: page.orientation || 'portrait',
  };

  const numericVersion = typeof mapping.version === 'number' ? mapping.version : null;
  const derivedVersionLabel = numericVersion != null
    ? `${Math.floor(numericVersion / 100)}.${Math.floor((numericVersion % 100) / 10)}.${numericVersion % 10}`
    : null;
  const versionLabel = mapping.version_label || derivedVersionLabel || `${mapping.version || 'unknown'}`;

  const sectionKeys = mapping.sections || Array.from(new Set(fields.map((f) => f.section_key).filter(Boolean)));

  let baseSections;
  if (Array.isArray(geometry.sections) && geometry.sections.length > 0) {
    const byKey = new Map(
      geometry.sections
        .filter((s) => s && s.section_key)
        .map((s) => [s.section_key, s])
    );
    baseSections = sectionKeys.map((key) => {
      const s = byKey.get(key);
      if (!s) return { section_key: key, missing: true };
      return {
        section_key: key,
        x: Number(s.x_pt),
        y: Number(s.y_pt),
        width: Number(s.width_pt),
        height: Number(s.height_pt),
      };
    });
  } else {
    baseSections = computeSectionBoxes(fields, sectionKeys);
  }
  const sections = applySectionOverrides(baseSections, mapping.section_overrides || {});
  for (const s of baseSections) {
    if (s.missing && !allowMissing) errors.push(`Missing geometry for section ${s.section_key}`);
  }
  const sectionsByKey = new Map(sections.filter((s) => s && s.section_key).map((s) => [s.section_key, s]));

  const blocks = [];
  const fieldMappings = mapping.fields || {};
  for (const [fieldKey, def] of Object.entries(fieldMappings)) {
    if (!def || def.ignore) continue;
    const geom = geomByKey.get(fieldKey);
    if (!geom) {
      if (!allowMissing) errors.push(`Missing geometry for field ${fieldKey}`);
      continue;
    }

    let derivedMaxWidth;
    if (def.max_width_from_field && def.max_width == null) {
      const other = geomByKey.get(def.max_width_from_field);
      if (!other) {
        if (!allowMissing) errors.push(`Missing geometry for max_width_from_field=${def.max_width_from_field} (field ${fieldKey})`);
      } else {
        const pad = typeof def.max_width_padding_pt === 'number' ? def.max_width_padding_pt : 0;
        const raw = (other.x_pt - pad) - geom.x_pt;
        derivedMaxWidth = Math.max(0, raw);
      }
    }

    if (def.max_width_from_field_width && def.max_width == null && derivedMaxWidth == null) {
      const other = geomByKey.get(def.max_width_from_field_width);
      if (!other) {
        if (!allowMissing) errors.push(`Missing geometry for max_width_from_field_width=${def.max_width_from_field_width} (field ${fieldKey})`);
      } else {
        const pad = typeof def.max_width_from_field_width_padding_pt === 'number'
          ? def.max_width_from_field_width_padding_pt
          : 0;
        derivedMaxWidth = Math.max(0, other.width_pt - pad);
      }
    }

    let reserveBottom;
    if (def.reserve_bottom_from_field) {
      const other = geomByKey.get(def.reserve_bottom_from_field);
      if (!other) {
        if (!allowMissing) errors.push(`Missing geometry for reserve_bottom_from_field=${def.reserve_bottom_from_field} (field ${fieldKey})`);
      } else {
        const pad = typeof def.reserve_bottom_padding_pt === 'number' ? def.reserve_bottom_padding_pt : 0;
        const raw = (other.y_pt + other.height_pt) - geom.y_pt + pad;
        reserveBottom = Math.max(0, Math.min(raw, geom.height_pt));
      }
    }

    const width = def.width != null ? def.width : geom.width_pt;
    const height = def.height != null ? def.height : geom.height_pt;
    const align = def.align || 'left';
    const x = def.x != null ? def.x : anchorXFromAlign({ ...geom, width_pt: width }, align);
    const yOffset = typeof def.y_offset === 'number' ? def.y_offset : 0;
    const y = def.y != null ? def.y : geom.y_pt + yOffset;

    const block = { ...def };

    if (block.type === 'text') {
      if (block.valign == null && mapping.default_text_valign) block.valign = mapping.default_text_valign;
      if (block.min_font_size == null && mapping.default_text_min_font_size != null) {
        block.min_font_size = mapping.default_text_min_font_size;
      }
      if (block.text_overflow == null && mapping.default_text_overflow) {
        block.text_overflow = mapping.default_text_overflow;
      }
    }
    delete block.ignore;
    delete block.y_offset;
    delete block.max_width_from_field;
    delete block.max_width_padding_pt;
    delete block.max_width_from_field_width;
    delete block.max_width_from_field_width_padding_pt;
    delete block.reserve_bottom_from_field;
    delete block.reserve_bottom_padding_pt;
    if (block.x == null) block.x = Number(x.toFixed(2));
    if (block.y == null) block.y = Number(y.toFixed(2));
    if (block.width == null) block.width = Number(width.toFixed(2));
    if (block.height == null) block.height = Number(height.toFixed(2));
    if (block.max_width == null && typeof derivedMaxWidth === 'number' && derivedMaxWidth > 0) {
      block.max_width = Number(derivedMaxWidth.toFixed(2));
    }
    if (block.reserve_bottom == null && typeof reserveBottom === 'number' && reserveBottom > 0) {
      block.reserve_bottom = Number(reserveBottom.toFixed(2));
    }
    if (!block.section_key && geom.section_key) block.section_key = geom.section_key;
    if (block.section_key == null) delete block.section_key;
    blocks.push(block);
  }

  const derivedStaticBlocks = [];
  pushSectionSeparatorBlocks(
    derivedStaticBlocks,
    sectionsByKey,
    Array.isArray(mapping.section_separator_lines) ? mapping.section_separator_lines : [],
    errors
  );

  const manualStaticBlocks = Array.isArray(mapping.static_blocks) && mapping.static_blocks.length > 0
    ? mapping.static_blocks.map((b) => ({ ...b }))
    : [];

  for (const b of manualStaticBlocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type !== 'line') continue;
    const section = b.section_key ? sectionsByKey.get(b.section_key) : null;
    if (section) {
      if (b.y == null) b.y = section.y;
      if (b.height == null) b.height = section.y + section.height;
    }

    if (b.x == null && b.x_from_field) {
      const geom = geomByKey.get(b.x_from_field);
      if (!geom) errors.push(`Missing geometry for static_blocks line x_from_field=${b.x_from_field}`);
      else b.x = Number(geom.x_pt.toFixed(2));
    }
    if (b.width == null && b.width_from_field) {
      const geom = geomByKey.get(b.width_from_field);
      if (!geom) errors.push(`Missing geometry for static_blocks line width_from_field=${b.width_from_field}`);
      else b.width = Number(geom.x_pt.toFixed(2));
    }
    if (b.width == null && b.x != null) b.width = b.x; // vertical line default

    delete b.x_from_field;
    delete b.width_from_field;
  }

  const staticBlocks = [...derivedStaticBlocks, ...manualStaticBlocks];

  let rectBlocks = [];
  if (mapping.auto_section_rects) {
    const strokeWidth = mapping.section_rect_stroke_width || 1;
    const color = mapping.section_rect_color || '#000000';
    const existingRectKeys = new Set(blocks.filter((b) => b.type === 'rect' && b.section_key).map((b) => b.section_key));
    rectBlocks = sections
      .filter((s) => s && s.section_key && !existingRectKeys.has(s.section_key))
      .map((s) => ({
        type: 'rect',
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        stroke_width: strokeWidth,
        color,
        section_key: s.section_key,
      }));
    blocks.unshift(...rectBlocks);
  }

  // Insert static blocks (lines/rects) right after section rects so they don't overlay text.
  if (staticBlocks.length > 0) {
    if (rectBlocks.length > 0) blocks.splice(rectBlocks.length, 0, ...staticBlocks);
    else blocks.unshift(...staticBlocks);
  }

  if (errors.length) {
    const err = new Error(`compileWaybillSpec failed:\n- ${errors.join('\n- ')}`);
    err.errors = errors;
    throw err;
  }

  return {
    template_key: mapping.template_key,
    version: mapping.version,
    renderer_config: {
      version: versionLabel,
      template_key: mapping.template_key,
      label_type: mapping.label_type || 'shipping',
      page: pageConfig,
      assets: mapping.assets || [],
      blocks,
      barcode: mapping.barcode || { type: 'CODE128', value_path: 'barcode_value', human_readable: false },
      max_attempts: mapping.max_attempts || 5,
      retry_backoff_seconds: mapping.retry_backoff_seconds || [45, 180, 600],
      metadata: mapping.metadata || {},
    },
    sections,
    tokens: mapping.tokens || [],
  };
};

const loadInputs = (geometryPath, mappingPath) => ({
  geometry: readJson(geometryPath),
  mapping: readJson(mappingPath),
});

module.exports = {
  compileWaybillSpec,
  loadInputs,
};
