Deno.serve((req: Request) => {
  const length = req.headers.get("content-length");
  if (length === null ? !["GET", "HEAD", "OPTIONS"].includes(req.method)
    : !/^[0-9]+$/.test(length) || Number(length) > 4096) {
    return new Response(null, { status: 413 });
  }

  return new Response(req.method === "HEAD" ? null : '{"ok":true}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
