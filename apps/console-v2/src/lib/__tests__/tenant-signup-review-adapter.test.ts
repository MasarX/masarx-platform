import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invokeSpy = vi.fn();
const rpcSpy = vi.fn();
const schemaSpy = vi.fn(() => ({ rpc: rpcSpy }));
const REQUEST_ID = '00000000-0000-4000-8000-000000000123';

function approvedReviewResponse() {
  return {
    data: {
      ok: true,
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
      reviewed_at: '2026-05-08T09:00:00.000Z',
      result: {
        tenant_signup_request_id: REQUEST_ID,
        status: 'approved',
        organization_id: 'org_approved',
        approved_organization_id: 'org_approved',
        user_id: 'usr_admin',
        approved_user_id: 'usr_admin',
        invite_id: 'inv_admin',
        invite_email_sent: true,
        invite_email_sent_at: '2026-05-08T09:00:01.000Z',
      },
    },
    error: null,
  };
}

function mockApprovedReviewReadbacks() {
  rpcSpy
    .mockResolvedValueOnce({
      data: {
        id: REQUEST_ID,
        status: 'approved',
        review_decision: 'approved',
        approved_organization_id: 'org_approved',
        approved_user_id: 'usr_admin',
      },
      error: null,
    })
    .mockResolvedValueOnce({
      data: {
        id: REQUEST_ID,
        status: 'approved',
        review_decision: 'approved',
        approved_organization_id: 'org_approved',
        approved_user_id: 'usr_admin',
      },
      error: null,
    })
    .mockResolvedValueOnce({
      data: { id: 'org_approved', name: 'Approved tenant' },
      error: null,
    })
    .mockResolvedValueOnce({
      data: { id: 'usr_admin', email: 'admin@example.test', status: 'active' },
      error: null,
    })
    .mockResolvedValueOnce({
      data: { id: 'usr_admin', email: 'admin@example.test', organization_id: 'org_approved' },
      error: null,
    });
}

function mockRejectedReviewReadbacks(reason = 'KYC incomplete') {
  rpcSpy
    .mockResolvedValueOnce({
      data: {
        id: REQUEST_ID,
        status: 'rejected',
        review_decision: 'rejected',
        review_reason: reason,
      },
      error: null,
    })
    .mockResolvedValueOnce({
      data: {
        id: REQUEST_ID,
        status: 'rejected',
        review_decision: 'rejected',
        review_reason: reason,
      },
      error: null,
    });
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    rpc: rpcSpy,
    schema: schemaSpy,
    from: vi.fn(),
    auth: { getSession: vi.fn() },
    functions: { invoke: invokeSpy },
  })),
}));

import { __resetSupabaseClientForTests } from '../supabase';

async function importDataSource() {
  return await import('../data-source');
}

describe('data-source tenant signup review adapter', () => {
  const originalLocation = window.location;

  function mockWindowLocation(url: string) {
    const parsed = new URL(url);
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: {
        ...originalLocation,
        href: parsed.href,
        origin: parsed.origin,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
      },
    });
  }

  beforeEach(() => {
    vi.resetModules();
    __resetSupabaseClientForTests();
    invokeSpy.mockReset();
    rpcSpy.mockReset();
    schemaSpy.mockClear();
    schemaSpy.mockReturnValue({ rpc: rpcSpy });
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-test');
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', '');
    vi.stubEnv('VITE_CONSOLE_AUTH_REDIRECT_URL', '');
    vi.stubEnv('VITE_APP_HOST', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetSupabaseClientForTests();
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  it('invokes the canonical tenant-signup-review edge function with edge payload keys', async () => {
    invokeSpy.mockResolvedValue(approvedReviewResponse());
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
      decision_reason: 'KYC verified',
      invite_redirect_to: 'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/onboarding',
      decision_metadata: { reviewed_from: 'console-v2-test' },
    });

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const [name, opts] = invokeSpy.mock.calls[0]!;
    expect(name).toBe('tenant-signup-review');
    expect((opts as { body: Record<string, unknown> }).body).toEqual({
      request_id: REQUEST_ID,
      decision: 'approved',
      reason: 'KYC verified',
      invite_redirect_to: 'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/onboarding',
      metadata: { reviewed_from: 'console-v2-test' },
    });
    expect(res.tenant_signup_request_id).toBe(REQUEST_ID);
    expect(res.organization_id).toBe('org_approved');
    expect(res.invite_email_sent).toBe(true);
  });

  it('returns canonical approval fields from live readback when the edge envelope is sparse', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        tenant_signup_request_id: REQUEST_ID,
        decision: 'approved',
        reviewed_at: '2026-05-08T09:00:00.000Z',
        result: {
          organization_id: 'org_approved',
        },
      },
      error: null,
    });
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
    });

    expect(res.status).toBe('approved');
    expect(res.review_decision).toBe('approved');
    expect(res.approved_organization_id).toBe('org_approved');
    expect(res.approved_user_id).toBe('usr_admin');
  });

  it('returns invite failure fields from approval readback when email invite falls back to auth user creation', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        tenant_signup_request_id: REQUEST_ID,
        decision: 'approved',
        result: {
          tenant_signup_request_id: REQUEST_ID,
          status: 'approved',
          organization_id: 'org_approved',
          user_id: 'usr_admin',
          approved_auth_user_id: 'auth_admin',
          invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
          last_error_code: 'invite_email_failed',
          last_error_message: 'SMTP provider refused recipient',
          last_error_at: '2026-05-16T08:15:00.000Z',
        },
      },
      error: null,
    });
    rpcSpy
      .mockResolvedValueOnce({
        data: {
          id: REQUEST_ID,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: 'org_approved',
          approved_user_id: 'usr_admin',
          approved_auth_user_id: 'auth_admin',
          invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
          last_error_code: 'invite_email_failed',
          last_error_message: 'SMTP provider refused recipient',
          last_error_at: '2026-05-16T08:15:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: REQUEST_ID,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: 'org_approved',
          approved_user_id: 'usr_admin',
          approved_auth_user_id: 'auth_admin',
          invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
          last_error_code: 'invite_email_failed',
          last_error_message: 'SMTP provider refused recipient',
          last_error_at: '2026-05-16T08:15:00.000Z',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'org_approved', name: 'Approved tenant' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'usr_admin', email: 'admin@example.test', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'usr_admin', email: 'admin@example.test', organization_id: 'org_approved' },
        error: null,
      });
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
    });

    expect(res.approved_auth_user_id).toBe('auth_admin');
    expect(res.invite_email_sent_at).toBeNull();
    expect(res.invite_redirect_to).toBe('https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    expect(res.last_error_code).toBe('invite_email_failed');
    expect(res.last_error_message).toBe('SMTP provider refused recipient');
    expect(res.last_error_at).toBe('2026-05-16T08:15:00.000Z');
  });

  it('accepts the deployed edge result shape with request and provisioning ids nested under result', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        decision: 'approved',
        result: {
          id: REQUEST_ID,
          ok: true,
          status: 'approved',
          organization_id: 'org_approved',
          user_id: 'usr_admin',
          invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
        },
      },
      error: null,
    });
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
    });

    expect(res.tenant_signup_request_id).toBe(REQUEST_ID);
    expect(res.status).toBe('approved');
    expect(res.approved_organization_id).toBe('org_approved');
    expect(res.approved_user_id).toBe('usr_admin');
  });

  it('treats rejected tenant signup review status as a successful business decision', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        decision: 'rejected',
        tenant_signup_request_id: REQUEST_ID,
        request_id: REQUEST_ID,
        id: REQUEST_ID,
        status: 'rejected',
        review_decision: 'rejected',
        result: {
          id: REQUEST_ID,
          ok: true,
          status: 'rejected',
        },
      },
      error: null,
    });
    mockRejectedReviewReadbacks('KYC incomplete');
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'rejected',
      decision_reason: 'KYC incomplete',
    });

    expect(res.tenant_signup_request_id).toBe(REQUEST_ID);
    expect(res.status).toBe('rejected');
    expect(res.review_decision).toBe('rejected');
    expect(res.review_reason).toBe('KYC incomplete');
    expect(rpcSpy).toHaveBeenCalledTimes(2);
  });

  it('refreshes from actual readback state when a stale drawer submits after another reviewer already processed the request', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        decision: 'rejected',
        tenant_signup_request_id: REQUEST_ID,
        request_id: REQUEST_ID,
        id: REQUEST_ID,
        status: 'rejected',
        review_decision: 'rejected',
        already_processed: true,
        result: {
          id: REQUEST_ID,
          ok: true,
          status: 'approved',
          already_processed: true,
          approved_organization_id: 'org_approved',
          approved_user_id: 'usr_admin',
        },
      },
      error: null,
    });
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'rejected',
      decision_reason: 'Stale reviewer reason',
    });

    expect(res.tenant_signup_request_id).toBe(REQUEST_ID);
    expect(res.already_processed).toBe(true);
    expect(res.decision).toBe('approved');
    expect(res.status).toBe('approved');
    expect(res.review_decision).toBe('approved');
    expect(res.approved_organization_id).toBe('org_approved');
    expect(res.approved_user_id).toBe('usr_admin');
    expect(rpcSpy).toHaveBeenCalledTimes(5);
  });

  it('waits for tenant signup review readback to reach a terminal decision before returning', async () => {
    invokeSpy.mockResolvedValue({
      data: {
        ok: true,
        tenant_signup_request_id: REQUEST_ID,
        decision: 'approved',
        reviewed_at: '2026-05-08T09:00:00.000Z',
        result: {
          organization_id: 'org_approved',
        },
      },
      error: null,
    });
    rpcSpy
      .mockResolvedValueOnce({
        data: {
          id: REQUEST_ID,
          status: 'pending',
          review_decision: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: REQUEST_ID,
          status: 'pending',
          review_decision: null,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: REQUEST_ID,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: 'org_approved',
          approved_user_id: 'usr_admin',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          id: REQUEST_ID,
          status: 'approved',
          review_decision: 'approved',
          approved_organization_id: 'org_approved',
          approved_user_id: 'usr_admin',
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'org_approved', name: 'Approved tenant' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'usr_admin', email: 'admin@example.test', status: 'active' },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'usr_admin', email: 'admin@example.test', organization_id: 'org_approved' },
        error: null,
      });
    const ds = await importDataSource();
    const res = await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
    });

    expect(res.status).toBe('approved');
    expect(res.review_decision).toBe('approved');
    expect(res.approved_organization_id).toBe('org_approved');
    expect(rpcSpy).toHaveBeenCalledTimes(7);
  });

  it('defaults approval invite redirects to the hosted Console auth callback when no redirect is supplied', async () => {
    mockWindowLocation('https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/platform/organizations');
    invokeSpy.mockResolvedValue(approvedReviewResponse());
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
      decision_reason: 'KYC verified',
      decision_metadata: { reviewed_from: 'console-v2-test' },
    });

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    const [, opts] = invokeSpy.mock.calls[0]!;
    expect((opts as { body: Record<string, unknown> }).body).toMatchObject({
      request_id: '00000000-0000-4000-8000-000000000123',
      decision: 'approved',
      invite_redirect_to: 'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback',
    });
  });

  it('uses the configured hosted invite redirect for localhost Console sessions', async () => {
    mockWindowLocation('http://localhost:5181/platform/organizations');
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback');
    invokeSpy.mockResolvedValue(approvedReviewResponse());
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
    });

    const [, opts] = invokeSpy.mock.calls[0]!;
    expect((opts as { body: Record<string, unknown> }).body).toMatchObject({
      invite_redirect_to: 'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback',
    });
  });

  it('fails closed when only local redirect configuration is available', async () => {
    mockWindowLocation('http://localhost:5181/platform/organizations');
    vi.stubEnv('VITE_AUTH_REDIRECT_URL', 'http://localhost:5181/auth/callback');
    vi.stubEnv('VITE_APP_HOST', 'local-backend.console-v2');
    invokeSpy.mockResolvedValue(approvedReviewResponse());
    mockApprovedReviewReadbacks();
    const ds = await importDataSource();
    await ds.tenant_signup_review_apply_v1({
      tenant_signup_request_id: REQUEST_ID,
      decision: 'approved',
    });

    const [, opts] = invokeSpy.mock.calls[0]!;
    expect((opts as { body: Record<string, unknown> }).body).not.toHaveProperty('invite_redirect_to');
  });

  it('extracts structured tenant review edge errors', async () => {
    const mockResponse = {
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'reviewer_forbidden', message: 'Reviewer capability denied.' },
      }),
    };
    invokeSpy.mockResolvedValue({
      data: null,
      error: Object.assign(new Error('FunctionsHttpError'), { context: mockResponse }),
    });
    const ds = await importDataSource();
    await expect(
      ds.tenant_signup_review_apply_v1({
        tenant_signup_request_id: REQUEST_ID,
        decision: 'rejected',
      }),
    ).rejects.toThrow(/Reviewer capability denied/);
    expect(mockResponse.json).toHaveBeenCalled();
  });
});
