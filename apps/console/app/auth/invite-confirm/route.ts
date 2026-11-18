import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createServerClient, getVerifiedAccessToken, normalizeAppBasePath, resolveRedirectTarget } from "@masarx/auth";
import { createTenantUserInviteProviderClient } from "../../../../shared/tenant-user-invite-provider";

function redirect(target: URL) {
  return new Response(null, { status: 303, headers: {
    location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer",
  } });
}

function landingTarget() {
  const base = new URL(process.env.CONSOLE_BASE_URL || "");
  if (base.protocol !== "https:" || base.username || base.password
      || /^(localhost$|127\.|\[?::1\]?$)/i.test(base.hostname)) throw new Error("invalid_configuration");
  // Same house redirect normalization, but never take a landing URL from the invitation query.
  return resolveRedirectTarget(base, null, normalizeAppBasePath(process.env.NEXT_PUBLIC_APP_BASE_PATH));
}

function configurationUnavailable() {
  return Response.json({ ok: false, code: "invite_configuration_unavailable" }, {
    status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

function invitation(query: URLSearchParams) {
  const requestId = query.get("request_id") || "";
  const token = query.get("token") || "";
  if (query.getAll("request_id").length !== 1 || query.getAll("token").length !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)
      || !/^[0-9a-f]{64}$/.test(token)) return null;
  return { requestId, token };
}

export async function GET(request: Request) {
  let target: URL;
  try { target = landingTarget(); } catch { return configurationUnavailable(); }
  const query = new URL(request.url).searchParams;
  const page = (body: string, nonce?: string) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Your MasarX invitation</title>
</head><body><main>${body}</main></body></html>`, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-robots-tag": "noindex, nofollow",
    "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
      + (nonce ? `; script-src 'nonce-${nonce}'` : ""),
  } });
  if (query.size === 1 && query.getAll("support").length === 1 && query.get("support") === "1") {
    return page(`<h1>Contact your administrator or support</h1>
<p>We could not complete this invitation automatically. Ask your administrator or MasarX support for help.</p>
<p>This link does not confirm an account, change credentials, or grant tenant access.</p>`);
  }
  const requestId = query.get("request_id") || "";
  if (query.size !== 1 || query.getAll("request_id").length !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) {
    target.searchParams.set("error", "invite_confirmation_invalid");
    return redirect(target);
  }
  const action = new URL(`${target.pathname.replace(/\/$/, "")}/auth/invite-confirm`, target.origin)
    .toString().replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const nonce = randomBytes(18).toString("base64");
  // A link preview must not spend the bearer token or replace the visitor's session.
  return page(`<h1>Accept your invitation</h1>
<p>Continue only if you expected this MasarX invitation. If you already use MasarX, sign in to that same account first, then reopen this link. Your existing password and sessions will not change.</p>
<form method="post" action="${action}"><input type="hidden" name="request_id" value="${requestId}">
<input type="hidden" id="invite-token" name="token" value="">
<label for="new-password">New password</label>
<input type="password" id="new-password" name="new_password" autocomplete="new-password" minlength="12" maxlength="72" aria-describedby="password-help">
<p id="password-help">For a new account only, choose at least 12 characters. Existing members leave this blank and use their signed-in account.</p>
<button type="submit" id="accept-invite" disabled>Accept invitation</button></form>
<p id="invite-status" role="status">Checking the invitation link. No invitation is accepted until you submit the form.</p>
<noscript><p>JavaScript is required to read this private invitation link. Enable it and reopen the link from your email, or contact your administrator or support.</p></noscript>
<p>Your manager must then check the invitation outcome before tenant access is granted.</p>
<script nonce="${nonce}">(() => {
  const status = document.getElementById("invite-status");
  const fragment = location.hash;
  try { history.replaceState(null, "", location.pathname + location.search); }
  catch { status.textContent = "The private link could not be cleared. Reopen it in a supported browser or contact support."; return; }
  const proof = fragment.length === 71 && /^#token=([0-9a-f]{64})$/.exec(fragment);
  if (!proof) {
    status.textContent = "This invitation link is incomplete or invalid. Reopen the complete link from your email, or contact your administrator or support.";
    return;
  }
  document.getElementById("invite-token").value = proof[1];
  document.getElementById("accept-invite").disabled = false;
  status.textContent = "The private link is ready. Review the form, then choose Accept invitation to continue.";
})();</script>
`, nonce);
}

export async function POST(request: Request) {
  let target: URL;
  try { target = landingTarget(); } catch { return configurationUnavailable(); }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (request.headers.get("origin") !== target.origin || (fetchSite && fetchSite !== "same-origin")) {
    return Response.json({ ok: false, code: "invite_confirmation_untrusted_origin" }, {
      status: 403, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return new Response(null, { status: 415, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }
  let form: URLSearchParams | null = null;
  const reader = request.body?.getReader();
  try {
    if (reader) {
      let bytes = 0;
      let text = "";
      const decoder = new TextDecoder("utf-8", { fatal: true });
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) { text += decoder.decode(); break; }
        bytes += chunk.value.byteLength;
        if (bytes > 2048) {
          await reader.cancel().catch(() => undefined);
          return new Response(null, { status: 413, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      form = new URLSearchParams(text);
    }
  } catch {
    await reader?.cancel().catch(() => undefined);
  } finally {
    reader?.releaseLock();
  }
  const proof = form && invitation(form);
  const password = form?.get("new_password") || "";
  if (!proof || (form?.getAll("new_password").length || 0) > 1
      || (password && (password.length < 12 || Buffer.byteLength(password, "utf8") > 72))) {
    target.searchParams.set("error", "invite_confirmation_invalid");
    return redirect(target);
  }
  try {
    const provider = createTenantUserInviteProviderClient();
    const args = { p_request_id: proof.requestId, p_token_hash: createHash("sha256").update(proof.token).digest("hex") };
    let claim = await provider.rpc("tenant_user_invite_mailbox_claim_v1", { ...args, p_new_password: password });
    let recipient: Awaited<ReturnType<typeof getVerifiedAccessToken>> | null = null;
    if (claim.error?.code === "42501" && claim.error.message === "tenant_user_invite:recipient_session_required") {
      // SQL validates the token before this refusal and does not consume it. Existing credentials are never reset.
      recipient = await getVerifiedAccessToken({ allowCookieSet: false });
      if (recipient.error || !recipient.user?.id || !recipient.accessToken) throw new Error("invite_recipient_required");
      claim = await recipient.client.rpc("tenant_user_invite_mailbox_claim_v1", { ...args, p_new_password: null });
    }
    const identity = claim.data;
    if (claim.error || !identity || typeof identity.auth_user_id !== "string" || typeof identity.email !== "string"
        || !["new_account", "active_member"].includes(identity.acceptance_mode)) throw new Error("invite_claim_failed");
    if (identity.acceptance_mode === "new_account") {
      if (!password || recipient) throw new Error("invite_password_required");
      const reset = await provider.auth.admin.updateUserById(identity.auth_user_id, { password, email_confirm: true });
      if (reset.error || reset.data.user?.id !== identity.auth_user_id) throw new Error("invite_reset_failed");
    } else if (!recipient || identity.auth_user_id !== recipient.user?.id) {
      throw new Error("invite_recipient_required");
    }
    const accepted = recipient
      ? await recipient.client.rpc("tenant_user_invite_mailbox_accept_v1", { ...args, p_new_password: null })
      : await provider.rpc("tenant_user_invite_mailbox_accept_v1", { ...args, p_new_password: password });
    if (accepted.error || accepted.data?.accepted !== true) throw new Error("invite_acceptance_unproven");
    if (identity.acceptance_mode === "new_account") {
      const client = createServerClient({ allowCookieSet: true });
      const signedIn = await client.auth.signInWithPassword({ email: identity.email, password });
      if (signedIn.error || signedIn.data.user?.id !== identity.auth_user_id
          || signedIn.data.session?.user.id !== identity.auth_user_id || !signedIn.data.session.access_token) {
        throw new Error("invite_signin_failed");
      }
    }
    target.searchParams.set("invite", "accepted_pending_manager");
  } catch {
    target.searchParams.set("error", "invite_confirmation_failed");
  }
  // Neither the bearer hash nor provider error/session contents enter redirects or application logs.
  return redirect(target);
}
