const { buildFixtureProfile } = require('../../../scripts/tests/bootstrap/lib/integration-fixtures');
const { ensureIntegrationFixtures } = require('../../../scripts/tests/bootstrap/lib/integration-fixtures');

function getIntegrationFixtureProfile(env = process.env) {
  return buildFixtureProfile(env);
}

let fixtureEnsurePromise = null;

async function ensureIntegrationFixturesPresent() {
  if (!fixtureEnsurePromise) {
    fixtureEnsurePromise = ensureIntegrationFixtures({
      env: process.env,
      changeReason: 'integration helper fixture ensure',
    }).catch((error) => {
      fixtureEnsurePromise = null;
      throw error;
    });
  }
  return fixtureEnsurePromise;
}

async function resolveSourceByToken(pool, token) {
  const { rows } = await pool.query(
    `
      SELECT id, organization_id, sender_id, source_identifier, auth_token
      FROM public.webhook_sources
      WHERE auth_token = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [token],
  );
  return rows[0] || null;
}

async function resolveFixtureClientBySlug(pool, slug) {
  const { rows } = await pool.query(
    `
      SELECT id, organization_id, slug
      FROM public.clients
      WHERE slug = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [slug],
  );
  return rows[0] || null;
}

async function resolvePrimaryFixtureOrgClientSender(pool) {
  await ensureIntegrationFixturesPresent();

  const profile = getIntegrationFixtureProfile();
  const preferredClientSlug = profile.clients.oneOne.slug;
  const preferredSenderName = profile.senders.oneOne.name;

  const resolvePreferred = async () =>
    pool.query(
      `
        SELECT
          o.id AS organization_id,
          c.id AS client_id,
          s.id AS sender_id
        FROM public.organizations o
        JOIN public.clients c ON c.organization_id = o.id
        JOIN public.senders s ON s.client_id = c.id
        WHERE o.slug = $1
          AND c.slug = $2
          AND s.name = $3
        ORDER BY s.created_at
        LIMIT 1
      `,
      [profile.organizations.alpha.slug, preferredClientSlug, preferredSenderName],
    );

  let { rows } = await resolvePreferred();

  if (rows.length) return rows[0];

  const fallback = await pool.query(
    `
      SELECT
        o.id AS organization_id,
        c.id AS client_id,
        s.id AS sender_id
      FROM public.organizations o
      JOIN public.clients c ON c.organization_id = o.id
      JOIN public.senders s ON s.client_id = c.id
      ORDER BY o.created_at, c.created_at, s.created_at
      LIMIT 1
    `,
  );
  return fallback.rows[0] || null;
}

module.exports = {
  ensureIntegrationFixturesPresent,
  getIntegrationFixtureProfile,
  resolveFixtureClientBySlug,
  resolvePrimaryFixtureOrgClientSender,
  resolveSourceByToken,
};
