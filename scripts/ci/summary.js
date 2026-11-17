/*
  CI Summary: Prints engine compliance and recent observability stats.
  Usage: ENV_FILE=config/env/.env.cloud npm run ci:summary
*/
const { Pool } = require('pg');
const { loadEnv } = require('../utils/load-env');

loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[ci:summary] DATABASE_URL is required');
  process.exit(2);
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const { rows } = await client.query('SELECT * FROM ci_observability_summary_v LIMIT 1');
      const row = rows[0] || {
        non_engine_outbound_count: 0,
        decision_counts: [],
        webhook_responses: [],
        top_failed_reasons: [],
        decisions_by_system_24h: [],
        webhook_responses_hist_15m: []
      };
      const summary = {
        nonEngineOutboundCount: row.non_engine_outbound_count || 0,
        decisionCounts24h: Array.isArray(row.decision_counts) ? row.decision_counts : [],
        webhookResponses24h: Array.isArray(row.webhook_responses) ? row.webhook_responses : [],
        topFailedReasons24h: Array.isArray(row.top_failed_reasons) ? row.top_failed_reasons : [],
        decisionsBySystem24h: Array.isArray(row.decisions_by_system_24h) ? row.decisions_by_system_24h : [],
        webhookResponsesHist15m: Array.isArray(row.webhook_responses_hist_15m) ? row.webhook_responses_hist_15m : [],
      };

      // Always print machine-parsable JSON for artifacts/automation
      const json = JSON.stringify(summary, null, 2);
      console.log(json);

      // Optional compact one-liner for logs when CI_SUMMARY_COMPACT=1
      if (process.env.CI_SUMMARY_COMPACT === '1') {
        const decisions = (summary.decisionCounts24h || []).slice(0, 5)
          .map(d => `${d.decision_category}:${d.cnt}`).join(', ');
        const outcomes = (summary.webhookResponses24h || []).slice(0, 5)
          .map(r => `${r.response_outcome}:${r.cnt}`).join(', ');
        console.log(`[summary] nonEngine=${summary.nonEngineOutboundCount} | decisions=[${decisions}] | responses=[${outcomes}]`);
      }

      // If running in GitHub Actions, also write a concise Markdown summary
      if (process.env.GITHUB_STEP_SUMMARY) {
        const fs = require('fs');
        const lines = [];
        lines.push('### CI Summary (Engine + Observability)');
        lines.push('');
        lines.push('| Metric | Value |');
        lines.push('|---|---:|');
        lines.push(`| Non-Engine Outbound | ${summary.nonEngineOutboundCount} |`);
        lines.push('');
        // Decisions table (top 10)
        lines.push('#### Decisions (24h)');
        lines.push('| Category | Count |');
        lines.push('|---|---:|');
        for (const d of (summary.decisionCounts24h || []).slice(0, 10)) {
          lines.push(`| ${d.decision_category ?? ''} | ${d.cnt ?? 0} |`);
        }
        lines.push('');
        // Webhook outcomes (top 10)
        lines.push('#### Webhook Responses (24h)');
        lines.push('| Outcome | Count |');
        lines.push('|---|---:|');
        for (const r of (summary.webhookResponses24h || []).slice(0, 10)) {
          lines.push(`| ${r.response_outcome ?? ''} | ${r.cnt ?? 0} |`);
        }
        lines.push('');
        // Top failure reasons (top 10)
        if ((summary.topFailedReasons24h || []).length) {
          lines.push('#### Top Failure Reasons (24h)');
          lines.push('| Reason | Count |');
          lines.push('|---|---:|');
          for (const f of (summary.topFailedReasons24h || []).slice(0, 10)) {
            lines.push(`| ${f.reason ?? ''} | ${f.cnt ?? 0} |`);
          }
          lines.push('');
        }
        // Decisions by system (top 10)
        if ((summary.decisionsBySystem24h || []).length) {
          lines.push('#### Decisions by System (24h)');
          lines.push('| System | Count |');
          lines.push('|---|---:|');
          for (const s of (summary.decisionsBySystem24h || []).slice(0, 10)) {
            lines.push(`| ${s.system ?? ''} | ${s.cnt ?? 0} |`);
          }
          lines.push('');
        }
        // 15m histogram (summarize total buckets)
        if (summary.webhookResponsesHist15m.length) {
          const totalBuckets = summary.webhookResponsesHist15m.length;
          const totalEvents = summary.webhookResponsesHist15m
            .flatMap(b => Array.isArray(b.counts) ? b.counts : [])
            .reduce((acc, c) => acc + Number(c.cnt || 0), 0);
          lines.push(`> Histogram: ${totalBuckets} buckets, total counted events: ${totalEvents}`);
          lines.push('');
        }
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
      }

      if (summary.nonEngineOutboundCount > 0) {
        console.error(`[ci:summary] FAIL: Found ${summary.nonEngineOutboundCount} non-engine outbound call(s).`);
        process.exit(1);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[ci:summary] error', err);
    process.exit(2);
  } finally {
    await pool.end();
  }
}

main();
