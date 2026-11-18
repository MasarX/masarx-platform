import {
  MOBILE_V2_DRIVER_SIGNUP_LOCAL_TURNSTILE_TOKEN,
  buildMobileV2DriverApplicationFollowUp,
  buildMobileV2DriverSignupPayload,
  formatMobileV2DriverApplicationStatusCopy,
  parseMobileV2DriverSignupRoleOptions,
  readMobileV2DriverApplicationStatus,
  resolveMobileV2DriverSignupEndpoints,
  resolveMobileV2DriverSignupOrigin,
  shouldUseLocalDriverSignupTurnstileToken,
  submitMobileV2DriverSignup,
} from "../../../apps/fieldops/src/mobile-v2-driver-signup";

describe("Mobile V2 driver signup helpers", () => {
  const draft = {
    email: " Driver.Applicant@Example.COM ",
    fullName: "Driver Applicant",
    phone: "+12025550123",
    organizationName: "Riyadh Driver Network",
    employeeOrContractorId: "drv-1001",
    selectedRoleIds: ["last_mile_driver", "last_mile_driver", "cod_driver"],
  };

  test("resolves driver signup and status functions from the configured Supabase project", () => {
    expect(
      resolveMobileV2DriverSignupEndpoints({
        supabaseUrl: "http://127.0.0.1:57429",
      }),
    ).toEqual({
      signupEndpoint: "http://127.0.0.1:57429/functions/v1/driver-signup-intake",
      statusEndpoint: "http://127.0.0.1:57429/functions/v1/driver-application-status",
    });

    expect(
      resolveMobileV2DriverSignupEndpoints({
        supabaseUrl: "https://project.supabase.co",
        signupEndpoint: "https://edge.example/signup/",
        statusEndpoint: "https://edge.example/status/",
      }),
    ).toEqual({
      signupEndpoint: "https://edge.example/signup",
      statusEndpoint: "https://edge.example/status",
    });
  });

  test("resolves the Origin header from app config before falling back to endpoint origin", () => {
    expect(
      resolveMobileV2DriverSignupOrigin({
        configuredOrigin: "https://nzxmhryhtqlzoshjkyozkpup.example.invalid/landing/driver-signup?source=fieldops",
        signupEndpoint: "https://project.supabase.co/functions/v1/driver-signup-intake",
        supabaseUrl: "https://project.supabase.co",
      }),
    ).toBe("https://nzxmhryhtqlzoshjkyozkpup.example.invalid");

    expect(
      resolveMobileV2DriverSignupOrigin({
        signupEndpoint: "http://127.0.0.1:57429/functions/v1/driver-signup-intake",
        supabaseUrl: "http://127.0.0.1:57429",
      }),
    ).toBe("http://127.0.0.1:57429");
  });

  test("parses signup roles from runtime config with a driver fallback", () => {
    expect(
      parseMobileV2DriverSignupRoleOptions(
        JSON.stringify({
          roles: [
            {
              id: "last_mile_driver",
              icon: "truck",
              label: "Last-mile driver",
              sub: "Route delivery",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        id: "last_mile_driver",
        icon: "truck",
        label: "Last-mile driver",
        sub: "Route delivery",
      },
    ]);

    expect(parseMobileV2DriverSignupRoleOptions("not json")[0]).toMatchObject({
      id: "last_mile_driver",
      label: "Last-mile driver",
    });
  });

  test("builds the canonical driver-signup-intake payload without duplicate role values", () => {
    expect(
      buildMobileV2DriverSignupPayload(draft, {
        locale: "en",
        turnstileToken: "token-123",
      }),
    ).toMatchObject({
      email: "driver.applicant@example.com",
      full_name: "Driver Applicant",
      organization_name: "Riyadh Driver Network",
      phone: "+12025550123",
      locale: "en",
      capabilities_requested: ["last_mile_driver", "cod_driver"],
      verification_documents: [],
      turnstile_token: "token-123",
      marketing: {
        source: "fieldops_mobile_v2",
        app_surface: "fieldops_mobile_v2_native_signup",
        employee_or_contractor_id: "drv-1001",
        selected_role_ids: ["last_mile_driver", "cod_driver"],
      },
    });
  });

  test("uses the local Turnstile test token only for local driver signup endpoints", () => {
    expect(
      shouldUseLocalDriverSignupTurnstileToken({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-signup-intake",
        origin: "http://127.0.0.1:3333",
      }),
    ).toBe(true);

    expect(
      shouldUseLocalDriverSignupTurnstileToken({
        endpoint: "https://project.supabase.co/functions/v1/driver-signup-intake",
        origin: "https://nzxmhryhtqlzoshjkyozkpup.example.invalid",
      }),
    ).toBe(false);
  });

  test("submits the application and requires backend status-token readback", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          id: "request-1",
          status: "pending",
          deduped: false,
          application_status_token: "status-token-1",
        }),
    });

    await expect(
      submitMobileV2DriverSignup({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-signup-intake",
        anonKey: "anon-key",
        origin: "http://127.0.0.1:3333",
        locale: "en",
        draft,
        fetchImpl,
      }),
    ).resolves.toEqual({
      id: "request-1",
      status: "pending",
      deduped: false,
      dedupeReason: "",
      applicationStatusToken: "status-token-1",
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.apikey).toBe("anon-key");
    expect(init.headers.authorization).toBe("Bearer anon-key");
    expect(init.headers.origin).toBe("http://127.0.0.1:3333");
    expect(JSON.parse(init.body).turnstile_token).toBe(
      MOBILE_V2_DRIVER_SIGNUP_LOCAL_TURNSTILE_TOKEN,
    );
  });

  test("fails driver signup visibly instead of spinning forever when the endpoint hangs", async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally never settles to simulate a stuck native request.
        }),
    );

    const pending = submitMobileV2DriverSignup({
      endpoint: "http://127.0.0.1:57429/functions/v1/driver-signup-intake",
      anonKey: "anon-key",
      origin: "http://127.0.0.1:3333",
      locale: "en",
      draft,
      fetchImpl,
    });

    const assertion = expect(pending).rejects.toThrow("driver_signup_request_timeout");

    await jest.advanceTimersByTimeAsync(15000);
    await assertion;
    jest.useRealTimers();
  });

  test("surfaces duplicate signup dedupe reason from the edge response", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          id: "request-duplicate",
          status: "pending",
          deduped: true,
          dedupe_reason: "email",
          application_status_token: "status-token-duplicate",
        }),
    });

    await expect(
      submitMobileV2DriverSignup({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-signup-intake",
        anonKey: "anon-key",
        origin: "http://127.0.0.1:3333",
        locale: "en",
        draft,
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      id: "request-duplicate",
      deduped: true,
      dedupeReason: "email",
      applicationStatusToken: "status-token-duplicate",
    });
  });

  test("reads the application status with the browser-safe status token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          status: "approved",
          application_state: "approved",
          participant_type_key: "freelancer_driver",
          review_decision: "approved",
          reviewed_at: "2026-05-30T08:00:00.000Z",
          invite_email_sent_at: "2026-05-30T08:01:00.000Z",
          invite_redirect_to: "https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback",
          review_reason: "approved_for_live_probe",
          requested_documents: [],
          profile_handoff: {
            ready: true,
            organization_id: "org-approved",
            user_id: "user-approved",
            participant_profile_id: "profile-approved",
            driver_profile_id: "driver-profile-approved",
            fleet_driver_status: "active",
            fleet_handoff_ready: true,
            fleet_document_count: 1,
            fleet_compliance_event_count: 1,
            invite_redirect_to: "https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback",
            invite_email_sent_at: "2026-05-30T08:01:00.000Z",
          },
        }),
    });

    await expect(
      readMobileV2DriverApplicationStatus({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-application-status",
        anonKey: "anon-key",
        origin: "http://127.0.0.1:3333",
        token: "status-token-1",
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: "approved",
      applicationState: "approved",
      participantTypeKey: "freelancer_driver",
      reviewDecision: "approved",
      reviewedAt: "2026-05-30T08:00:00.000Z",
      inviteEmailSentAt: "2026-05-30T08:01:00.000Z",
      inviteRedirectTo: "https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback",
      reviewReason: "approved_for_live_probe",
      requestedDocuments: [],
      profileHandoff: {
        ready: true,
        organizationId: "org-approved",
        userId: "user-approved",
        participantProfileId: "profile-approved",
        driverProfileId: "driver-profile-approved",
        fleetDriverStatus: "active",
        fleetHandoffReady: true,
        fleetDocumentCount: 1,
        fleetComplianceEventCount: 1,
        inviteRedirectTo: "https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback",
        inviteEmailSentAt: "2026-05-30T08:01:00.000Z",
      },
    });

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      token: "status-token-1",
    });
  });

  test("fails application status readback visibly instead of spinning forever", async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn(
      () =>
        new Promise<never>(() => {
          // Intentionally never settles to simulate a stuck native request.
        }),
    );

    const pending = readMobileV2DriverApplicationStatus({
      endpoint: "http://127.0.0.1:57429/functions/v1/driver-application-status",
      anonKey: "anon-key",
      origin: "http://127.0.0.1:3333",
      token: "status-token-1",
      fetchImpl,
    });

    const assertion = expect(pending).rejects.toThrow("driver_application_status_request_timeout");

    await jest.advanceTimersByTimeAsync(15000);
    await assertion;
    jest.useRealTimers();
  });

  test("preserves additional-documents status readback for denied onboarding progress", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          status: "pending",
          application_state: "additional_documents_requested",
          participant_type_key: "freelancer_driver",
          review_decision: "",
          reviewed_at: "2026-05-30T08:10:00.000Z",
          invite_email_sent_at: "",
          invite_redirect_to: "",
          review_reason: "license_expired",
          requested_documents: ["driver_license", "vehicle_registration"],
          profile_handoff: {
            ready: false,
          },
        }),
    });

    await expect(
      readMobileV2DriverApplicationStatus({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-application-status",
        anonKey: "anon-key",
        origin: "http://127.0.0.1:3333",
        token: "status-token-docs",
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: "pending",
      applicationState: "additional_documents_requested",
      participantTypeKey: "freelancer_driver",
      reviewDecision: "",
      reviewedAt: "2026-05-30T08:10:00.000Z",
      inviteEmailSentAt: "",
      inviteRedirectTo: "",
      reviewReason: "license_expired",
      requestedDocuments: ["driver_license", "vehicle_registration"],
      profileHandoff: {
        ready: false,
        organizationId: "",
        userId: "",
        participantProfileId: "",
        driverProfileId: "",
        fleetDriverStatus: "",
        fleetHandoffReady: false,
        fleetDocumentCount: 0,
        fleetComplianceEventCount: 0,
        inviteRedirectTo: "",
        inviteEmailSentAt: "",
      },
    });
  });

  test("reads rejected application status with reviewer reason and no profile handoff", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          status: "rejected",
          application_state: "duplicate_identity",
          participant_type_key: "freelancer_driver",
          review_decision: "rejected",
          reviewed_at: "2026-05-31T15:10:00.000Z",
          invite_email_sent_at: "",
          invite_redirect_to: "",
          review_reason: "duplicate_identity",
          requested_documents: [],
          profile_handoff: {
            ready: false,
          },
        }),
    });

    await expect(
      readMobileV2DriverApplicationStatus({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-application-status",
        anonKey: "anon-key",
        origin: "http://127.0.0.1:3333",
        token: "status-token-rejected",
        fetchImpl,
      }),
    ).resolves.toEqual({
      status: "rejected",
      applicationState: "duplicate_identity",
      participantTypeKey: "freelancer_driver",
      reviewDecision: "rejected",
      reviewedAt: "2026-05-31T15:10:00.000Z",
      inviteEmailSentAt: "",
      inviteRedirectTo: "",
      reviewReason: "duplicate_identity",
      requestedDocuments: [],
      profileHandoff: {
        ready: false,
        organizationId: "",
        userId: "",
        participantProfileId: "",
        driverProfileId: "",
        fleetDriverStatus: "",
        fleetHandoffReady: false,
        fleetDocumentCount: 0,
        fleetComplianceEventCount: 0,
        inviteRedirectTo: "",
        inviteEmailSentAt: "",
      },
    });
  });

  test("reads compliance-denied rejection without enabling profile handoff", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: true,
          status: "rejected",
          application_state: "compliance_denied",
          participant_type_key: "freelancer_driver",
          review_decision: "rejected",
          reviewed_at: "2026-05-31T15:20:00.000Z",
          invite_email_sent_at: "",
          invite_redirect_to: "",
          review_reason: "compliance_document_mismatch",
          requested_documents: ["driver_license"],
          profile_handoff: {
            ready: false,
            fleet_handoff_ready: false,
            fleet_document_count: 1,
            fleet_compliance_event_count: 1,
          },
        }),
    });

    await expect(
      readMobileV2DriverApplicationStatus({
        endpoint: "http://127.0.0.1:57429/functions/v1/driver-application-status",
        anonKey: "anon-key",
        origin: "http://127.0.0.1:3333",
        token: "status-token-compliance-denied",
        fetchImpl,
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      applicationState: "compliance_denied",
      reviewDecision: "rejected",
      reviewReason: "compliance_document_mismatch",
      requestedDocuments: ["driver_license"],
      profileHandoff: {
        ready: false,
        fleetHandoffReady: false,
        fleetDocumentCount: 1,
        fleetComplianceEventCount: 1,
      },
    });
  });

  test("builds visible status follow-up details for rejected and additional-documents states", () => {
    const rejected = {
      status: "rejected",
      applicationState: "duplicate_identity",
      participantTypeKey: "freelancer_driver",
      reviewDecision: "rejected",
      reviewedAt: "2026-05-30T08:10:00.000Z",
      inviteEmailSentAt: "",
      inviteRedirectTo: "",
      reviewReason: "duplicate_identity",
      requestedDocuments: [],
      profileHandoff: {
        ready: false,
        organizationId: "",
        userId: "",
        participantProfileId: "",
        driverProfileId: "",
        fleetDriverStatus: "",
        fleetHandoffReady: false,
        fleetDocumentCount: 0,
        fleetComplianceEventCount: 0,
        inviteRedirectTo: "",
        inviteEmailSentAt: "",
      },
    };
    const additionalDocs = {
      ...rejected,
      status: "pending",
      applicationState: "additional_documents_requested",
      reviewDecision: "",
      reviewReason: "license_expired",
      requestedDocuments: ["driver_license", "vehicle_registration"],
    };

    expect(formatMobileV2DriverApplicationStatusCopy(rejected)).toBe(
      "Rejected. Review the decision details below.",
    );
    expect(buildMobileV2DriverApplicationFollowUp(rejected)).toEqual({
      title: "Application rejected",
      tone: "danger",
      reason: "duplicate_identity",
      requestedDocuments: [],
    });

    expect(formatMobileV2DriverApplicationStatusCopy(additionalDocs)).toContain(
      "driver_license, vehicle_registration",
    );
    expect(buildMobileV2DriverApplicationFollowUp(additionalDocs)).toEqual({
      title: "Documents requested",
      tone: "warning",
      reason: "license_expired",
      requestedDocuments: ["driver_license", "vehicle_registration"],
    });
  });
});
