// planning-os.js - demo-only fallback for the GitHub Project 6 read cache.
// Live Console V2 reads backend-projected planning_os_project_items and
// planning_os_execution_cards via ui_list_resource_v1; do not treat these
// rows as the production Planning OS source.

export const project_items = [
  { id: 'pi_8821', title: 'Console V2 demo (HTML)', status: 'Assigned', kind: 'feature', priority: 'p1', assignee: 'agent-blissful-engelbart', spec_issue: 3072, execution_card: 3073, pr: null, worker_id: 'agent-blissful-engelbart-589497', worktree: 'blissful-engelbart-589497' },
  { id: 'pi_8820', title: 'Mobile attestation policy v2 (mode flip)', status: 'Ready for Execution', kind: 'feature', priority: 'p1', assignee: null, spec_issue: 3071, execution_card: null, pr: null },
  { id: 'pi_8819', title: 'NDR resolution: add return-to-sender path', status: 'Triaged', kind: 'feature', priority: 'p2', assignee: null, spec_issue: 3070, execution_card: null, pr: null },
  { id: 'pi_8818', title: 'Settlement variance gate v4 (threshold per client)', status: 'Done', kind: 'feature', priority: 'p1', assignee: 'agent-eloquent-roentgen', spec_issue: 3068, execution_card: 3069, pr: 3074, worker_id: 'agent-eloquent-roentgen', worktree: 'eloquent-roentgen', merged_at: '2026-04-24T18:00:00Z' },
  { id: 'pi_8817', title: 'Route plan rebalance UI command', status: 'Done', kind: 'feature', priority: 'p1', assignee: 'agent-charming-shaw', spec_issue: 3065, execution_card: 3066, pr: 3067, worker_id: 'agent-charming-shaw', worktree: 'charming-shaw', merged_at: '2026-04-24T15:00:00Z' },
  { id: 'pi_8816', title: 'Audit remediation (pi_8810)', status: 'Blocked', kind: 'audit-remediation', priority: 'p1', assignee: null, spec_issue: 3061, execution_card: 3062, pr: null, audit_verdict: 'awaiting' },
  { id: 'pi_8815', title: 'Refresh marketing landing clients policy', status: 'Done', kind: 'feature', priority: 'p3', assignee: 'agent-vivacious-knuth', spec_issue: 3055, execution_card: 3056, pr: 3057, worker_id: 'agent-vivacious-knuth', worktree: 'vivacious-knuth', merged_at: '2026-04-23T10:00:00Z', audit_verdict: 'pass' },
  { id: 'pi_8814', title: 'Pickup wave window minutes per hub', status: 'Inbox', kind: 'feature', priority: 'p2', assignee: null, spec_issue: null, execution_card: null, pr: null },
];

export const execution_cards = [
  { id: 'ec_3073', issue_number: 3073, title: 'Console V2 demo · build static HTML demo', status: 'in_progress', priority: 'p1', spec_issue: 3072, work_key: 'console-v2-demo', worker_id: 'agent-blissful-engelbart-589497', worktree: 'blissful-engelbart-589497', step: 'E03', claimed_at: '2026-04-25T09:00:00Z', review_policy: 'optional' },
  { id: 'ec_3066', issue_number: 3066, title: 'Route plan rebalance · ship UI command', status: 'done', priority: 'p1', spec_issue: 3065, worker_id: 'agent-charming-shaw', worktree: 'charming-shaw', step: 'E08', merged_at: '2026-04-24T15:00:00Z', review_policy: 'required' },
  { id: 'ec_3069', issue_number: 3069, title: 'Settlement variance gate v4', status: 'done', priority: 'p1', spec_issue: 3068, worker_id: 'agent-eloquent-roentgen', worktree: 'eloquent-roentgen', step: 'E12', merged_at: '2026-04-24T18:00:00Z', review_policy: 'required' },
];

export const worker_claims = [
  { id: 'wc_1', worker_id: 'agent-blissful-engelbart-589497', execution_card: 3073, claimed_at: '2026-04-25T09:00:00Z', released_at: null },
  { id: 'wc_2', worker_id: 'agent-eloquent-roentgen', execution_card: 3069, claimed_at: '2026-04-24T11:00:00Z', released_at: '2026-04-24T18:00:00Z' },
  { id: 'wc_3', worker_id: 'agent-charming-shaw', execution_card: 3066, claimed_at: '2026-04-24T08:00:00Z', released_at: '2026-04-24T15:00:00Z' },
];

export const auth_email_url_policy = {
  env: 'stg',
  callback_urls: [
    'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback',
    'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
  ],
  redirect_urls: [
    'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/**',
    'https://yguwjnwkkqutolgwughjsloj.example.invalid/**',
  ],
  source_file: 'config/ops/auth-email-url-policy.stg.json',
  last_audit_at: '2026-04-23T08:00:00Z',
  audit_status: 'green',
};
