async function resolveOrganizationId(client, options = {}) {
  const organizationId = options.organizationId || null;
  const organizationSlug = options.organizationSlug || null;

  if (organizationId) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM organizations WHERE id = $1::uuid',
      [organizationId],
    );
    if (!rowCount) {
      throw new Error(`Organization not found: ${organizationId}`);
    }
    return organizationId;
  }

  if (organizationSlug) {
    const { rows } = await client.query(
      'SELECT id FROM organizations WHERE slug = $1 LIMIT 1',
      [organizationSlug],
    );
    if (!rows.length) {
      throw new Error(`Organization not found for slug: ${organizationSlug}`);
    }
    return rows[0].id;
  }

  return null;
}

async function resolveProvider(client, providerName, options = {}) {
  if (!providerName || typeof providerName !== 'string') {
    throw new Error('providerName is required');
  }

  const orgId = await resolveOrganizationId(client, options);

  if (orgId) {
    const { rows } = await client.query(
      `
        SELECT id
        FROM providers
        WHERE organization_id = $1::uuid
          AND name = $2
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [orgId, providerName],
    );
    if (!rows.length) {
      throw new Error(
        `Provider not found: ${providerName} (organization_id=${orgId})`,
      );
    }
    return { providerId: rows[0].id, organizationId: orgId };
  }

  const { rows } = await client.query(
    `
      SELECT p.id, p.organization_id, o.slug AS organization_slug
      FROM providers p
      JOIN organizations o ON o.id = p.organization_id
      WHERE p.name = $1
      ORDER BY o.slug, p.created_at DESC
    `,
    [providerName],
  );

  if (!rows.length) {
    throw new Error(`Provider not found: ${providerName}`);
  }

  const organizations = [...new Set(rows.map((r) => r.organization_id))];
  if (organizations.length === 1) {
    return {
      providerId: rows[0].id,
      organizationId: rows[0].organization_id,
      organizationSlug: rows[0].organization_slug,
    };
  }

  const slugs = [...new Set(rows.map((r) => r.organization_slug))].sort();
  throw new Error(
    `Provider ${providerName} exists in multiple organizations (${slugs.join(
      ', ',
    )}). Provide --organization-id or --organization-slug.`,
  );
}

module.exports = { resolveOrganizationId, resolveProvider };

