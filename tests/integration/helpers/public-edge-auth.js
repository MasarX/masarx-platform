function buildPublicEdgeHeaders(extra = {}, options = {}) {
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
  const includeAuthorization = options.includeAuthorization !== false;

  return {
    ...(anonKey ? { apikey: anonKey } : {}),
    ...(anonKey && includeAuthorization ? { authorization: `Bearer ${anonKey}` } : {}),
    ...extra,
  };
}

module.exports = {
  buildPublicEdgeHeaders,
};
