const path = require('path');
const { build } = require('esbuild');

// Supabase PostgrestFilterBuilder implements PromiseLike.then(), without
// Promise.catch(). Preserve that distinction in the RPC test double.
const postgrestResult = (result) => ({
  then(resolve, reject) {
    return Promise.resolve(result).then(resolve, reject);
  },
});

describe('tenant signup approval errors', () => {
  let approveTenantSignupRequest;

  beforeAll(async () => {
    const result = await build({
      entryPoints: [path.join(__dirname, '../../../supabase/functions/_shared/tenant_signup.ts')],
      bundle: true,
      write: false,
      platform: 'neutral',
      format: 'esm',
      target: 'es2022',
    });
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
    ({ approveTenantSignupRequest } = await import(moduleUrl));
  });

  test.each(['recorded', 'rpc_error', 'network_error'])(
    'preserves the review error when recording its diagnostic returns %s',
    async (recordingOutcome) => {
      let diagnosticExecuted = false;
      const requestQuery = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        maybeSingle: jest.fn(() => postgrestResult({
          data: {
            id: 'request-id',
            status: 'pending',
            email: 'requester@example.com',
            full_name: 'Requester',
            organization_name: 'Example Organization',
          },
          error: null,
        })),
      };
      const serviceClient = {
        from: jest.fn(() => requestQuery),
        auth: {
          admin: {
            createUser: jest.fn().mockResolvedValue({ data: { user: { id: 'auth-user-id' } }, error: null }),
          },
        },
        rpc: jest.fn((name) => {
          if (name === 'tenant_signup_policy_v1') {
            return postgrestResult({
              data: { notifications: { requester_approved_email: false } },
              error: null,
            });
          }
          if (name === 'tenant_signup_review_apply_v1') {
            return postgrestResult({ data: null, error: { message: 'Organization provisioning failed' } });
          }
          if (name === 'tenant_signup_request_record_error_v1') {
            return {
              then(resolve, reject) {
                diagnosticExecuted = true;
                const result = recordingOutcome === 'network_error'
                  ? Promise.reject(new Error('Diagnostic transport unavailable'))
                  : Promise.resolve({
                    data: null,
                    error: recordingOutcome === 'rpc_error' ? { message: 'Diagnostic write failed' } : null,
                  });
                return result.then(resolve, reject);
              },
            };
          }
          throw new Error(`Unexpected RPC ${name}`);
        }),
      };

      await expect(approveTenantSignupRequest({
        serviceClient,
        requestId: 'request-id',
        reviewerUserId: 'reviewer-id',
      })).resolves.toEqual({
        ok: false,
        error: { code: 'review_apply_failed', message: 'Organization provisioning failed' },
      });
      expect(diagnosticExecuted).toBe(true);
      expect(serviceClient.rpc).toHaveBeenCalledWith('tenant_signup_request_record_error_v1', {
        p_request_id: 'request-id',
        p_error_code: 'review_apply_failed',
        p_error_message: 'Organization provisioning failed',
        p_error_context: {
          stage: 'approve',
          invite_email_requested: false,
          invite_email_sent: false,
        },
      });
    },
  );
});
