async function createWarehouseTransferManifest(client, payload) {
  const { rows } = await client.query(
    `SELECT public.create_warehouse_transfer_manifest_v1($1::jsonb) AS result`,
    [JSON.stringify(payload)]
  );
  return rows[0]?.result ?? null;
}

async function createWarehouseTransferManifestApi(client, payload) {
  const { rows } = await client.query(
    `SELECT api.create_warehouse_transfer_manifest_v1($1::jsonb) AS result`,
    [JSON.stringify(payload)]
  );
  return rows[0]?.result ?? null;
}

module.exports = {
  createWarehouseTransferManifest,
  createWarehouseTransferManifestApi,
};
