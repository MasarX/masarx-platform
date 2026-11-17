function decodeJwtPayload(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length < 2) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = normalized.length % 4;
    const padded = padLen === 0 ? normalized : normalized + '='.repeat(4 - padLen);
    const json = Buffer.from(padded, 'base64').toString('utf8');
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

function getJwtRole(token) {
  const payload = decodeJwtPayload(token);
  const role = payload?.role ?? payload?.user_role ?? null;
  if (typeof role !== 'string') return '';
  return role.trim();
}

module.exports = {
  decodeJwtPayload,
  getJwtRole,
};

