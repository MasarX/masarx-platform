const normalize = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return v;
};

const evaluateCondition = (condition, payload, resolvePathValue) => {
  if (!condition || typeof condition !== 'object') return true;
  const path = typeof condition.path === 'string' ? condition.path : null;
  if (!path) return true;

  if (typeof resolvePathValue !== 'function') return true;

  let current = normalize(resolvePathValue(payload, path));
  if (current === null && condition.default !== undefined) current = normalize(condition.default);

  if (Object.prototype.hasOwnProperty.call(condition, 'equals')) {
    return current === normalize(condition.equals);
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'not_equals')) {
    return current !== normalize(condition.not_equals);
  }
  if (Array.isArray(condition.in)) {
    return condition.in.map(normalize).includes(current);
  }
  if (Array.isArray(condition.not_in)) {
    return !condition.not_in.map(normalize).includes(current);
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'exists')) {
    const want = !!condition.exists;
    const exists = current !== null && current !== '';
    return want ? exists : !exists;
  }
  if (Object.prototype.hasOwnProperty.call(condition, 'truthy')) {
    const want = !!condition.truthy;
    return want ? !!current : !current;
  }
  return true;
};

const shouldRenderBlock = (block, payload, resolvePathValue) => {
  if (!block || typeof block !== 'object') return false;
  const renderIf = block.render_if;
  if (!renderIf) return true;
  const list = Array.isArray(renderIf) ? renderIf : [renderIf];
  return list.every((cond) => evaluateCondition(cond, payload, resolvePathValue));
};

module.exports = {
  shouldRenderBlock,
};
