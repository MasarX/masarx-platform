const { readFileSync } = require("node:fs");

const KEEP = 3;
const PAGE_SIZE = 20;
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function prunePreviewDeployments(env, receipt, fetchImpl = fetch, log = console) {
  if (env.DEPLOY_ENV !== "dev") return;

  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const project = env.CLOUDFLARE_PAGES_PROJECT_LANDING;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(account) || !project || !/^[a-z0-9][a-z0-9-]*$/.test(project) ||
      !token || receipt?.pages_project !== project || receipt?.environment !== "preview" ||
      !ID.test(receipt?.deployment_id)) {
    log.warn("::warning::Landing preview pruning skipped. The new preview could not be identified.");
    return;
  }

  const deploymentId = receipt.deployment_id;
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${project}/deployments`;
  const signal = AbortSignal.timeout(60_000);
  async function request(suffix, method) {
    const response = await fetchImpl(url + suffix, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal,
    });
    if (!response.ok) throw new Error("Pages request failed");
    const data = await response.json();
    if (data?.success !== true) throw new Error("Pages request failed");
    return data;
  }

  const previews = [];
  try {
    const seen = new Set();
    for (let page = 1; ; page++) {
      const { result, result_info: info } = await request(`?env=preview&per_page=${PAGE_SIZE}&page=${page}`, "GET");
      if (!Array.isArray(result) || (info?.page != null && info.page !== page)) {
        throw new Error("Invalid Pages list page");
      }
      for (const entry of result) {
        if (!ID.test(entry.id) || seen.has(entry.id)) throw new Error("Invalid Pages deployment list");
        seen.add(entry.id);
        if (entry.environment !== "preview") continue;
        const created = Date.parse(entry.created_on);
        if (!Number.isFinite(created) || (entry.aliases != null && !Array.isArray(entry.aliases))) {
          throw new Error("Invalid Pages preview metadata");
        }
        previews.push({ id: entry.id, aliases: entry.aliases, latestStage: entry.latest_stage, created });
      }
      if (Number.isInteger(info?.total_pages) ? page >= info.total_pages : result.length < PAGE_SIZE) break;
    }
    const current = previews.find(({ id }) => id === deploymentId);
    if (current?.latestStage?.name !== "deploy" || current.latestStage.status !== "success") {
      throw new Error("New preview deploy is unconfirmed");
    }
  } catch {
    log.warn("::warning::Landing preview pruning skipped. The preview list or new deployment could not be verified.");
    return;
  }

  previews.sort((first, second) => second.created - first.created);
  const candidates = previews.slice(KEEP).filter(({ id, aliases }) => id !== deploymentId && !aliases?.length);
  let deleted = 0;
  for (const { id } of candidates) {
    if (signal.aborted) break;
    try {
      // Keep the provider's alias protection enabled if aliases move after listing.
      await request(`/${id}?force=false`, "DELETE");
      deleted++;
      log.log(`Deleted landing preview ${id.slice(0, 8)}`);
    } catch {
      // Report failures as a count without printing provider diagnostics.
    }
  }
  log.log(`Landing previews listed: ${previews.length}, kept: ${previews.length - deleted}, deleted: ${deleted}`);
  if (deleted < candidates.length) {
    log.warn(`::warning::Landing preview deletions incomplete: ${candidates.length - deleted}`);
  }
}

if (require.main === module && process.env.DEPLOY_ENV === "dev") {
  let receipt;
  try {
    receipt = readFileSync(process.argv[2], "utf8").trim().split("\n").map(JSON.parse)
      .find((entry) => entry.type === "pages-deploy-detailed" && entry.version === 1);
  } catch {
    // A missing or invalid receipt leaves every deployment in place.
  }
  void prunePreviewDeployments(process.env, receipt);
}

module.exports = { prunePreviewDeployments };
