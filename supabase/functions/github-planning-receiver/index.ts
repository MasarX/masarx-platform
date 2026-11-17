import {
  logStructured,
  parseRequestBody,
  readEnv,
  resolveCorrelationId,
} from "./_shared/mod.mjs";

const SERVICE_NAME = "github-planning-receiver";
const WEBHOOK_SECRET = readEnv("GITHUB_WEBHOOK_SECRET");
const WORKFLOW_TOKEN = readEnv("GITHUB_PLANNING_WORKFLOW_TOKEN");
const WORKFLOW_REPO = readEnv("GITHUB_PLANNING_WORKFLOW_REPO", ["GITHUB_REPOSITORY"]) || "MasarX/MasarX";
const WORKFLOW_FILE = readEnv("GITHUB_PLANNING_WORKFLOW_FILE") || "planning-project-event.yml";
const WORKFLOW_REF = readEnv("GITHUB_PLANNING_WORKFLOW_REF") || "dev";
const PROJECT_NUMBER = readEnv("GITHUB_PLANNING_PROJECT_NUMBER") || "6";

const textEncoder = new TextEncoder();

type DispatchPayload = {
  itemId: string;
  action: string;
  eventName: string;
  deliveryId: string;
};

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function splitRepo(fullName: string): { owner: string; repo: string } {
  const raw = String(fullName || "").trim();
  const match = /^([^/]+)\/([^/]+)$/.exec(raw);
  return match ? { owner: match[1], repo: match[2] } : { owner: "", repo: "" };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = String(hex || "").trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

async function verifySignature(rawBody: string, signatureHeader: string): Promise<boolean> {
  const signature = String(signatureHeader || "").trim();
  if (!signature.startsWith("sha256=") || !WEBHOOK_SECRET) return false;
  const provided = hexToBytes(signature.replace(/^sha256=/, ""));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const actual = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, textEncoder.encode(rawBody)));
  if (actual.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i] ^ provided[i];
  return diff === 0;
}

function extractItemId(payload: Record<string, unknown>): string {
  const projectItem = payload.projects_v2_item as Record<string, unknown> | undefined;
  if (projectItem) {
    const direct = String(projectItem.node_id || projectItem.id || "").trim();
    if (direct) return direct;
    const itemNode = projectItem.item as Record<string, unknown> | undefined;
    const nested = String(itemNode?.node_id || itemNode?.id || "").trim();
    if (nested) return nested;
  }
  const projectsV2Item = payload.project_v2_item as Record<string, unknown> | undefined;
  return String(projectsV2Item?.node_id || projectsV2Item?.id || "").trim();
}

async function dispatchWorkflow({ itemId, action, eventName, deliveryId }: DispatchPayload): Promise<void> {
  const { owner, repo } = splitRepo(WORKFLOW_REPO);
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_PLANNING_WORKFLOW_REPO: ${WORKFLOW_REPO}`);
  }
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(WORKFLOW_FILE)}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${WORKFLOW_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": SERVICE_NAME,
      },
      body: JSON.stringify({
        ref: WORKFLOW_REF,
        inputs: {
          project_number: PROJECT_NUMBER,
          item_id: itemId,
          event_name: eventName,
          event_action: action,
          delivery_id: deliveryId,
        },
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Workflow dispatch failed (${response.status}): ${detail || response.statusText}`);
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const correlationId = resolveCorrelationId(req);
  const eventName = String(req.headers.get("x-github-event") || "").trim();
  const deliveryId = String(req.headers.get("x-github-delivery") || "").trim();

  if (req.method === "GET") {
    return jsonResponse(200, { status: "ok", service: SERVICE_NAME });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed" });
  }

  if (!WEBHOOK_SECRET || !WORKFLOW_TOKEN) {
    logStructured("error", "github_planning_receiver.config.invalid", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      has_webhook_secret: Boolean(WEBHOOK_SECRET),
      has_workflow_token: Boolean(WORKFLOW_TOKEN),
    });
    return jsonResponse(500, { error: "receiver_not_configured" });
  }

  const signature = String(req.headers.get("x-hub-signature-256") || "").trim();
  const { raw: rawBody, json } = await parseRequestBody(req);
  const validSignature = await verifySignature(rawBody, signature);
  if (!validSignature) {
    logStructured("warn", "github_planning_receiver.signature.invalid", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      delivery_id: deliveryId,
      event_name: eventName,
    });
    return jsonResponse(401, { error: "invalid_signature" });
  }

  if (eventName === "ping") {
    return jsonResponse(202, { status: "accepted_ping" });
  }

  const payload = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const action = String(payload.action || "").trim() || "unknown";
  const itemId = extractItemId(payload);

  if (eventName !== "projects_v2" && eventName !== "projects_v2_item") {
    logStructured("info", "github_planning_receiver.event.ignored", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      delivery_id: deliveryId,
      event_name: eventName,
      action,
    });
    return jsonResponse(202, { status: "ignored", event_name: eventName });
  }

  if (!itemId) {
    logStructured("warn", "github_planning_receiver.item.missing", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      delivery_id: deliveryId,
      event_name: eventName,
      action,
    });
    return jsonResponse(202, { status: "ignored", reason: "missing_item_id", event_name: eventName, action });
  }

  try {
    await dispatchWorkflow({
      itemId,
      action,
      eventName,
      deliveryId,
    });
    logStructured("info", "github_planning_receiver.event.dispatched", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      delivery_id: deliveryId,
      event_name: eventName,
      action,
      item_id: itemId,
    });
    return jsonResponse(202, {
      status: "accepted",
      event_name: eventName,
      action,
      item_id: itemId,
      delivery_id: deliveryId,
    });
  } catch (error) {
    logStructured("error", "github_planning_receiver.dispatch.failed", {
      service: SERVICE_NAME,
      correlation_id: correlationId,
      delivery_id: deliveryId,
      event_name: eventName,
      action,
      item_id: itemId,
      error,
    });
    return jsonResponse(500, {
      error: "dispatch_failed",
      event_name: eventName,
      action,
      item_id: itemId,
    });
  }
});
