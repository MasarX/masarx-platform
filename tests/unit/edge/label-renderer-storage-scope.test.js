const { readFileSync } = require("node:fs");
const path = require("node:path");

const migration = readFileSync(path.join(
  __dirname, "../../../supabase/migrations/202512271210_edge_label_renderer_storage_access.sql",
), "utf8");

function policy(name) {
  return migration.split(`CREATE POLICY ${name}\n`)[1]?.split(";")[0] ?? "";
}

test("the renderer role can read only the label buckets", () => {
  expect(policy("edge_label_renderer_buckets_read")).toMatch(
    /ON storage\.buckets\s+FOR SELECT\s+TO edge_label_renderer_role\s+USING \(id IN \('labels', 'label-render-assets'\)\)/,
  );
  expect(policy("edge_label_renderer_assets_read")).toMatch(
    /ON storage\.objects\s+FOR SELECT\s+TO edge_label_renderer_role\s+USING \(bucket_id = 'label-render-assets'\)/,
  );
  expect(policy("edge_label_renderer_labels_select")).toMatch(
    /ON storage\.objects\s+FOR SELECT\s+TO edge_label_renderer_role\s+USING \(bucket_id = 'labels'\)/,
  );
});

test("rendered output writes stay scoped to the labels bucket", () => {
  expect(policy("edge_label_renderer_labels_insert")).toMatch(
    /FOR INSERT\s+TO edge_label_renderer_role\s+WITH CHECK \(bucket_id = 'labels'\)/,
  );
  expect(policy("edge_label_renderer_labels_update")).toMatch(
    /FOR UPDATE\s+TO edge_label_renderer_role\s+USING \(bucket_id = 'labels'\)\s+WITH CHECK \(bucket_id = 'labels'\)/,
  );
});
