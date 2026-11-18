// Plan: PLAN-202602-landing-contact-sales-intake / Step: S99
// Marketing lead intake edge E2E (guarded). Validates CORS/origin enforcement and Turnstile-required posture.

const { randomUUID } = require('crypto');
const { Pool } = require('pg');
const { loadEnv } = require('../../../scripts/utils/load-env');
const {
  buildAllowedOriginCandidates,
  probeAllowedOrigin,
} = require('../helpers/edge-origin-probe');
const { buildPublicEdgeHeaders } = require('../helpers/public-edge-auth');

loadEnv();

const edgeE2eEnabled = process.env.RUN_EDGE_E2E === 'true';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const LOCAL_EDGE = (() => {
  try {
    return ['127.0.0.1', 'localhost'].includes(new URL(SUPABASE_URL).hostname);
  } catch {
    return false;
  }
})();

const runIfEdge = edgeE2eEnabled && SUPABASE_URL ? describe : describe.skip;

function buildFnUrl(fnName) {
  const base = SUPABASE_URL.replace(/\/+$/g, '');
  return `${base}/functions/v1/${fnName}`;
}

function resolveAllowedOriginCandidate() {
  return buildAllowedOriginCandidates({
    allowlistValues: [
      process.env.PUBLIC_EDGE_LOCAL_CORS_ALLOW_ORIGINS,
      process.env.MARKETING_CORS_ALLOW_ORIGINS,
      process.env.LANDING_CORS_ALLOW_ORIGINS,
    ],
    envValues: [
      process.env.SUPABASE_URL,
      process.env.LANDING_SITE_URL,
      process.env.LANDING_APP_URL,
      process.env.LANDING_DOCS_URL,
      process.env.CONSOLE_BASE_URL,
      process.env.PORTAL_BASE_URL,
      'https://localhost:3000',
      'https://localhost:5173',
    ],
    canonicalHosts: [
      'https://hguxuguuvhxjwymmxhlmkwwp.example.invalid',
      'https://grtgggvjriwqrxhykymmloov.example.invalid',
      'https://nzxmhryhtqlzoshjkyozkpup.example.invalid',
      'https://yslvnlqxjhkzismlnkrrvyvs.example.invalid',
      'https://unjijvxjrwurjgsnokovrvom.example.invalid',
      'https://hrorzpuminkttynstpljzjuu.example.invalid',
      'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid',
      'https://yguwjnwkkqutolgwughjsloj.example.invalid',
      'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid',
      'https://vvmruwrtzllojrtomtlgvwju.example.invalid',
    ],
  });
}

async function postLead({ origin, headers = {}, body = {}, url = buildFnUrl('marketing-lead-intake') } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(origin ? { origin } : {}),
      ...buildPublicEdgeHeaders(headers),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

runIfEdge('marketing-lead-intake edge (E2E)', () => {
  let pool;
  const cleanupEmails = new Set();
  const testIfLocalDatabase = LOCAL_EDGE && DATABASE_URL ? test : test.skip;
  const localOrigin = LOCAL_EDGE ? `http://${new URL(SUPABASE_URL).hostname}:3333` : '';

  beforeAll(() => {
    if (DATABASE_URL) pool = new Pool({ connectionString: DATABASE_URL });
  });

  async function cleanupArtifacts(email) {
    if (!pool) {
      cleanupEmails.delete(email);
      return;
    }
    const { rows } = await pool.query(
      `SELECT r.id,
              COALESCE(
                array_agg(DISTINCT d.workflow_run_id)
                  FILTER (WHERE d.workflow_run_id IS NOT NULL),
                '{}'::uuid[]
              ) AS workflow_ids
         FROM public.marketing_demo_requests r
         LEFT JOIN public.workflow_binding_dispatches d
           ON d.resource_type = 'marketing_lead_request'
          AND d.resource_id = r.id
        WHERE lower(r.email) = lower($1)
        GROUP BY r.id`,
      [email],
    );
    const leadIds = rows.map((row) => row.id);
    const workflowIds = Array.from(new Set(rows.flatMap((row) => row.workflow_ids || [])));
    if (leadIds.length) {
      await pool.query('BEGIN');
      try {
        await pool.query(
          `DELETE FROM public.tasks
            WHERE resource_type = 'marketing_lead_request'
              AND resource_id = ANY($1::uuid[])`,
          [leadIds],
        );
        await pool.query(
          `DELETE FROM public.workflow_binding_dispatches
            WHERE resource_type = 'marketing_lead_request'
              AND resource_id = ANY($1::uuid[])`,
          [leadIds],
        );
        await pool.query(
          'DELETE FROM public.marketing_demo_requests WHERE id = ANY($1::uuid[])',
          [leadIds],
        );
        if (workflowIds.length) {
          await pool.query(
            'DELETE FROM public.workflow_runs WHERE id = ANY($1::uuid[])',
            [workflowIds],
          );
        }
        await pool.query('COMMIT');
      } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
      }
    }
    cleanupEmails.delete(email);
  }

  async function withCleanup(email, callback) {
    cleanupEmails.add(email);
    try {
      return await callback();
    } finally {
      await cleanupArtifacts(email);
    }
  }

  afterAll(async () => {
    if (!pool) return;
    try {
      for (const email of Array.from(cleanupEmails)) {
        await cleanupArtifacts(email);
      }
    } finally {
      await pool.end();
    }
  });

  async function artifactCounts(email) {
    if (!pool) return null;
    const { rows } = await pool.query(
      `SELECT r.id,
              (SELECT count(DISTINCT wr.id)::int
                 FROM public.workflow_binding_dispatches d
                 JOIN public.workflow_runs wr ON wr.id = d.workflow_run_id
                WHERE d.resource_type = 'marketing_lead_request'
                  AND d.resource_id = r.id) AS workflow_count,
              (SELECT count(*)::int
                 FROM public.tasks t
                WHERE t.resource_type = 'marketing_lead_request'
                  AND t.resource_id = r.id) AS task_count
         FROM public.marketing_demo_requests r
        WHERE lower(r.email) = lower($1)`,
      [email],
    );
    return {
      leadCount: rows.length,
      workflowCount: rows.reduce((sum, row) => sum + Number(row.workflow_count || 0), 0),
      taskCount: rows.reduce((sum, row) => sum + Number(row.task_count || 0), 0),
    };
  }

  const assertZeroArtifacts = async (email) => {
    const counts = await artifactCounts(email);
    if (counts) expect(counts).toEqual({ leadCount: 0, workflowCount: 0, taskCount: 0 });
  };

  test('POST without Origin returns 403 origin_required with zero partial artifacts', async () => {
    const email = `edge-reject-no-origin-${randomUUID()}@example.test`;
    await withCleanup(email, async () => {
      const { status, body } = await postLead({ body: { email, company: 'MasarX' } });

      expect(status).toBe(403);
      expect(body).toMatchObject({ ok: false, error: { code: 'origin_required' } });
      await assertZeroArtifacts(email);
    });
  });

  test('POST with disallowed Origin returns 403 origin_not_allowed with zero partial artifacts', async () => {
    const email = `edge-reject-origin-${randomUUID()}@example.test`;
    await withCleanup(email, async () => {
      const { status, body } = await postLead({
        origin: 'https://evil.example',
        body: { email, company: 'MasarX' },
      });

      expect(status).toBe(403);
      expect(body).toMatchObject({ ok: false, error: { code: 'origin_not_allowed' } });
      await assertZeroArtifacts(email);
    });
  });

  test('POST with allowed Origin but no Turnstile returns exact turnstile_required with zero partial artifacts', async () => {
    const { origin: allowedOrigin, attempts } = await probeAllowedOrigin(
      resolveAllowedOriginCandidate(),
      async (origin) =>
        postLead({
          origin,
          headers: {
            'cf-connecting-ip': '203.0.113.11',
            'x-real-ip': '203.0.113.11',
            'x-forwarded-for': '203.0.113.11',
          },
          body: { email: '', company: '' },
        }),
    );
    if (!allowedOrigin) {
      throw new Error('No allowed configured origin was positively exercised: ' + JSON.stringify(attempts));
    }

    const email = `edge-reject-turnstile-${randomUUID()}@example.test`;
    await withCleanup(email, async () => {
      const { status, body } = await postLead({
        origin: allowedOrigin,
        headers: {
          'cf-connecting-ip': '203.0.113.10',
          'x-real-ip': '203.0.113.10',
          'x-forwarded-for': '203.0.113.10',
        },
        body: {
          email,
          company: 'MasarX',
          notes: 'edge e2e lead intake validation',
        },
      });

      expect(status).toBe(400);
      expect(body).toMatchObject({ ok: false, error: { code: 'turnstile_required' } });
      await assertZeroArtifacts(email);
    });
  });

  testIfLocalDatabase('official local Turnstile tuple creates one lead, workflow, and task, then dedupes', async () => {
    const email = `edge-valid-${randomUUID()}@example.test`;
    await withCleanup(email, async () => {
      const request = {
        origin: localOrigin,
        headers: { 'x-forwarded-for': '127.0.0.21' },
        body: {
          email,
          company: 'MasarX E2E',
          notes: 'service-only marketing mutation proof',
          turnstile_token: 'EXAMPLE_PASSWORD',
        },
      };
      const first = await postLead(request);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ ok: true });
      await expect(artifactCounts(email)).resolves.toEqual({
        leadCount: 1,
        workflowCount: 1,
        taskCount: 1,
      });

      const second = await postLead(request);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ ok: true, deduped: true });
      await expect(artifactCounts(email)).resolves.toEqual({
        leadCount: 1,
        workflowCount: 1,
        taskCount: 1,
      });
    });
  });

  testIfLocalDatabase('official local Turnstile tuple rejects a mismatched loopback hostname with zero partial artifacts', async () => {
    const email = `edge-wrong-host-${randomUUID()}@example.test`;
    await withCleanup(email, async () => {
      const alternate = new URL(buildFnUrl('marketing-lead-intake'));
      alternate.hostname = alternate.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      const result = await postLead({
        url: alternate.toString(),
        origin: localOrigin,
        headers: { 'x-forwarded-for': '127.0.0.23' },
        body: {
          email,
          company: 'MasarX E2E',
          turnstile_token: 'EXAMPLE_PASSWORD',
        },
      });

      expect(result.status).toBe(400);
      expect(result.body).toMatchObject({ ok: false, error: { code: 'turnstile_invalid' } });
      await assertZeroArtifacts(email);
    });
  });
});
