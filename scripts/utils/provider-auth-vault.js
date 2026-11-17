const { randomUUID } = require('crypto');

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype;
};

const buildSecretName = (authConfigId) => `provider_auth_configs/${authConfigId}`;

const buildSecretDescription = ({ providerId, authType }) =>
  `provider_auth_configs credentials (provider_id=${providerId}, auth_type=${authType})`;

async function createVaultSecret(client, { authConfigId, providerId, authType, credentials }) {
  const secretName = buildSecretName(authConfigId);
  const secretDescription = buildSecretDescription({ providerId, authType });
  const secretPayload = JSON.stringify(credentials);

  const { rows } = await client.query(
    `
      SELECT vault.create_secret(
        $1::text,
        $2::text,
        $3::text,
        NULL
      ) AS id
    `,
    [secretPayload, secretName, secretDescription],
  );

  if (!rows.length || !rows[0].id) {
    throw new Error('vault.create_secret returned no id');
  }

  return rows[0].id;
}

async function updateVaultSecret(client, { vaultId, authConfigId, providerId, authType, credentials }) {
  const secretName = buildSecretName(authConfigId);
  const secretDescription = buildSecretDescription({ providerId, authType });
  const secretPayload = JSON.stringify(credentials);

  await client.query(
    `
      SELECT vault.update_secret(
        $1::uuid,
        $2::text,
        $3::text,
        $4::text,
        NULL
      )
    `,
    [vaultId, secretPayload, secretName, secretDescription],
  );
}

async function fetchProviderAuthCredentials(client, authConfigId) {
  if (!authConfigId) return null;
  const { rows } = await client.query(
    `SELECT public.get_provider_auth_credentials($1::uuid) AS credentials`,
    [authConfigId],
  );
  return rows[0]?.credentials ?? null;
}

async function fetchProviderAuthCredential(client, authConfigId, key) {
  if (!authConfigId || !key) return null;
  const { rows } = await client.query(
    `SELECT public.get_provider_auth_credential($1::uuid, $2::text) AS value`,
    [authConfigId, key],
  );
  return rows[0]?.value ?? null;
}

async function upsertProviderAuthCredentialsVault(
  client,
  { providerId, authType, credentials, expiresAt = null, authConfigId = null },
) {
  if (!client) throw new Error('client is required');
  if (!providerId) throw new Error('providerId is required');
  if (!authType) throw new Error('authType is required');
  if (!isPlainObject(credentials)) {
    throw new Error('credentials must be a plain object');
  }

  let existing;
  if (authConfigId) {
    const { rows } = await client.query(
      `
        SELECT id, provider_id, auth_type, credentials_vault_id
        FROM public.provider_auth_configs
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [authConfigId],
    );
    if (!rows.length) {
      throw new Error(`provider_auth_configs not found for auth_config_id=${authConfigId}`);
    }
    existing = rows[0];
    if (existing.provider_id !== providerId) {
      throw new Error(`auth_config_id=${authConfigId} does not belong to provider_id=${providerId}`);
    }
    if (existing.auth_type !== authType) {
      throw new Error(`auth_config_id=${authConfigId} auth_type mismatch (expected ${authType})`);
    }
  } else {
    const { rows } = await client.query(
      `
        SELECT id, credentials_vault_id
        FROM public.provider_auth_configs
        WHERE provider_id = $1::uuid
          AND auth_type = $2::text
          AND NOT marketplace_explicit_only
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [providerId, authType],
    );
    existing = rows[0] ?? null;
  }

  if (existing) {
    const id = existing.id;
    let vaultId = existing.credentials_vault_id;

    if (vaultId) {
      await updateVaultSecret(client, {
        vaultId,
        authConfigId: id,
        providerId,
        authType,
        credentials,
      });
    } else {
      vaultId = await createVaultSecret(client, {
        authConfigId: id,
        providerId,
        authType,
        credentials,
      });
    }

    await client.query(
      `
        UPDATE public.provider_auth_configs
        SET credentials_vault_id = $2::uuid,
            credentials = NULL,
            expires_at = $3::timestamptz
        WHERE id = $1::uuid
      `,
      [id, vaultId, expiresAt],
    );

    return { authConfigId: id, credentialsVaultId: vaultId, action: 'updated' };
  }

  const newId = authConfigId || randomUUID();
  const vaultId = await createVaultSecret(client, {
    authConfigId: newId,
    providerId,
    authType,
    credentials,
  });

  await client.query(
    `
      INSERT INTO public.provider_auth_configs (
        id,
        provider_id,
        auth_type,
        credentials_vault_id,
        credentials,
        expires_at
      )
      VALUES (
        $1::uuid,
        $2::uuid,
        $3::text,
        $4::uuid,
        NULL,
        $5::timestamptz
      )
    `,
    [newId, providerId, authType, vaultId, expiresAt],
  );

  return { authConfigId: newId, credentialsVaultId: vaultId, action: 'inserted' };
}

module.exports = {
  fetchProviderAuthCredential,
  fetchProviderAuthCredentials,
  upsertProviderAuthCredentialsVault,
};

