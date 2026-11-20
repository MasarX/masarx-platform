import { expect, test } from "@playwright/test";
import { createE2EDatabasePool } from "./utils/db";
import { fetchLookupValueStrings } from "./utils/lookup";

type StatusContract = { table_name: string; column_name: string; lookup_category: string };

function quoteIdentifier(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error("Invalid identifier in status lookup contract.");
  return `"${name}"`;
}

test("registered status columns use values from their lookup contract", async () => {
  const { pool } = await createE2EDatabasePool("schema-status-contracts");
  try {
    const { rows: contracts } = await pool.query<StatusContract>(
      `SELECT table_name, column_name, lookup_category
         FROM public.lookup_column_contracts
        WHERE table_schema = 'public' AND column_name ILIKE '%status%'
        ORDER BY table_name, column_name`,
    );
    expect(contracts.length).toBeGreaterThan(0);
    for (const contract of contracts) {
      const table = quoteIdentifier(contract.table_name);
      const column = quoteIdentifier(contract.column_name);
      const statusValues = await fetchLookupValueStrings(contract.lookup_category);
      expect(statusValues.length, contract.lookup_category).toBeGreaterThan(0);
      const { rows } = await pool.query(
        `SELECT 1 FROM public.${table}
          WHERE ${column} IS NOT NULL AND NOT (${column}::text = ANY($1::text[]))
          LIMIT 1`,
        [statusValues],
      );
      expect(rows, `Invalid status in ${table}.${column}`).toHaveLength(0);
    }
  } finally {
    await pool.end();
  }
});
