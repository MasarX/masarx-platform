const origin = "http://127.0.0.1:9000";
const organizationId = crypto.randomUUID();
const anonKey = crypto.randomUUID();
const draft = {
  organization_id: organizationId,
  label_type: "shipping",
  draft_value: {
    templates: {
      shipping: {
        template_key: "shipping",
        page: { width_inch: 4, height_inch: 6, dpi: 203, orientation: "portrait" },
        blocks: [{
          type: "text", x: 24, y: 24, width: 240, height: 24, font_size: 12,
          text_expr: { op: "literal", value: "Synthetic preview" },
        }],
      },
    },
  },
};
const fixtures = new Map([
  ["/rest/v1/rpc/label_designer_whoami", { ok: true, organization_id: organizationId }],
  ["/rest/v1/label_design_drafts", draft],
  ["/rest/v1/rpc/label_designer_validate_label_design_draft", { ok: true }],
  ["/rest/v1/rpc/label_designer_get_sample_payload", { ok: true, payload: { client_id: crypto.randomUUID() } }],
]);

Deno.serve(async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname !== "/functions/v1/label-renderer") {
    const data = fixtures.get(pathname);
    if (!data || request.headers.get("apikey") !== anonKey) return new Response(null, { status: 404 });
    return Response.json(data);
  }

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: "/renderer",
      allowRemoteModules: false,
      memoryLimitMb: 256,
      workerTimeoutMs: 30_000,
      cpuTimeSoftLimitMs: 10_000,
      cpuTimeHardLimitMs: 20_000,
      envVars: [
        ["EDGE_SUPABASE_URL", origin],
        ["EDGE_SUPABASE_ANON_KEY", anonKey],
        ["EDGE_REQUIRE_DB_JWT", "1"],
        ["LABEL_RENDERER_DB_JWT", crypto.randomUUID()],
        ["LABEL_RENDERER_TOKEN", crypto.randomUUID()],
      ],
    });
    return await worker.fetch(request);
  } catch (error) {
    // Docker keeps raw worker errors out of the CI log. The caller prints only allowed diagnostics.
    console.error(error);
    return Response.json({ code: "fixture_worker_exception" }, { status: 500 });
  }
});
