const { createHash } = require('crypto');

function hashUrlTarget(value) {
  let url;
  try {
    url = new URL(String(value || '').trim().replace(/^['"]|['"]$/g, ''));
  } catch {
    return '';
  }
  if (!url.hostname) return '';
  // Connection parameters can carry credentials as well as userinfo.
  const target = url.protocol + '//' + url.host + url.pathname;
  return createHash('sha256').update(target).digest('hex').slice(0, 12);
}

module.exports = { hashUrlTarget };
