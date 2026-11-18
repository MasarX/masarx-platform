import {
  mapFieldopsLatestIncidentEnvelope,
  mobileV2IncidentMatchesWrite,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";

describe("Mobile V2 incident readback", () => {
  test("maps latest_incident into the same-screen readback contract", () => {
    const readback = mapFieldopsLatestIncidentEnvelope({
      latest_incident: {
        incident_id: "11111111-2222-4333-8444-555555555555",
        decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        type_id: "collision",
        severity: "high",
        statement: "Side impact at gate 4",
        stop_id: "99999999-8888-4777-8666-555555555555",
        photo_storage_path: "incidents/p1.jpg",
        submitted_at: "2026-05-27T13:20:00Z",
      },
    });

    expect(readback).toEqual({
      incidentId: "11111111-2222-4333-8444-555555555555",
      decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      typeId: "collision",
      severity: "high",
      statement: "Side impact at gate 4",
      stopId: "99999999-8888-4777-8666-555555555555",
      photoPath: "incidents/p1.jpg",
      submittedAt: "2026-05-27T13:20:00Z",
    });
  });

  test("does not fabricate readback when required backend fields are missing", () => {
    expect(
      mapFieldopsLatestIncidentEnvelope({
        latest_incident: {
          type_id: "collision",
          severity: "high",
        },
      }),
    ).toBeNull();
  });

  test("accepts visible success only when latest readback matches the write decision", () => {
    const write = {
      ok: true as const,
      decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      incident_id: "11111111-2222-4333-8444-555555555555",
      state: "high",
    };

    expect(
      mobileV2IncidentMatchesWrite(
        {
          incidentId: "11111111-2222-4333-8444-555555555555",
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          typeId: "collision",
          severity: "high",
          statement: "Side impact at gate 4",
          stopId: null,
          photoPath: null,
          submittedAt: "2026-05-27T13:20:00Z",
        },
        write,
        "collision",
        "high",
        "Side impact at gate 4",
      ),
    ).toBe(true);

    expect(
      mobileV2IncidentMatchesWrite(
        {
          incidentId: "11111111-2222-4333-8444-555555555555",
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          typeId: "breakdown",
          severity: "med",
          statement: "Side impact at gate 4",
          stopId: null,
          photoPath: null,
          submittedAt: "2026-05-27T13:20:00Z",
        },
        write,
        "collision",
        "high",
        "Side impact at gate 4",
      ),
    ).toBe(false);

    expect(
      mobileV2IncidentMatchesWrite(
        {
          incidentId: "11111111-2222-4333-8444-555555555555",
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          typeId: "collision",
          severity: "high",
          statement: "Different statement from stale readback",
          stopId: null,
          photoPath: null,
          submittedAt: "2026-05-27T13:20:00Z",
        },
        write,
        "collision",
        "high",
        "Side impact at gate 4",
      ),
    ).toBe(false);

    expect(
      mobileV2IncidentMatchesWrite(
        {
          incidentId: "11111111-2222-4333-8444-555555555555",
          decisionLogId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          typeId: "damage",
          severity: "med",
          statement: null,
          stopId: null,
          photoPath: null,
          submittedAt: "2026-05-27T13:20:00Z",
        },
        write,
        "damage",
        "med",
        "   ",
      ),
    ).toBe(true);
  });

  test("rejects an older latest incident as current visible proof", () => {
    const write = {
      ok: true as const,
      decision_log_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      incident_id: "11111111-2222-4333-8444-555555555555",
      state: "high",
    };

    expect(
      mobileV2IncidentMatchesWrite(
        {
          incidentId: "99999999-2222-4333-8444-555555555555",
          decisionLogId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          typeId: "collision",
          severity: "high",
          statement: "Older incident still cached by latest readback",
          stopId: null,
          photoPath: null,
          submittedAt: "2026-05-27T13:10:00Z",
        },
        write,
        "collision",
        "high",
        "Side impact at gate 4",
      ),
    ).toBe(false);
  });
});
