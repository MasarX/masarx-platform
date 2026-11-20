import type { Pool, PoolClient } from "pg";
import { createE2EDatabasePool } from "../../e2e/utils/db";

let poolPromise: Promise<Pool> | null = null;

export async function getFieldOpsDatabasePool() {
  if (poolPromise) return poolPromise;
  poolPromise = createE2EDatabasePool("fieldops-pickup")
    .then((resolved) => resolved.pool)
    .catch((error) => {
      poolPromise = null;
      throw error;
    });
  return await poolPromise;
}

export async function withFieldOpsDatabaseClient<T>(run: (client: PoolClient) => Promise<T>) {
  const client = await (await getFieldOpsDatabasePool()).connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}
