import { createOutbox, redactOutboxErrorText } from "@masarx/mobile-core";
import { createMemoryOutboxStore } from "./memory-outbox-fixture";

const base64PairA = Buffer.from(["abc", "def"].join(":")).toString("base64");
const base64PairB = Buffer.from(["user", "pass"].join(":")).toString("base64");
const basicFixture = Buffer.from("fixture").toString("base64");
const basicUpperLong = Buffer.from("A".repeat(9)).toString("base64");
const basicUpper = Buffer.from("A".repeat(6)).toString("base64");
const basicUpperWithDigit = basicUpper + "1";
const basicWithSuffix = ["QFJBVZQ", "968QX98"].join("");
const overlapFixture = ["QW423", "29KZ", "449"].join("");
const mixedCaseFixture = ["fixture", "Secret"].join("");
const firstFragment = ["fixture", "First"].join("");
const nextFragment = ["fixture", "Next"].join("");
const fixtureTail = ["fixture", "Tail"].join("");
const uppercaseWithDigit = ["SE", "CRET", "1"].join("");
const uppercaseFixture = ["SE", "CRET"].join("");
const shortFixture = ["ab", "c"].join("");
const fixtureWord = ["fixt", "ure"].join("");
const capFragment = ["visi", "ble"].join("");
const visibleTail = [capFragment, fixtureWord, "tail"].join("-");
const fixtureA = ["hk", "1"].join("");
const fixtureB = ["hk", "2"].join("");
const jwtFixture = ["eyJ" + fixtureWord, "payload", "signature"].join(".");
const jwtCapPrefix = jwtFixture.slice(0, 14);
const basicCapPrefix = "Basic " + base64PairB.slice(0, 3);
const paddedFragment = ["X", "=".repeat(2)].join("");
const [upperX, upperY, upperS, lowerX, lowerV] = "XYSxv";
const alphaMarker = fixtureWord + "Alpha" + 1;
const betaMarker = fixtureWord + "Beta" + 2;
const gammaMarker = fixtureWord + "Gamma" + 3;
const deltaMarker = fixtureWord + "Delta" + 4;
const atSign = String.fromCharCode(64);
const exampleHost = ["example", "invalid"].join(".");
const withheld = "[REDACTED: message withheld]";

test.each([
  ...[
    "pass\u034fword", "pass\ufe0fword", "pass\u180bword", "pa\u0301ssword", "pas\u0336sword",
    "p\u0430ssword", "t\u043eken", "s\u0435cret", "t\u03bfken", "p\\u0430ssword",
    "p&#1072;ssword", "p%D0%B0ssword", "\u1d18\u1d00\ua731\ua731\u1d21\u1d0f\u0280\u1d05",
    "pass\u0000word", "pass\u0007word", "pass\u3164word", "pass\u115fword", "pass\u2800word",
    "pass\u1160word", "pass\uffa0word", "pass&shy;word", "pass&ZeroWidthSpace;word",
    "pass&unrecognized;word", "pass", "pw", "pin", "otp", "sig", "connect.sid", "key",
  ].map(key => `${key}=${alphaMarker}`),
  `"key":"${alphaMarker}"`,
  `https://${alphaMarker}${atSign}host/x`,
  `//user:${alphaMarker}${atSign}host/x`,
  `https:\\\\user:${alphaMarker}${atSign}host`,
  `https ://user:${alphaMarker}${atSign}host`,
])("withholds sensitive error form %s", input => {
  const output = redactOutboxErrorText(input);
  expect(output).toBe(withheld);
  expect(output).not.toContain(alphaMarker);
});

test.each([
  ...[
    "DB_PASS", "smtp_pass", "smtp.pass", "user_pin", "pin_code", "otp_code", "passcode",
    "SUPABASE_SERVICE_ROLE_KEY", "client_key", "subscription_key",
    "passw\u0585rd", "t\u0585ken", "\u13a2OKEN", "\u13da\u13ac\u13df\u13a1\u13ac\u13a2",
    "passw\u2c9frd", "\ua4d1\ua4ee\ua4e2\ua4e2\ua4ea\ua4f3\ua4e3\ua4d3",
    "credent\u0131al", "s\u0131gnature", "ap\u0131_key", "to\u0138en", "passw\u0665rd",
    "\u0410\u0420\u0406_\u041a\u0415\u0423", "\u0408\u051c\u0422", "\u0422\u041e\u041a\u0415\u039d",
    "\u0420\u0410\u0405\u0405\u051c\u041e\u13a1\u13a0", "\u0440-assword", "\u0440.assword",
    "\u0440 assword", "\u062e\u0637\u0623 passw\u0585rd",
    "pass+word", "pass/word", "pass*word", "pass\u00b7word", "passw0rd", "pass&shy word",
    "p%u0061ssword", "p\\141ssword", "pass\\aword", "pass\\0word", "pass\\eword",
  ].map(key => `${key}=${alphaMarker}`),
  `service_role_key: ${alphaMarker}`,
  `Ocp-Apim-Subscription-Key: ${alphaMarker}`,
  `key: ${alphaMarker}`,
  `user:${alphaMarker}${atSign}${exampleHost}`,
  `http:\u2044\u2044u:${alphaMarker}${atSign}${exampleHost}`,
  ...[
    "code_verifier", "?code=x&code_verifier", "CODE_VERIFIER", "code-verifier",
    "client_assertion", "SAMLResponse", "creds", "hmac", "whsec", "mnemonic", "jwk", "sas", "dsn",
    "DATABASE_URL", "databaseUrl", "connection_string", "connectionString", "ConnectionString",
    "contraseña",
  ].map(key => `${key}=${alphaMarker}`),
  `codeVerifier: '${alphaMarker}'`,
  `{"code_verifier":"${alphaMarker}"}`,
  `{&quot;code_verifier&quot;:&quot;${alphaMarker}&quot;}`,
  `code_verifier%25253D${alphaMarker}`,
  `şifre: ${alphaMarker}`,
  ...[
    "upload failed café ", "Échec ", "ñ ", "à ", "Å ", "İ ", "² ",
    "ｆａｉｌ ", "ﬁle missing ", "Request failed:\u00a0", "\u2003", "upload\u200bfailed ",
    "\u00ad", "\ufeff ", "\u0301 ", "\u3164 ", "fail\u2800 ",
    "upload failed caf%C3%A9 ", "Request failed:&nbsp;", "\\ufeff ",
  ].map(prefix => prefix + alphaMarker),
])("withholds the input through redaction and outbox sync (%#)", async input => {
  const output = redactOutboxErrorText(input);
  expect(output).toBe(withheld);
  expect(output).not.toContain(alphaMarker);

  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  const { id } = await outbox.enqueue({ rpc: "record_action", args: {} });
  await outbox.sync(async () => { throw input; });
  const stored = (await store.get(id))?.last_error;
  expect(stored).toBe(withheld);
  expect(stored).not.toContain(alphaMarker);
});

const shortHexSuffix = "ab".repeat(7) + "c";
const hexSuffix = shortHexSuffix + "d";

test.each([
  ...[
    "saml_response", "SAML_RESPONSE", "saml-response", "saml.response", "SAMLart", "service.saml.request",
    "sid", "?sid", "client.sid.state", "totp_code", "mfa_code", "verification_code", "recovery_code",
    "recovery_codes", "backup_code", "backup_codes", "device_code", "user_code", "2FA_CODE", "2FACode",
    "db_url", "DATABASE_URI", "SQLALCHEMY_DATABASE_URI", "SQLAlchemy_URI", "redis_url", "mongo_uri", "conn", "conn_str",
    "connstr", "connectionstring", "dsn", "rabbitBrokerUri", "seed_phrase", "recovery_phrase", "passphrase",
    "sharedaccesssignature", "SharedAccessSignature",
    "totpcode", "TOTPCODE", "mfacode", "verificationcode", "recoverycode", "recoverycodes",
    "backupcode", "backupcodes", "devicecode", "usercode", "workflowverificationstepcode",
    "dburl", "databaseuri", "sqlalchemydatabaseuri", "redisurl", "mongouri", "seedphrase", "recoveryphrase",
    "remember", "rememberme", "remember-me", "rememberMe", `remember_web_${hexSuffix}`,
    "csrf", "xsrf", "crumb", "Jenkins-Crumb", "antiforgery", "aspxauth", ".AspNetCore.Identity.Application",
    ".aspnetcore.Custom", "authtok", "bindpw", "rootpw", "masterauth", "sess", "koa.sess", "express:sess",
    "oauth2_proxy", "proxy_oauth2_custom", "oobcode", "GITHUB_PAT", "GH_PAT", "GITLAB_PAT", "GLPAT_PAT",
    "dockerconfigjson", `wordpress_logged_in_${hexSuffix}`, `wordpress_sec_${hexSuffix}`,
    `SESS${hexSuffix}`, `SSESS${hexSuffix}`, "CASTGC", `castgc${hexSuffix}`,
    "iPlanetDirectoryPro", `iplanetdirectorypro${hexSuffix}`,
  ].map(key => [`${key}=${alphaMarker}`, withheld]),
  ...[
    "JSESSIONID", "jsessionid", "/app;jsessionid", "custom-session_id", "vendor-sess-id",
    "sessionsso", "jsessionidsso", "smsession", `ASPSESSIONID${hexSuffix}`,
  ].map(key => [
    `${key}=${alphaMarker}`, /session/i.test(key) ? `${withheld} (auth)` : withheld,
  ]),
  ...[
    `root:${alphaMarker}${atSign}tcp(db:${3306})/app`,
    `app:${alphaMarker}${atSign}unix(/tmp/mysql.sock)/db`,
    `user:${alphaMarker}${atSign}db:${5432}/app`,
    `//user:${alphaMarker}${atSign}db:${5432}/app`,
    `.-:${alphaMarker}${atSign}db`,
    `x:${alphaMarker}${atSign}${["z", "com"].join(".")}`,
  ].map(input => [input, withheld]),
])("withholds credential families in redaction and outbox sync (%#)", async (input, expectedStored) => {
  const output = redactOutboxErrorText(input);
  expect(output).toBe(withheld);
  expect(output).not.toContain(alphaMarker);

  const outbox = createOutbox(createMemoryOutboxStore());
  const { id } = await outbox.enqueue({ rpc: "record_action", args: {} });
  await outbox.sync(async () => { throw input; });
  const stored = (await outbox.get(id))?.last_error;
  expect(stored).toBe(expectedStored);
  expect(stored).not.toContain(alphaMarker);
});

const credentialSuffixKeys = [
  "codeverifier", "clientassertion", "oauthverifier", "samlassertion", "setcookie", "proxyauthorization",
  "proxyauth", "basicauth", "httpauth", "authcookie", "sessioncookie", "sentrydsn", "expopublicsentrydsn",
  "xsentryauth", "dbpwd", "postgrespwd", "xmsxsignature", "xhubsignature", "xsignature", "webhooksignature",
  ["x", "masarx", "deprecated", "auth"].join(""),
  ...["cookies", "sig", "passwd", "pass", "password", "passphrase", "secret", "token", "tokens", "credential",
    "credentials", "key", "apikey", "pin", "otp", "sessid", "sessionid", "jwt"].map(suffix => `x${suffix}`),
];
const newCredentialKeys = [
  ...credentialSuffixKeys.flatMap(key => [key, key.toUpperCase()]),
  "POSTGRES_URL_NON_POOLING", "postgres_url_non_pooling", "postgres-url-non-pooling", "postgres.url.non.pooling",
  "postgresUrlNonPooling", "PostgresURLNonPooling", "primaryMongoUriReadOnly", "postgresurlnonpooling",
  "POSTGRESURLNONPOOLING", "POSTGRESURL", "postgresurl", "database url", "database+url", "d4t4b4seurl",
  "sqlAlchemyUri", "SQLAlchemyUri", "postgreSQLUrl", "mySQLUrl",
  "service_role", "SERVICE_ROLE", "serviceRole",
];

async function expectWithheldThroughSync(input: string, error: unknown = input) {
  expect(redactOutboxErrorText(input)).toBe(withheld);
  const outbox = createOutbox(createMemoryOutboxStore());
  const { id } = await outbox.enqueue({ rpc: "record_action", args: {} });
  await outbox.sync(async () => { throw error; });
  const stored = (await outbox.get(id))?.last_error;
  expect(stored).toMatch(/^\[REDACTED: message withheld\](?: \(auth\))?$/);
  expect(stored).not.toContain(alphaMarker);
}

test.each(newCredentialKeys)("withholds the value of %s across separators, quotes and encodings", async key => {
  const json = JSON.stringify({ [key]: alphaMarker });
  const inputs = [
    ...["=", ": ", " => ", " := ", " ", "\t"].map(separator => `${key}${separator}${alphaMarker}`),
    `'${key}' = '${alphaMarker}'`, `"${key}" "${alphaMarker}"`, json, JSON.stringify(json),
    json.replace(/"/g, () => String.raw`\u0022`), json.replace(/"/g, "&quot;").replace(":", "&#58;"),
    `${key}&#61;${alphaMarker}`, `${key}&#x3d;${alphaMarker}`,
  ];
  for (let input of inputs) {
    for (let depth = 0; depth <= 8; depth += 1) {
      await expectWithheldThroughSync(input);
      input = encodeURIComponent(input);
    }
  }
});

const callbackUrl = ["masarx", "://", "callback"].join("");
const oauthResponses = [
  { code: alphaMarker, state: "waiting" },
  { state: "waiting", code: alphaMarker },
  { code: alphaMarker, code_verifier: betaMarker },
];
const oauthResponseWithQuotes = {
  code: alphaMarker, detail: 'Escaped ", "quotes"', state: "waiting",
};

test.each([
  JSON.stringify(oauthResponseWithQuotes),
  encodeURIComponent(JSON.stringify(oauthResponseWithQuotes)),
])("withholds authorization codes beside escaped JSON values (%#)", async input => {
  await expectWithheldThroughSync(input);
});

test.each([
  ...["?", "?other=value&", "#", "#other=value&"].map(query => `${callbackUrl}${query}code=${alphaMarker}`),
  ...["?", "&", "#"].map(query => `${query}code=${alphaMarker}`),
  ...oauthResponses.flatMap(response => [
    JSON.stringify(response), JSON.stringify(JSON.stringify(response)), JSON.stringify({ response }),
    JSON.stringify({ response: JSON.stringify(response) }),
    JSON.stringify(response).replace(/"/g, () => String.raw`\u0022`),
    JSON.stringify(response).replace(/"/g, "&quot;"),
  ]),
])("withholds authorization codes in callbacks and OAuth response objects (%#)", async input => {
  for (let depth = 0; depth <= 8; depth += 1) {
    await expectWithheldThroughSync(input);
    input = encodeURIComponent(input);
  }
});

test.each(oauthResponses)("withholds authorization codes when sync receives an OAuth response object (%#)",
  async response => expectWithheldThroughSync(JSON.stringify(response), response));

function countRegexSteps(input: string) {
  const exec = RegExp.prototype.exec;
  let steps = 0;
  const spy = jest.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, value: string) {
    const match = exec.call(this, value);
    steps += 1 + (this.global ? (match?.[0].length ?? 0) : 0);
    return match;
  });
  let output: string;
  try { output = redactOutboxErrorText(input); }
  finally { spy.mockRestore(); }
  expect(output).toBe(input);
  return steps;
}

test("scans 8 KiB of credential-family near matches with linear work", () => {
  function countSteps(size: number) {
    const repeats = Math.floor((size - 64) / 18);
    const input = ["x:".repeat(repeats) + atSign, "abc-".repeat(repeats) + "code",
      "def-".repeat(repeats) + "uri", "ghi-".repeat(repeats) + "phrase",
      "word".repeat(repeats) + atSign + "host"].join(" ").padEnd(size);
    return countRegexSteps(input);
  }
  const half = countSteps(4096);
  expect(half).toBeGreaterThan(0);
  expect(countSteps(8192)).toBeLessThanOrEqual(half * 3);
});

test.each([
  `"devicePin" => "${alphaMarker}"`,
  `'userPinCode' := '${alphaMarker}'`,
  `custompass ${alphaMarker}`,
  `"client_key" "${alphaMarker}"`,
  `"key: "`,
  `event\u0664=${alphaMarker}`,
  `label\u060c=${alphaMarker}`,
  `label=\u03a9 ${alphaMarker}`,
  `label=\u00b5s ${alphaMarker}`,
  `label=&copy ${alphaMarker}`,
  `label=&reg ${alphaMarker}`,
  `pass&nbspword=${alphaMarker}`,
  `pass&ZeroWidthSpace;word=${alphaMarker}`,
  `&ltkey&gt = ${alphaMarker}`,
  `&quotuserPin&quot=&amp${alphaMarker}`,
])("withholds an identifier, character, or entity form (%#)", input => {
  expect(redactOutboxErrorText(input)).toBe(withheld);
});

test("retains the PostgreSQL 23505 category when the key diagnostic is withheld", async () => {
  const message = "duplicate key value violates unique constraint";
  expect(redactOutboxErrorText(message)).toBe(withheld);
  const store = createMemoryOutboxStore();
  const outbox = createOutbox(store);
  const { id } = await outbox.enqueue({ rpc: "record_action", args: {} });
  await outbox.sync(async () => { throw { code: "23505", message }; });
  expect((await store.get(id))?.last_error).toBe(`${withheld} (conflict)`);
});

test.each([
  "\u062a\u0639\u0630\u0631 \u062d\u0641\u0638 \u0627\u0644\u0637\u0644\u0628",
  "تَعَذَّرَ حِفْظُ الطَّلَبِ",
  "shipping label failed", "Author not found", "Authors not found", "compass heading", "monkey nearby", "Request timed out",
  "keyboard=enabled", "code=409", '{"code":"PGRST301"}', "HTTP \u0664\u0660\u0669",
  "feedbackUrl=missing", "sandboxUrl=missing", "upgradeUrl=missing", "metadataBaseUrl=missing", "code=missing",
  '{"code":"PGRST301","detail":{"state":"waiting"}}',
  '{"state":"waiting","detail":{"code":"PGRST301"}}',
  '{"code":"PGRST301","detail":"state: waiting"}',
  JSON.stringify({ code: "PGRST301", detail: JSON.stringify({ state: "waiting" }) }),
  JSON.stringify({ code: "PGRST301", detail: 'Escaped ", "state": "waiting"' }),
  "nonce=missing ticket=missing seed=missing code=missing",
  "device_code_state=missing redis_region=missing",
  `pat=missing support_pat=missing SESS${shortHexSuffix}=missing`,
])("preserves ordinary diagnostic text %s", async input => {
  expect(redactOutboxErrorText(input)).toBe(input);
  const outbox = createOutbox(createMemoryOutboxStore());
  const { id } = await outbox.enqueue({ rpc: "record_action", args: {} });
  await outbox.sync(async () => { throw input; });
  expect((await outbox.get(id))?.last_error).toBe(input);
});

test.each(["Lookup key missing", "sort_key=name", "lookup-key=name"])(
  "withholds a diagnostic containing the key component (%s)", input => {
    expect(redactOutboxErrorText(input)).toBe(withheld);
  },
);

test("constructed credential fixtures preserve their original bytes", () => {
  const fixtures = [
    base64PairA, base64PairB, basicFixture, basicUpperLong, basicUpper,
    basicUpperWithDigit, basicWithSuffix, overlapFixture, mixedCaseFixture, firstFragment,
    nextFragment, fixtureTail, uppercaseWithDigit, uppercaseFixture, shortFixture, fixtureWord,
    capFragment, visibleTail, fixtureA, fixtureB, jwtFixture, jwtCapPrefix,
    basicCapPrefix, paddedFragment, alphaMarker, betaMarker, gammaMarker, deltaMarker,
  ];
  // FNV-1a over the original, ordered fixture bytes.
  let checksum = 0x811c9dc5;
  for (const byte of Buffer.from(JSON.stringify(fixtures))) {
    checksum = Math.imul(checksum ^ byte, 0x01000193);
  }
  expect(checksum >>> 0).toBe(0xcaa06ffc);
});

test.each([
  ["x-api-key=" + fixtureA, withheld],
  ["X-Api-Key: " + fixtureB, withheld],
  ["api-key: " + lowerV, withheld],
  ["refresh_token%3D" + shortFixture, withheld],
  ["access_token%3D" + shortFixture + "%26x", withheld],
  ["refresh_token%3A" + shortFixture, withheld],
  ["access_token%3A" + shortFixture + "%26x", withheld],
  ["ReFrEsH_ToKeN%3d" + shortFixture, withheld],
  ["AcCeSs_ToKeN%3a" + shortFixture, withheld],
  ["access_token%3D" + shortFixture + "%26state%3Dok", withheld],
  ["access_token%3D" + shortFixture + "&state=ok", withheld],
  ["access_token=" + shortFixture + "&state=ok", withheld],
  ["state%3Dok%26api-key%3D" + shortFixture, withheld],
])("redacts %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each(["eyJ", "token"])("caps a 1 MiB run of %s in under 200 ms", (pattern) => {
  const input = pattern.repeat(Math.ceil(1024 * 1024 / pattern.length));
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(200);
  if (pattern === "token") expect(output).toBe(withheld);
  else expect(output.endsWith("…[truncated]")).toBe(true);
});

test("redacts a credential spanning the cap and discards the raw remainder", () => {
  const prefix = " ".repeat(8192 - ("api-key=" + capFragment).length);
  expect(redactOutboxErrorText(prefix + "api-key=" + visibleTail))
    .toBe(withheld);
});

test("redacts a JWT whose second segment spans the cap", () => {
  const prefix = " ".repeat(8192 - jwtCapPrefix.length);
  expect(redactOutboxErrorText(prefix + jwtFixture))
    .toBe(prefix + "[JWT_REDACTED]…[truncated]");
});

test.each([
  ["token%253D" + fixtureWord, withheld],
  ["x-api-key%20%3D%20" + lowerV, withheld],
  ["api%2Dkey%3D" + fixtureWord, withheld],
  ["Bearer%20" + fixtureWord, withheld],
  ["bearer:" + fixtureWord, withheld],
  ["Basic " + basicFixture, "Basic [REDACTED]"],
  ["token%3D%22a b%22%26state%3Dok", withheld],
  ["-token=" + fixtureWord, withheld],
  ["x-request-id=1", "x-request-id=1"],
])("handles %s without exposing credentials", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test("processes 8 KiB of repeated x- with bounded scan steps", () => {
  const input = "x-".repeat(4096);
  const half = countRegexSteps(input.slice(0, input.length / 2));
  expect(half).toBeGreaterThan(0);
  expect(countRegexSteps(input)).toBeLessThanOrEqual(half * 3);
});

test.each([8191, 8192])("withholds a message with an emoji at index %i", index => {
  expect(redactOutboxErrorText(" ".repeat(index) + "\u{1F600}")).toBe(withheld);
});

test.each([
  ["password%3D%22a b token=%22" + uppercaseFixture, withheld],
  ["token%3D%22" + shortFixture + "%26jwt%3D%22" + uppercaseFixture + "%22%26state%3Dok", withheld],
  ["token%3D%22%22" + uppercaseFixture, withheld],
  ["token%3D%22" + lowerX + "%26state%3Dok", withheld],
  ["token%3D%22a b%22%26state%3Dok", withheld],
  ["token%3D" + shortFixture + "%20password = " + uppercaseFixture, withheld],
  ["token%3D" + shortFixture + "%20password: " + uppercaseFixture, withheld],
  ["token%3Da%20b", withheld],
  ["Basic validation failed", "Basic validation failed"],
  ["Basic auth required", withheld],
  ["Basic plan expired", "Basic plan expired"],
  ["x-request-id%3D1", "x-request-id%3D1"],
])("keeps credential boundaries in %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each([
  ["authorization%3DBasic%20" + base64PairA, withheld],
  ["token%3D" + shortFixture + "%20def=ghi", withheld],
  ["password%3Dp%20q%3Dr", withheld],
  ["Basic " + base64PairB, "Basic [REDACTED]"],
  ["Bearer%20token: " + upperX, withheld],
  ["Bearer%20client_secret%3A" + shortFixture, withheld],
  ["token%3Djwt: " + upperX, withheld],
  ["token%3Dx{\"password\": \"" + uppercaseFixture + "\"}", withheld],
])("redacts compound credential input %s", (input, expected) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test("redacts a short Basic credential fragment at the cap", () => {
  const prefix = " ".repeat(8192 - basicCapPrefix.length);
  expect(redactOutboxErrorText(prefix + "Basic " + base64PairB))
    .toBe(prefix + "Basic [REDACTED]\u2026[truncated]");
});

// Frozen references for the differential test. Keep their patterns and pass order unchanged.
function redactB22(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(\b(?=[a-z0-9_]*(?:api_?key|token|authorization|password|secret|jwt))[a-z0-9_]+["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)/gi, "$1[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
}

const MAX_ERROR_TEXT_LENGTH = 8 * 1024;
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

function redactFirstFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  const redacted = value.slice(0, MAX_ERROR_TEXT_LENGTH)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:%26|\b)(?=[a-z0-9_-]*(?:api[_-]?key|token|authorization|password|secret|jwt))[a-z0-9_-]+["']?\s*)(?:([:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|(%3[ad]\s*)((?:(?!%26)[^\s&,}])+))/gi,
      (_match, key, separator, encodedSeparator, encodedValue?: string) => {
        const jwtOnly = encodedValue?.replace(JWT_PATTERN, "[JWT_REDACTED]") === "[JWT_REDACTED]";
        return key + (separator ?? encodedSeparator) + (jwtOnly ? "[JWT_REDACTED]" : "[REDACTED]");
      },
    )
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
  if (!truncated) return redacted;

  // A JWT split by the cap may be missing the segments required by the normal matcher.
  return redacted.replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "…[truncated]";
}

function redactSecondFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  const redacted = value.slice(0, end)
    .replace(/Bearer(?:\s+|%20|:\s*)[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    // Consume other key-shaped runs whole so the lookahead never restarts at each hyphen.
    .replace(
      /((?:%26|\b|(?=-|%2d))(?=(?:[a-z0-9_-]|%2d)*(?:api(?:[_-]|%2d)?key|token|authorization|password|secret|jwt))(?:[a-z0-9_-]|%2d)+["']?)(?:(\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|((?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*)(%22(?:(?!%22)[\s\S])*(?:%22|$)|(?:(?!%26)[^\s&,}])+))|(?:[a-z0-9_-]|%2d)+/gi,
      (_match, key, separator, encodedSeparator, encodedValue?: string) => {
        if (key === undefined) return _match;
        const jwtOnly = encodedValue?.replace(JWT_PATTERN, "[JWT_REDACTED]") === "[JWT_REDACTED]";
        return key + (separator ?? encodedSeparator) + (jwtOnly ? "[JWT_REDACTED]" : "[REDACTED]");
      },
    )
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
  if (!truncated) return redacted;

  // A JWT split by the cap may be missing the segments required by the normal matcher.
  return redacted.replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "…[truncated]";
}

function redactThirdFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  const redacted = value.slice(0, end)
    .replace(/Bearer(?:\s+|%20|:\s*)[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/Basic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/gi, "Basic [REDACTED]")
    // Consume other key-shaped runs whole so the lookahead never restarts at each hyphen.
    .replace(
      /((?:%26|%20|\b|(?=-|%2d))(?=(?:[a-z0-9_-]|%2d)*(?:api(?:[_-]|%2d)?key|token|authorization|password|secret|jwt))(?:[a-z0-9_-]|%2d)+["']?)(?:(\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|((?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*)(%22(?:(?!%26|&|%22(?=%26|[&\s,}]|$))[\s\S])*(?:%22(?=%26|[&\s,}]|$)|(?=%26|&|$))|(?:(?!%26|%20(?=[a-z0-9_-]+\s*(?:%3[ad]|[:=])))[^\s&,}])+))|(?:[a-z0-9_-]|%2d)+/gi,
      (_match, key, separator, encodedSeparator, encodedValue?: string) => {
        if (key === undefined) return _match;
        const jwtOnly = encodedValue?.replace(JWT_PATTERN, "[JWT_REDACTED]") === "[JWT_REDACTED]";
        return key + (separator ?? encodedSeparator) + (jwtOnly ? "[JWT_REDACTED]" : "[REDACTED]");
      },
    )
    .replace(JWT_PATTERN, "[JWT_REDACTED]");
  if (!truncated) return redacted;

  // A JWT split by the cap may be missing the segments required by the normal matcher.
  return redacted.replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "…[truncated]";
}

test.each([
  ["Authorization: Basic " + base64PairA, [base64PairA]],
  ["proxy-authorization: Basic " + base64PairA, [base64PairA]],
  ["curl -H \"Authorization: Basic " + base64PairA + "\"", [base64PairA]],
  ["token=" + lowerX + "/Basic " + base64PairA, [base64PairA]],
  ["authorization: Bearer: " + paddedFragment, [paddedFragment]],
  ["access_token%20%3D%20Bearer: " + paddedFragment, [paddedFragment]],
  ["token%3D" + shortFixture + "%20" + overlapFixture + " = " + fixtureTail, [overlapFixture]],
  ["token=" + firstFragment + "%26api-key\t=\t" + nextFragment, [firstFragment, nextFragment]],
  ["token=" + firstFragment + "%26password\t=\t" + nextFragment, [firstFragment, nextFragment]],
])("redacts overlapping values in %s", (input, secrets) => {
  const result = redactOutboxErrorText(input);
  expect(result).toBe(withheld);
  for (const secret of secrets) expect(result).not.toContain(secret);
});

const KEY_CHAR = String.raw`(?:[a-z0-9_-]|%2d)`;
const SENSITIVE_KEY = String.raw`(?=${KEY_CHAR}*(?:api(?:[_-]|%2d)?key|token|authorization|password|secret|jwt))${KEY_CHAR}+["']?`;
const ENCODED_SEPARATOR = String.raw`(?:\s|%20)*%(?:25)?3[ad](?:\s|%20)*`;
const NEXT_SENSITIVE_KEY = String.raw`${SENSITIVE_KEY}(?:\s*[:=]|${ENCODED_SEPARATOR})`;
const KEY_BOUNDARY = String.raw`(?:%26|%20|\b|(?=-|%2d))`;
// Skip markers and consume other key-shaped runs whole to avoid restarting at each hyphen.
const MARKER_OR_KEY_RUN = String.raw`\[(?:JWT_)?REDACTED\]|${KEY_CHAR}+`;
const PLAIN_CREDENTIAL = new RegExp(
  String.raw`(${KEY_BOUNDARY}${SENSITIVE_KEY}\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|${MARKER_OR_KEY_RUN}`, "gi",
);
const ENCODED_QUOTED_VALUE = String.raw`%22(?:(?!%26|&|%22(?=%26|[&\s,}]|$))[\s\S])*(?:%22(?=%26|[&\s,}]|$)|(?=%26|&|$))`;
const ENCODED_UNQUOTED_VALUE = String.raw`(?:(?!%26|%20(?=${NEXT_SENSITIVE_KEY}))[^\s&,}])+`;
const ENCODED_CREDENTIAL = new RegExp(
  String.raw`(${KEY_BOUNDARY}${SENSITIVE_KEY}${ENCODED_SEPARATOR})(${ENCODED_QUOTED_VALUE}|${ENCODED_UNQUOTED_VALUE})|${MARKER_OR_KEY_RUN}`, "gi",
);
const EXTRA_BEARER = new RegExp(
  String.raw`Bearer(?:%20|:\s*)(?!${NEXT_SENSITIVE_KEY})(?:(?!%26|%20)[A-Za-z0-9._~+/=-])+`, "gi",
);

type RedactionText = { text: string; offsets: number[] };

function redactMatches(
  { text, offsets }: RedactionText,
  pattern: RegExp,
  marker: string,
  credential = false,
): RedactionText {
  let cursor = 0;
  let result = "";
  const remaining: number[] = [];
  for (const match of text.matchAll(pattern)) {
    if (credential && match[1] === undefined) continue;
    const prefix = credential ? match[1] : "";
    const replacement = match[2] === "[JWT_REDACTED]" ? match[2] : marker;
    result += text.slice(cursor, match.index) + prefix + replacement;
    remaining.push(...offsets.slice(cursor, match.index));
    for (let index = 0; index < prefix.length + replacement.length; index += 1) remaining.push(-1);
    cursor = match.index + match[0].length;
  }
  if (cursor === 0) return { text, offsets };
  remaining.push(...offsets.slice(cursor));
  return { text: result + text.slice(cursor), offsets: remaining };
}

// Record first-follow-up value spans before another pass can hide their opening delimiter.
const FIRST_FOLLOWUP_CREDENTIAL = /((?:%26|\b|(?=-))(?=[a-z0-9_-]*(?:api[_-]?key|token|authorization|password|secret|jwt))[a-z0-9_-]+["']?\s*)(?:([:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)|(%3[ad]\s*)(?:(?!%26)[^\s&,}])+)|[a-z0-9_-]+/gi;

function redactFourthFollowup(value: string) {
  const truncated = value.length > MAX_ERROR_TEXT_LENGTH;
  let end = MAX_ERROR_TEXT_LENGTH;
  const lastKept = value.charCodeAt(end - 1);
  if (truncated && lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;

  const text = value.slice(0, end)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
  const covered = new Uint8Array(text.length);
  for (const match of text.matchAll(FIRST_FOLLOWUP_CREDENTIAL)) {
    if (match[1] === undefined) continue;
    const prefixLength = match[1].length + (match[2] ?? match[3]).length;
    covered.fill(1, match.index + prefixLength, match.index + match[0].length);
  }

  // Apply B22's original credential and JWT replacements before extending coverage.
  let redacted = redactMatches(
    { text, offsets: Array.from({ length: text.length }, (_, index) => index) },
    /(\b(?=[a-z0-9_]*(?:api_?key|token|authorization|password|secret|jwt))[a-z0-9_]+["']?\s*[:=]\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s&,}]+)/gi, "[REDACTED]", true,
  );
  redacted = redactMatches(redacted, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[JWT_REDACTED]");
  redacted = redactMatches(redacted, ENCODED_CREDENTIAL, "[REDACTED]", true);
  redacted = redactMatches(redacted, PLAIN_CREDENTIAL, "[REDACTED]", true);
  redacted = redactMatches(redacted, EXTRA_BEARER, "Bearer [REDACTED]");

  // Keep the recognized field prefixes and mask historical value characters still present.
  let output = "";
  let inCoveredRun = false;
  for (let index = 0; index < redacted.text.length; index += 1) {
    const isCovered = covered[redacted.offsets[index]] === 1;
    if (!isCovered) output += redacted.text[index];
    else if (!inCoveredRun) output += "[REDACTED]";
    inCoveredRun = isCovered;
  }

  output = output.replace(/Basic\s+([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])/gi, (match, credential: string) =>
    /[0-9+/=]/.test(credential) || (/[A-Z]/.test(credential) && /[a-z]/.test(credential))
      ? "Basic [REDACTED]"
      : match,
  );
  if (!truncated) return output;

  return output
    .replace(/Basic\s+\S+$/i, "Basic [REDACTED]")
    // A JWT split by the cap may be missing the segments required by the normal matcher.
    .replace(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$/, "[JWT_REDACTED]") + "\u2026[truncated]";
}

test.each([
  ["token=\"\"" + uppercaseWithDigit, uppercaseWithDigit],
  ["token: \"\"" + uppercaseWithDigit, uppercaseWithDigit],
  ["token=''" + uppercaseWithDigit, uppercaseWithDigit],
  ["\"access_token\": \"\"" + uppercaseWithDigit + "\"", uppercaseWithDigit],
  ["token=\"prefix\"" + uppercaseWithDigit + "&state=ok", uppercaseWithDigit],
  ["Bearer:\t" + upperX + "+Bearer " + upperY, upperY],
  ["Bearer%20" + upperX + "/Bearer " + upperY, upperY],
  ["Authorization: BASIC " + upperX + "/Basic " + upperY, upperY],
  ["Bearer " + shortFixture + "/Bearer " + upperS, upperS],
  ["Authorization: Basic " + basicUpper, basicUpper],
  ["proxy-authorization: basic " + basicUpperLong, basicUpperLong],
  ["\"authorization\": \"Basic " + basicUpper + "\"", basicUpper],
  ["%22proxy-authorization%22%3A%22Basic%20" + basicUpper + "%22", basicUpper],
  ["%7B%22access_token%22%3A%22" + upperS + "%22%7D", "%22" + upperS + "%22"],
  ["%22token%22=" + mixedCaseFixture, mixedCaseFixture],
  ["%22token%22%3A" + mixedCaseFixture, mixedCaseFixture],
])("redacts quote and authorization variants in %s", (input, secret) => {
  const result = redactOutboxErrorText(input);
  expect(result).toBe(withheld);
  expect(result).not.toContain(secret);
});

test.each([
  ["Basic " + base64PairA + ".", [base64PairA]],
  ["Basic " + base64PairA + "-", [base64PairA]],
  ["Basic " + basicUpperWithDigit + "_x", [basicUpperWithDigit]],
  ["Basic " + basicUpperWithDigit + "~x", [basicUpperWithDigit]],
  ["Basic " + base64PairA + "=", [base64PairA]],
  ["Basic " + basicUpperWithDigit + ".Basic " + uppercaseWithDigit, [basicUpperWithDigit, uppercaseWithDigit]],
  ["password: basic " + basicWithSuffix + "_x", [basicWithSuffix]],
  ["token%3D" + shortFixture + "%7D%22password%22%22%3A%22" + uppercaseWithDigit, [shortFixture, uppercaseWithDigit]],
  ["token%3D" + shortFixture + "%7D\"password\"\":\"" + uppercaseWithDigit + "\"", [shortFixture, uppercaseWithDigit]],
  ["token%3D" + shortFixture + "%7D'password'%22%3A" + uppercaseWithDigit, [shortFixture, uppercaseWithDigit]],
])("redacts credential prefixes and doubled quotes in %s", (input, secrets) => {
  const result = redactOutboxErrorText(input);
  if (input.startsWith("Basic ")) expect(result).toContain("[REDACTED]");
  else expect(result).toBe(withheld);
  for (const secret of secrets) expect(result).not.toContain(secret);
});

test("withholds a credential containing %26 in a closed encoded quote", () => {
  expect(redactOutboxErrorText("token%3D%22" + upperX + "%26" + upperY + "%22%26state%3Dok"))
    .toBe(withheld);
});

test.each([
  "token%3D" + shortFixture + "%7D%22password%22%22%22%3A" + uppercaseWithDigit,
  "token%3D" + shortFixture + "%7D\"password\"\"\":\"" + uppercaseWithDigit + "\"",
  "token%3D" + shortFixture + "%7D'password''\":\"" + uppercaseWithDigit + "\"",
  "token%3D" + shortFixture + "%7D\"password\"\"%22%3A%22" + uppercaseWithDigit,
])("redacts the value after three closing quotes in %s", (input) => {
  const output = redactOutboxErrorText(input);
  expect(output).not.toContain(uppercaseWithDigit);
  expect(output).toBe(withheld);
});

test.each(["%2C", "%2c", "%5D", "%7D", ")", "/", '"'])(
  "closes an encoded quoted value before %s",
  (delimiter) => {
    const suffix = delimiter + "%22b%22%3A1%7D";
    expect(redactOutboxErrorText("%7B%22password%22%3A%22" + upperX + "%26" + upperY + "%22" + suffix))
      .toBe(withheld);
  },
);

test("redacts an encoded quoted value whose closing quote crosses the cap", () => {
  const input = "token%3D%22" + upperS + "%26" + upperS + "%22";
  for (const kept of [15, 16, 17]) {
    const prefix = " ".repeat(8192 - kept);
    expect(redactOutboxErrorText(prefix + input)).toBe(withheld);
  }
});

function escapeJsonPayload(text: string) {
  return JSON.stringify(text).slice(1, -1);
}

const escapedJsonForms = [
  ["escaped JSON", escapeJsonPayload],
  ["URL-encoded escaped JSON", (text: string) => encodeURIComponent(escapeJsonPayload(text))],
  ["double URL-encoded escaped JSON", (text: string) => encodeURIComponent(encodeURIComponent(escapeJsonPayload(text)))],
  ["twice-escaped JSON", (text: string) => escapeJsonPayload(escapeJsonPayload(text))],
  ["escaped JSON with encoded backslashes", (text: string) => escapeJsonPayload(text).replace(/\\/g, "%5c")],
  ["escaped JSON with encoded quotes", (text: string) => escapeJsonPayload(text).replace(/"/g, "%22")],
] as const;

test.each(escapedJsonForms)("redacts a complete credential value in %s", (_label, transform) => {
  const key = "password";
  const credential = [alphaMarker, '"', ", & ", betaMarker, "%5C%22, ", gammaMarker, "\\"].join("");
  const json = JSON.stringify({ [key]: credential, status: 503 });

  expect(redactOutboxErrorText(transform(json))).toBe(withheld);
});

test.each([true, false])("redacts mixed quoting with an escaped key set to %s", (escapeKey) => {
  const key = JSON.stringify("access_token");
  const credential = [firstFragment, nextFragment].join(" & ");
  const rawValue = JSON.stringify(credential);
  const prefix = `{${escapeKey ? escapeJsonPayload(key) : key}:`;
  const value = escapeKey ? rawValue : escapeJsonPayload(rawValue);
  const suffix = ',"status":503}';

  expect(redactOutboxErrorText(prefix + value + suffix)).toBe(withheld);
});

test("redacts credentials nested in serialized error messages", () => {
  const error = { message: JSON.stringify({ password: alphaMarker, token: betaMarker, status: 503 }) };
  expect(redactOutboxErrorText(JSON.stringify(error))).toBe(withheld);
});

const structuredJsonForms = [
  ["plain JSON", (text: string) => text],
  ...escapedJsonForms,
  ["Unicode quote escapes", (text: string) => text.replace(/"/g, () => String.raw`\u0022`)],
] as const;

test.each([
  ["lowercase", "cookie: ", "theme=dark; sid=" + alphaMarker, ""],
  ["three pairs", "Cookie: ", "a=1; b=2; sid=" + alphaMarker, ""],
  ["before CRLF", "Cookie: ", "a=1; b=2; sid=" + alphaMarker, "\r\nstatus: 503"],
  ["Set-Cookie attributes", "Set-Cookie: ", "theme=dark; Path=/, sid=" + alphaMarker + "; Path=/", ""],
  ["single-quoted argument", "curl -H 'Cookie: ", "a=1; sid=" + alphaMarker, "' --verbose"],
  ["quoted pair", "Cookie: ", 'a="one"; sid=' + alphaMarker, ""],
  ["literal encoded newline", "Cookie: ", "a=%0A; sid=" + alphaMarker, ""],
  ["before an encoded newline", "cOoKiE%3A%20", "a%3D1%3B%20sid%3D" + alphaMarker, "%0Astatus%3A503"],
  ["encoded literal percent", "Cookie%3A%20", encodeURIComponent("a=%0A; sid=" + alphaMarker), "%0Astatus%3A503"],
])("redacts the entire cookie header in %s", (_label, prefix, value, suffix) => {
  expect(redactOutboxErrorText(prefix + value + suffix)).toBe(withheld);
});

test.each(structuredJsonForms)("redacts cookie headers within %s", (_label, transform) => {
  const prefix = transform('{"error":"Cookie: ');
  const suffix = transform('","status":503}');
  expect(redactOutboxErrorText(prefix + transform("a=1; sid=" + alphaMarker) + suffix))
    .toBe(withheld);

  const request = transform('{"error":"request Cookie: ');
  expect(redactOutboxErrorText(request + transform("theme=dark; connect.sid=" + alphaMarker) + suffix))
    .toBe(withheld);

  const pairs = escapeJsonPayload('theme="dark"; connect.sid=' + alphaMarker + "; token=" + betaMarker);
  expect(redactOutboxErrorText(request + transform(pairs) + suffix))
    .toBe(withheld);

  const nextLine = transform('\\nrequest complete","status":503}');
  expect(redactOutboxErrorText(prefix + transform("a=1; sid=" + alphaMarker) + nextLine))
    .toBe(withheld);

  const field = transform('{"Set-Cookie":');
  const cookie = JSON.stringify("theme=dark; Path=/, sid=" + alphaMarker + "; Path=/");
  const fieldSuffix = transform(',"status":503}');
  expect(redactOutboxErrorText(field + transform(cookie) + fieldSuffix)).toBe(withheld);

  const bareField = transform('"Cookie": ');
  expect(redactOutboxErrorText(bareField + transform("a=1; sid=" + alphaMarker)))
    .toBe(withheld);
});

test.each([
  ["once", encodeURIComponent],
  ["twice", (text: string) => encodeURIComponent(encodeURIComponent(text))],
] as const)("redacts a JSON cookie field URL-encoded %s", (_label, transform) => {
  const prefix = transform('{"Cookie":');
  const value = transform(JSON.stringify("a=1; sid=" + alphaMarker));
  const suffix = transform(',"status":503}');
  expect(redactOutboxErrorText(prefix + value + suffix)).toBe(withheld);
});

test.each(structuredJsonForms)("redacts plural and spaced credential keys in %s", (_label, transform) => {
  for (const [key, value] of [
    ["credentials", alphaMarker], ["clientCredential", alphaMarker], ["cookies", "sid=" + alphaMarker],
    ["session id", alphaMarker], ["session_ids", alphaMarker], ["session ids", alphaMarker],
  ]) {
    const input = transform(JSON.stringify({ [key]: value, status: 503 }));
    expect(redactOutboxErrorText(input)).toBe(withheld);
  }
});

test.each(structuredJsonForms)("redacts bare values and entire collections in %s", (_label, transform) => {
  const cases = [
    ["pin_token", String(Number([123, 456, 789].join("")))],
    ["pin_token", JSON.stringify(true)],
    ["pin_token", JSON.stringify(false)],
    ["pin_token", JSON.stringify(null)],
    ["pin_token", alphaMarker],
    ["secret", JSON.stringify({ value: alphaMarker })],
    ["api_key", JSON.stringify(["x", alphaMarker])],
    ["password", JSON.stringify(["x y", alphaMarker + " z"])],
    ["password", JSON.stringify([{ details: [alphaMarker + '" ], } & \\', false, { x: 1 }] }])],
  ];
  for (const [key, value] of cases) {
    const prefix = transform(`{${JSON.stringify(key)}:`);
    const suffix = transform(',"status":503}');
    expect(redactOutboxErrorText(prefix + transform(value) + suffix)).toBe(withheld);
  }
});

test("redacts an unterminated or mismatched collection through the end", () => {
  const prefix = escapeJsonPayload('{"secret":');
  for (const suffix of ["", "]"]) {
    const value = escapeJsonPayload(`{"value":${JSON.stringify(alphaMarker)}${suffix}`);
    expect(redactOutboxErrorText(prefix + value)).toBe(withheld);
  }
});

test.each([true, false])("redacts a mixed-quoting collection with an escaped key set to %s", (escapeKey) => {
  const key = JSON.stringify("private_key");
  const value = JSON.stringify({ value: ["] } & " + alphaMarker, { content: betaMarker + '" \\' }] });
  const prefix = `{${escapeKey ? escapeJsonPayload(key) : key}:`;
  const suffix = ',"status":503}';
  expect(redactOutboxErrorText(prefix + (escapeKey ? value : escapeJsonPayload(value)) + suffix))
    .toBe(withheld);
});

test.each([
  ["token: ", shortFixture, "; retry=3 status=503"],
  ["secret=", lowerX, " keepme"],
])("withholds credentials even with diagnostics after the escaped quote in %s", (prefix, value, suffix) => {
  const input = prefix + escapeJsonPayload(JSON.stringify(value)) + suffix;
  expect(redactOutboxErrorText(input)).toBe(withheld);
});

test.each(structuredJsonForms)("redacts additional sensitive keys in %s", (_label, transform) => {
  for (const key of [
    "passwd", "PWD", "Cookie", "Set-Cookie", "credential", "SESSION_ID", "private_key", "api key",
    "x-auth-cookie", "session-id", "PRIVATE-KEY", "API KEY",
  ]) {
    const prefix = transform(`{${JSON.stringify(key)}:`);
    const suffix = transform(',"status":503}');
    expect(redactOutboxErrorText(prefix + transform(JSON.stringify(alphaMarker)) + suffix))
      .toBe(withheld);
  }
});

const cookieHeaderKeys = [
  "Cookie", "cookies", "Set-Cookie", "HTTP_COOKIE", "x-cookie", "request_cookie", "cookie-header", "upstream-set-cookie",
];
const boundaryForms = [...structuredJsonForms, ["URL-encoded JSON", encodeURIComponent] as const];

test.each(boundaryForms)(
  "redacts keys after escape boundaries in %s",
  (_label, transform) => {
    const keys = [
      "apiKey", "api_key", "api-key", "api key", "token", "authorization", "password", "secret", "jwt",
      "passwd", "pwd", "session_id", "sessionId", "session_ids", "session id", "session ids",
      "private_key", "privateKey", "credential", "credentials", ...cookieHeaderKeys,
    ];
    const escapes = ["\n", "\t", "\r", "\f", "\b", "\\n", "\\u00a0", "\\u0009", "%0A", "%0D", "%09", "%250A"];
    for (const key of keys) {
      const cookie = cookieHeaderKeys.includes(key);
      const value = cookie ? "a=1; sid=" + alphaMarker : alphaMarker;
      const separator = cookie && key !== "HTTP_COOKIE" ? ": " : "=";
      for (const escape of escapes) {
        const log = "line1" + escape + key + separator;
        const json = '{"log":"' + escapeJsonPayload(log);
        for (const [before, after] of [
          [log, "\nkeep line"], [json, String.raw`\nkeep line","status":503}`], [json, '","status":503}'],
        ] as const) {
          const prefix = transform(before);
          const suffix = transform(after);
          expect(redactOutboxErrorText(prefix + transform(value) + suffix)).toBe(withheld);
        }
      }
    }
  },
);

test.each(cookieHeaderKeys)("redacts every pair in the %s header", (key) => {
  const prefix = key + "=";
  expect(redactOutboxErrorText(prefix + "a=1; sid=" + alphaMarker)).toBe(withheld);
});

test.each(["\u00a0", "\u2003", "\u202f", "\\u00a0", "\\u2003", "\\t"])(
  "redacts a cookie header with space %j before the colon",
  (space) => {
    const prefix = `Cookie${space}: `;
    expect(redactOutboxErrorText(prefix + "a=1; sid=" + alphaMarker)).toBe(withheld);
  },
);

test.each([
  ["once", encodeURIComponent],
  ["twice", (text: string) => encodeURIComponent(encodeURIComponent(text))],
] as const)(
  "withholds the raw query parameter with a cookie header encoded %s",
  (_depth, encode) => {
    const prefix = "q=1&h=" + encode("Cookie: ");
    const suffix = "&keep=1";
    const input = prefix + encode("a=1; sid=" + alphaMarker) + suffix;
    expect(redactOutboxErrorText(input)).toBe(withheld);
  },
);

test.each(boundaryForms)(
  "withholds a message with a cookie scalar in %s",
  (_label, transform) => {
    const input = '{"cookies":4,"cookiePolicy":"accepted","status":503}';
    expect(redactOutboxErrorText(transform(input)))
      .toBe(withheld);
    for (const scalar of ["true", "false", "null", "-1.4e+21"]) {
      for (const [prefix, suffix] of [['{"cookies":', '}'], ['[{"request_cookie":', '}]'], ['"cookies":', ']']]) {
        expect(redactOutboxErrorText(transform(prefix + scalar + suffix)))
          .toBe(withheld);
      }
    }
  },
);

test("withholds cookies policy prose and similarly named diagnostic fields", () => {
  const input = 'cookies policy: accepted {"cookiePolicy":"accepted","credentialsMode":"omit"}';
  expect(redactOutboxErrorText(input)).toBe(withheld);
});

const boundaryMarker = ["Zq", "Mark"].join("");
const pathWithCredential = "C:\\tmp\\token=" + boundaryMarker;
const serializedPath = JSON.stringify({ path: pathWithCredential });

test.each([
  ["literal path", pathWithCredential],
  ["single backslash", "at \\token: " + boundaryMarker],
  ["plural after backslash", "\\tokens=" + boundaryMarker],
  ["serialized path", serializedPath],
  ["escaped serialized path", escapeJsonPayload(serializedPath)],
  ["encoded serialized path", encodeURIComponent(serializedPath)],
  ["backslash in JSON key", JSON.stringify({ "a\\token": boundaryMarker })],
  ["embedded URL", "next=" + encodeURIComponent("https://h/login?pwd=" + boundaryMarker + "&keep=1")],
  ["encoded comma", encodeURIComponent("a=1,session_id=" + boundaryMarker)],
  ["encoded pipe", encodeURIComponent("x|passwd: " + boundaryMarker)],
  ["raw URL with encoded question mark", "https://h/r%3Fpwd=" + boundaryMarker],
  ["raw assignment after encoded comma", "a=1%2Csession_id=" + boundaryMarker],
  ["named HTML quotes", "{&quot;password&quot;:&quot;" + boundaryMarker + "&quot;}"],
  ["numeric HTML quotes", "{&#34;pwd&#34;:&#x27;" + boundaryMarker + "&#x27;}"],
])("removes the synthetic credential behind a %s boundary", (_label, input) => {
  expect(redactOutboxErrorText(input)).not.toContain(boundaryMarker);
});

test.each(["%3F", "%2C", "%3B", "%7C", "%2F", "%3D", "%26", "%C2%A0"])(
  "redacts a short key after encoded punctuation %s at four depths",
  (punctuation) => {
    for (let depth = 1; depth <= 4; depth += 1) {
      const prefix = "diagnostic" + punctuation + "pwd=";
      expect(redactOutboxErrorText(prefix + boundaryMarker)).toBe(withheld);
      punctuation = encodeURIComponent(punctuation);
    }
  },
);

test.each(["t", "n", "r", "u0009"])("only treats an odd backslash run before %s as a bare-value escape", (code) => {
  const value = boundaryMarker + "\\\\" + code + boundaryMarker;
  expect(redactOutboxErrorText("password=" + value)).not.toContain(boundaryMarker);
  const suffix = "\\" + code + "status=503";
  expect(redactOutboxErrorText("password=" + boundaryMarker + suffix)).toBe(withheld);
});

const encodeEquals = (depth: number) => "%" + "25".repeat(depth - 1) + "3D";
test.each([
  ["JSON-style hash rocket", '{"password" => "' + alphaMarker + '"}'],
  ["symbol key and hash rocket", "{:password => '" + alphaMarker + "'}"],
  ["array and hash rocket", "array('password' => '" + alphaMarker + "')"],
  ["bare hash rocket", "password => " + alphaMarker],
  ["colon equals", "password := " + alphaMarker],
  ["Bearer tail after semicolon", "Authorization: Bearer " + shortFixture + ";" + alphaMarker],
  ["escaped JSON tail after slash", '{\\"password\\":\\"x\\"/' + alphaMarker + '\\"}'],
  ["escaped JSON tail after parenthesis", '{\\"password\\":\\"x\\")' + alphaMarker + '\\"}'],
  ["comma before value", "password=," + alphaMarker],
  ["brace before value", "password=}" + alphaMarker],
  ["four percent layers", "password" + encodeEquals(4) + alphaMarker],
  ["five percent layers", "password" + encodeEquals(5) + alphaMarker],
  ["backslash run", "password" + "\\".repeat(8) + "u003d" + alphaMarker],
  ["JS-escaped percent", "password\\u00253d" + alphaMarker],
  ["HTML-escaped percent", "password&#37;3d" + alphaMarker],
  ["percent-wrapped HTML percent", encodeURIComponent("password&#37;3d" + alphaMarker)],
  ["HTML-escaped backslash", "password&#92;u003d" + alphaMarker],
  ["nested ampersands", "password&amp;amp;amp;#61;" + alphaMarker],
  ["numeric entity without a semicolon", "password&#61" + alphaMarker],
  ["named equals entity", "password&equals;" + alphaMarker],
  ["named colon entity", "password&colon;" + alphaMarker],
  ["JS byte escape", "password\\x3d" + alphaMarker],
  ["JS code point escape", "password\\u{3d}" + alphaMarker],
  ["fullwidth equals", "password\uff1d" + alphaMarker],
  ["fullwidth colon", "password\uff1a" + alphaMarker],
  ["format character inside key", "pass\u200bword=" + alphaMarker],
  ["prose separator", "password is " + alphaMarker],
  ["arrow separator", "password -> " + alphaMarker],
  ["tab separator", "password\t" + alphaMarker],
  ["command line option", "--password " + alphaMarker],
  ["XML tag", "<password>" + alphaMarker + "</password>"],
  ["header without colon", "X-Api-Key " + alphaMarker],
  ["URL userinfo", `https://user:${alphaMarker}${atSign}host/x`],
  ["passphrase key", "passphrase=" + alphaMarker],
  ["PHP session key", "PHPSESSID=" + alphaMarker],
  ["password suffix", "dbpasswd=" + alphaMarker],
  ["auth key", "auth=" + alphaMarker],
  ["signature key", "signature=" + alphaMarker],
  ["access key", "access_key=" + alphaMarker],
  ["split key and mixed encoding", encodeURIComponent("&#92;u0070a.s_s-&#119;or\\u{64}&equals;" + alphaMarker)],
  ["fullwidth key", "\uff50\uff41\uff53\uff53\uff57\uff4f\uff52\uff44=" + alphaMarker],
  ["literal backslash before encoded token", "\\toke&#110;=" + alphaMarker],
  ["escaped tab inside key", "pass\\tword=" + alphaMarker],
  ["encoded slash inside URL password", encodeURIComponent(`https://user:${alphaMarker}%2Ftail${atSign}host/x`)],
  ["credential prose", "password reset failed " + alphaMarker],
  ["literal marker after key", "password=[REDACTED] " + alphaMarker],
])("withholds a residual credential term (%s)", (_label, input) => {
  const output = redactOutboxErrorText(input);
  expect(output).toBe(withheld);
  expect(output).not.toContain(alphaMarker);
});

test("withholds an 8 KiB input after eight changing decode passes", () => {
  const nested = "%" + "25".repeat(7) + "61";
  const copies = Math.floor(8192 / nested.length);
  const input = nested.repeat(copies).padEnd(8192);
  const decode = jest.spyOn(globalThis, "decodeURIComponent");
  try {
    expect(redactOutboxErrorText(input)).toBe(withheld);
    expect(decode).toHaveBeenCalledTimes(8 * copies);
  } finally {
    decode.mockRestore();
  }
});

test("rejects a deep percent run without entering the span scans", () => {
  const input = "%" + "25".repeat(4000) + "41";
  const matchAll = jest.spyOn(String.prototype, "matchAll");
  let steps: number;
  let output: string;
  try {
    output = redactOutboxErrorText(input);
    steps = matchAll.mock.calls.length;
  } finally {
    matchAll.mockRestore();
  }
  expect(steps).toBe(0);
  expect(output).toBe(withheld);
});

test("withholds 50 encoded assignments that survive span redaction", () => {
  const keys = ["password", "pwd", "session ids", "set-cookie", "HTTP_COOKIE"];
  const transforms = [
    (text: string) => text,
    (text: string) => escapeJsonPayload(escapeJsonPayload(text)),
    (text: string) => "%FF%broken " + encodeURIComponent(text),
    (text: string) => encodeURIComponent(encodeURIComponent(encodeURIComponent(escapeJsonPayload(escapeJsonPayload(text))))),
    (text: string) => encodeURIComponent(text.replace(/&/g, "&amp;")),
  ];
  for (const key of keys) {
    for (const transform of transforms) {
      for (const separator of ["&#58;", "&#x3d;"]) {
        const hiddenKey = Array.from(key, (character) => `&#${character.charCodeAt(0)};`).join("");
        const input = transform(`{\\u0022${hiddenKey}\\u0022${separator}&#x27;${boundaryMarker}&#x27;}`);
        const output = redactOutboxErrorText(input);
        expect(output).not.toContain(boundaryMarker);
        expect(output).toBe("[REDACTED: message withheld]");
      }
    }
  }
});

test("withholds a path assignment whose key and separator require percent decoding", () => {
  const input = String.raw`C:\tmp\%2574oken%253D` + boundaryMarker;
  expect(redactOutboxErrorText(input)).toBe("[REDACTED: message withheld]");
});

test.each([
  ["cookies policy", withheld],
  ["status=503 retry=3 path=C:\\tmp\\logs"],
  ["next=https%3A%2F%2Fexample.invalid%2F%3Fstatus%3D503"],
  ["{&quot;cookiePolicy&quot;:&quot;accepted&quot;}", withheld],
  ["password=", withheld],
])("keeps a diagnostic only if it has no credential term (%#)", (input, expected = input) => {
  expect(redactOutboxErrorText(input)).toBe(expected);
});

test.each([
  "the cookie was rejected", "credentialsProvider", "credential provider chain",
  JSON.stringify({ credentialsProvider: "runtime" }),
])(
  "withholds diagnostic prose %s containing a credential term", (input) => {
    expect(redactOutboxErrorText(input)).toBe(withheld);
  },
);

test("processes 8 KiB of nested escaped credential fields in under 50 ms", () => {
  const prefix = escapeJsonPayload('{"password":');
  const nested = escapeJsonPayload('{"api_key":[');
  const tail = escapeJsonPayload(JSON.stringify(alphaMarker));
  const depth = Math.floor((8192 - prefix.length - tail.length) / nested.length);
  const input = (prefix + nested.repeat(depth) + tail).padEnd(8192, " ");

  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(withheld);
});

test("processes 8 KiB of repeated cookie-like key segments in under 50 ms", () => {
  const input = "cookie-".repeat(1170) + "ok";
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(withheld);
});

test("processes an 8 KiB multi-pair cookie header in under 50 ms", () => {
  const prefix = "Cookie: ";
  const pairs = "a=1; ".repeat(Math.ceil(8192 / 5));
  const tail = "sid=" + alphaMarker;
  const input = prefix + pairs.slice(0, 8192 - prefix.length - tail.length) + tail;
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(withheld);
});

test("processes 8 KiB of repeated plural keys in under 50 ms", () => {
  const input = "credentials cookies session_ids ".repeat(256).slice(0, 8192);
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(withheld);
});

test("processes 8 KiB of escape-prefixed keys in under 50 ms", () => {
  const keys = String.raw`\nCookie: a=1; sid=` + alphaMarker + String.raw`\n\tprivate_key=` + betaMarker
    + String.raw`\r%250Asession_id=` + gammaMarker + String.raw`\nkeep line`;
  const repeats = Math.floor(8192 / keys.length);
  const input = keys.repeat(repeats).padEnd(8192);
  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(50);
  expect(output).toBe(withheld);
});

test("caps a 1 MiB unterminated escaped value with deeper quotes in under 200 ms", () => {
  const prefix = escapeJsonPayload('{"password":');
  const openQuote = escapeJsonPayload('"');
  const innerQuote = escapeJsonPayload(openQuote);
  const input = prefix + openQuote + (innerQuote + " " + alphaMarker).repeat(64) + "\\".repeat(1024 * 1024);

  const start = performance.now();
  const output = redactOutboxErrorText(input);
  expect(performance.now() - start).toBeLessThan(200);
  expect(output).toBe(withheld);
});

function checkHistoricalCoverage(seed: number, count: number, includeEscapedJson = false) {
  function pick<T>(values: readonly T[]) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return values[(seed >>> 0) % values.length];
  }

  const keys = ["token", "password", "prefixJwtSuffix", "x-api-key", "api%2Dkey", '"client_secret"', "Authorization", "proxy-authorization", "jwt"];
  const separators = ["=", ": ", " = ", "\t=\t", "%3D", "%3a", "%253D", "%20%3D%20"];
  const quotes = ['"', "'", "%22", ""];
  const joins = ["&", "%26", "%26%26", "%20", "\t", " ", '", "'];
  const chains = ["/", "+", "."];
  const fixtures = [alphaMarker, betaMarker, gammaMarker, deltaMarker];
  const frozen = [redactB22, redactFirstFollowup, redactSecondFollowup, redactThirdFollowup, redactFourthFollowup];
  let checkedSecrets = 0;
  let leaks = 0;
  let firstLeak: { input: string; marker: string; actual: string } | undefined;
  for (let index = 0; index < count; index += 1) {
    const field = (fixture: string) => {
      const quote = pick(quotes);
      const scheme = pick(["", "", "", "Basic ", "Bearer ", "Bearer:", "Bearer%20"]);
      const value = pick(["", quote + quote, quote]) + scheme + fixture + pick([quote, ""]);
      return pick(keys) + pick(separators) + value;
    };
    const first = field(fixtures[0]);
    const next = field(fixtures[1]);
    const scheme = pick(["Basic ", "Bearer ", "Bearer%20", "Bearer:"]) + fixtures[2];
    const jwt = ["eyJ" + fixtures[3], fixtureWord, "signature"].join(".");
    const standard = pick(["", "next=%2Fcb%3F", "{", "prefix-", 'curl -H "']) + first
      + pick(joins) + next + pick(joins) + pick([scheme, jwt, scheme + pick(joins) + jwt]);
    const chained = pick(["Bearer ", "Bearer:\t", "Bearer%20", "Authorization: Basic "])
      + fixtures[0] + pick(chains) + scheme;
    const singleCase = basicUpper;
    const authorization = pick(["Authorization: Basic ", "proxy-authorization:\tbasic ", "%22authorization%22%3A%22Basic%20"])
      + singleCase + pick(["", "%22"]);
    const encodedJson = "%7B%22access_token%22%3A%22" + fixtures[1] + "%22%7D";
    const basicEnded = "Basic " + fixtures[0] + pick([".", "-", "_", "~", "==="]);
    const basicChain = "Basic " + fixtures[0] + ".Basic " + fixtures[1];
    const quoteCount = pick([1, 2, 3, 4]);
    let quotedKey = pick(['%22password', '"password', "'password"]);
    for (let quote = 0; quote < quoteCount; quote += 1) quotedKey += pick(['%22', '"', "'"]);
    const quotedKeyValue = "token%3D" + shortFixture + "%7D" + quotedKey + pick([":", "%3A", "="]) + fixtures[1];
    const encodedQuote = "token%3D%22" + fixtures[0] + "%26" + fixtures[1] + "%22%26state%3Dok";
    const historical = pick([
      standard, standard, standard, chained + pick(joins) + next, authorization + " " + encodedJson,
      basicEnded, basicChain, quotedKeyValue, encodedQuote,
    ]);
    const escapedFixture = fixtureWord + "Escaped" + index;
    const transform = escapedJsonForms[index % escapedJsonForms.length][1];
    const input = includeEscapedJson
      ? transform(JSON.stringify({ password: escapedFixture })) + " & " + historical
      : historical;
    const oldResults = frozen.map((redact) => redact(input));
    const actual = redactOutboxErrorText(input);
    if (includeEscapedJson) {
      const structuredTransform = structuredJsonForms[index % structuredJsonForms.length][1];
      const endings = ['"', '\\', '", & ', ']}{[;=', "%26%5D", '" } \\'];
      const hostile = escapedFixture + endings[Math.floor(index / 24) % endings.length];
      const values = [
        hostile, { value: hostile, number: index }, [hostile, index, [true, { value: hostile }, null]],
      ];
      const pluralKey = ["credentials", "cookies", "session ids"][Math.floor(index / 4) % 3];
      const header = ["Cookie", "Set-Cookie"][index % 2] + ": ";
      const headerValue = "theme=dark; a=1; sid=" + hostile;
      const json = JSON.stringify({
        secret: values[Math.floor(index / structuredJsonForms.length) % values.length],
        pin_token: index, credential: false, session_id: null, [pluralKey]: hostile, error: header + headerValue, status: 503,
      });
      expect(redactOutboxErrorText(structuredTransform(json) + " & " + historical)).toBe(withheld);
    }
    for (const fixture of [...fixtures, singleCase, escapedFixture]) {
      if (!input.includes(fixture)) continue;
      if (fixture !== escapedFixture && oldResults.every((result) => result.includes(fixture))) continue;
      checkedSecrets += 1;
      if (!actual.includes(fixture)) continue;
      leaks += 1;
      firstLeak ??= { input, marker: fixture, actual };
    }
  }
  return { checkedSecrets, leaks, firstLeak };
}

test("retains historical secret coverage across 4,000 seeded inputs", () => {
  const { checkedSecrets, leaks, firstLeak } = checkHistoricalCoverage(0x7b3a54c1, 4000);
  expect(checkedSecrets).toBeGreaterThan(4000);
  expect({ leaks, firstLeak }).toEqual({ leaks: 0, firstLeak: undefined });
}, 10000);

test("retains historical coverage alongside escaped JSON across 1,000 seeded inputs", () => {
  const { checkedSecrets, leaks, firstLeak } = checkHistoricalCoverage(0x7b3a54c1, 1000, true);
  expect(checkedSecrets).toBeGreaterThan(2000);
  expect({ leaks, firstLeak }).toEqual({ leaks: 0, firstLeak: undefined });
}, 10000);
