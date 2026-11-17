const path = require('path');
const { Pool } = require('pg');
const { loadEnv } = require('../../scripts/utils/load-env');
const { shouldDisableOnConnectivityError, shouldDisableOnError } = require('../../scripts/qa/qa-log');

class QaReporter {
  constructor() {
    loadEnv();
    this.enabled = Boolean(process.env.QA_RUN_ID && process.env.DATABASE_URL);
    this.runId = process.env.QA_RUN_ID;
    this.suiteKey = process.env.QA_SUITE_KEY || 'jest';
    this.pool = null;
    this.warned = false;
  }

  getPool() {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL });
      if (typeof this.pool.on === 'function') {
        this.pool.on('error', (error) => {
          this.disable(String(error?.message || error || 'background pool error'));
        });
      }
    }
    return this.pool;
  }

  disable(reason) {
    this.enabled = false;
    if (!this.warned) {
      this.warned = true;
      console.warn(`[jest-qa-reporter] Disabling QA result reporting: ${String(reason || 'unknown error')}`);
    }
  }

  async recordCaseResults(results) {
    if (!this.enabled || !results.length) return;
    const payload = JSON.stringify(results);
    const pool = this.getPool();
    try {
      await pool.query(
        'SELECT qa.qa_record_case_results($1, $2, $3::jsonb)',
        [this.runId, this.suiteKey, payload],
      );
    } catch (error) {
      if (shouldDisableOnError(error) || shouldDisableOnConnectivityError(error)) {
        this.disable(String(error?.message || error));
        return;
      }
      throw error;
    }
  }

  async onTestResult(_test, testResult) {
    if (!this.enabled) return;
    const filePath = path.relative(process.cwd(), testResult.testFilePath);
    const fileStart = testResult.perfStats?.start ? new Date(testResult.perfStats.start) : null;
    const fileEnd = testResult.perfStats?.end ? new Date(testResult.perfStats.end) : null;

    const results = testResult.testResults.map((testCase) => ({
      case_key: `${filePath}::${testCase.fullName}`,
      status: testCase.status === 'passed' ? 'passed' : (testCase.status === 'failed' ? 'failed' : 'skipped'),
      duration_ms: Number.isFinite(testCase.duration) ? Math.round(testCase.duration) : null,
      started_at: fileStart ? fileStart.toISOString() : null,
      ended_at: fileEnd ? fileEnd.toISOString() : null,
      metadata: {
        file: filePath,
        title: testCase.title,
        ancestor_titles: testCase.ancestorTitles || [],
      },
      error_summary: testCase.failureMessages?.[0]
        ? String(testCase.failureMessages[0]).slice(0, 500)
        : null,
    }));

    await this.recordCaseResults(results);
  }

  async onRunComplete() {
    if (this.pool) {
      try {
        await this.pool.end();
      } catch {
        // best-effort reporter cleanup only
      }
    }
  }
}

module.exports = QaReporter;
