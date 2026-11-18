// Unit coverage for the Tasks + Route saved-view / filter / sort /
// group pure module (mobile-v2-tasks-views.ts). These helpers back the
// design-faithful Saved Views sheet, the Filters/Group/Sort sheets, and
// the Tasks Board/Map view bodies (audit F7/F8/F9).

import {
  MOBILE_V2_TASK_DEFAULT_VIEWS,
  MOBILE_V2_TASK_FILTER_FIELDS,
  MOBILE_V2_TASK_GROUP_OPTIONS,
  MOBILE_V2_TASK_SORT_OPTIONS,
  MOBILE_V2_ROUTE_DEFAULT_VIEWS,
  MOBILE_V2_ROUTE_GROUP_OPTIONS,
  MOBILE_V2_ROUTE_SORT_OPTIONS,
  applyMobileV2RouteView,
  applyMobileV2TaskFilters,
  applyMobileV2TaskGroups,
  applyMobileV2TaskSort,
  collectMobileV2TaskAreas,
  countMobileV2TaskFilters,
  getMobileV2RouteGroupLabel,
  getMobileV2RouteSortLabel,
  getMobileV2TaskGroupLabel,
  getMobileV2TaskSortLabel,
  mobileV2RouteWindowBucket,
  mobileV2TaskHasCod,
  projectMobileV2RouteMap,
} from "../../../apps/fieldops/src/mobile-v2-tasks-views";
import {
  mapMobileV2TaskToRouteStop,
  parseMobileV2RouteManifestSummary,
  selectMobileV2RouteTasks,
} from "../../../apps/fieldops/src/mobile-v2-rpc-hooks";
import type { MobileV2Task } from "../../../apps/fieldops/src/mobile-v2-tasks-types";
import type { MobileV2RouteStop } from "../../../apps/fieldops/src/mobile-v2-route-screen";

function makeTask(over: Partial<MobileV2Task>): MobileV2Task {
  return Object.freeze({
    task_id: "stop:t1",
    type: "delivery",
    title: "Task",
    sub: null,
    urgency: "today",
    cta: "Open",
    route: "/r",
    eta_iso: null,
    priority: 50,
    area: null,
    code: null,
    action: "open",
    tone: "neutral",
    meta: {},
    ...over,
  }) as MobileV2Task;
}

function makeStop(over: Partial<MobileV2RouteStop>): MobileV2RouteStop {
  return Object.freeze({
    id: "s1",
    seq: 1,
    customer: "Customer",
    address: "Addr",
    sla: "10:00",
    status: "pending",
    cod: 0,
    fragile: false,
    attempts: 1,
    ...over,
  }) as MobileV2RouteStop;
}

describe("task saved-view definitions", () => {
  test("the smart inbox is the default tasks view (matches design tv-smart)", () => {
    const smart = MOBILE_V2_TASK_DEFAULT_VIEWS.find((v) => v.id === "tv-smart");
    expect(smart).toBeDefined();
    expect(smart?.emoji).toBe("⚡");
    expect(smart?.sort).toBe("smart");
    expect(smart?.group).toBe("urgency");
  });

  test("every default view exposes a known sort + group key", () => {
    const sortKeys = new Set(MOBILE_V2_TASK_SORT_OPTIONS.map((o) => o.key));
    const groupKeys = new Set(MOBILE_V2_TASK_GROUP_OPTIONS.map((o) => o.key));
    for (const v of MOBILE_V2_TASK_DEFAULT_VIEWS) {
      expect(sortKeys.has(v.sort)).toBe(true);
      expect(groupKeys.has(v.group)).toBe(true);
    }
  });

  test("the route default view set matches the design DEFAULT_VIEWS shape", () => {
    const route = MOBILE_V2_ROUTE_DEFAULT_VIEWS.find((v) => v.id === "route");
    expect(route?.emoji).toBe("🛣");
    expect(route?.sort).toBe("sequence");
    expect(route?.group).toBe("none");
  });
});

describe("countMobileV2TaskFilters", () => {
  test("counts non-empty enum arrays and true bools", () => {
    expect(countMobileV2TaskFilters({})).toBe(0);
    expect(countMobileV2TaskFilters({ urgency: [] })).toBe(0);
    expect(countMobileV2TaskFilters({ urgency: ["now"], cod: true })).toBe(2);
    expect(countMobileV2TaskFilters({ cod: false })).toBe(0);
  });
});

describe("mobileV2TaskHasCod", () => {
  test("detects a numeric cod_amount in meta", () => {
    expect(mobileV2TaskHasCod(makeTask({ meta: { cod_amount: 120 } }))).toBe(true);
    expect(mobileV2TaskHasCod(makeTask({ meta: { cod_amount: 0 } }))).toBe(false);
  });
  test("detects COD copy in the sub text", () => {
    expect(mobileV2TaskHasCod(makeTask({ sub: "Olaya · 250 ﷼ COD" }))).toBe(true);
    expect(mobileV2TaskHasCod(makeTask({ sub: "no cash here" }))).toBe(false);
  });
});

describe("applyMobileV2TaskFilters", () => {
  const tasks = [
    makeTask({ task_id: "a", urgency: "now", area: "Olaya", meta: { cod_amount: 50 } }),
    makeTask({ task_id: "b", urgency: "today", area: "Murooj" }),
    makeTask({ task_id: "c", urgency: "later", area: "Olaya" }),
  ];

  test("urgency filter keeps only matching urgencies", () => {
    const out = applyMobileV2TaskFilters(tasks, { urgency: ["now", "later"] });
    expect(out.map((t) => t.task_id)).toEqual(["a", "c"]);
  });

  test("area filter keeps only matching areas", () => {
    const out = applyMobileV2TaskFilters(tasks, { area: ["Murooj"] });
    expect(out.map((t) => t.task_id)).toEqual(["b"]);
  });

  test("cod filter keeps only COD tasks", () => {
    const out = applyMobileV2TaskFilters(tasks, { cod: true });
    expect(out.map((t) => t.task_id)).toEqual(["a"]);
  });

  test("empty filter state is a passthrough", () => {
    expect(applyMobileV2TaskFilters(tasks, {})).toHaveLength(3);
  });
});

describe("applyMobileV2TaskSort", () => {
  const tasks = [
    makeTask({ task_id: "a", urgency: "later", priority: 90, eta_iso: "2026-05-10T15:00:00Z", title: "Zeta" }),
    makeTask({ task_id: "b", urgency: "now", priority: 10, eta_iso: "2026-05-10T12:00:00Z", title: "Alpha" }),
    makeTask({ task_id: "c", urgency: "now", priority: 80, eta_iso: "2026-05-10T14:00:00Z", title: "Mid" }),
  ];

  test("smart sort orders by urgency then priority", () => {
    const out = applyMobileV2TaskSort(tasks, "smart");
    expect(out.map((t) => t.task_id)).toEqual(["c", "b", "a"]);
  });

  test("eta sort orders by soonest eta", () => {
    const out = applyMobileV2TaskSort(tasks, "eta");
    expect(out[0]?.task_id).toBe("b");
  });

  test("priority sort orders high → low", () => {
    const out = applyMobileV2TaskSort(tasks, "priority");
    expect(out.map((t) => t.priority)).toEqual([90, 80, 10]);
  });

  test("title sort orders A→Z", () => {
    const out = applyMobileV2TaskSort(tasks, "title");
    expect(out.map((t) => t.title)).toEqual(["Alpha", "Mid", "Zeta"]);
  });
});

describe("applyMobileV2TaskGroups", () => {
  const tasks = [
    makeTask({ task_id: "a", urgency: "now", type: "delivery", area: "Olaya" }),
    makeTask({ task_id: "b", urgency: "today", type: "pickup", area: "Olaya" }),
    makeTask({ task_id: "c", urgency: "now", type: "delivery", area: "Murooj" }),
  ];

  test("urgency grouping follows now → today → later order", () => {
    const groups = applyMobileV2TaskGroups(tasks, "urgency");
    expect(groups.map((g) => g.key)).toEqual(["now", "today"]);
    expect(groups[0]?.tasks).toHaveLength(2);
  });

  test("none grouping returns a single All group", () => {
    const groups = applyMobileV2TaskGroups(tasks, "none");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("all");
  });

  test("type + area grouping bucket correctly", () => {
    expect(applyMobileV2TaskGroups(tasks, "type").length).toBe(2);
    expect(applyMobileV2TaskGroups(tasks, "area").length).toBe(2);
  });

  test("empty list yields no groups", () => {
    expect(applyMobileV2TaskGroups([], "urgency")).toHaveLength(0);
  });
});

describe("collectMobileV2TaskAreas", () => {
  test("returns distinct sorted non-empty areas", () => {
    const tasks = [
      makeTask({ area: "Olaya" }),
      makeTask({ area: "Murooj" }),
      makeTask({ area: "Olaya" }),
      makeTask({ area: null }),
    ];
    expect(collectMobileV2TaskAreas(tasks)).toEqual(["Murooj", "Olaya"]);
  });
});

describe("applyMobileV2RouteView", () => {
  const stops = [
    makeStop({ id: "s1", seq: 3, status: "pending", cod: 100, customer: "Cara" }),
    makeStop({ id: "s2", seq: 1, status: "sla", cod: 0, customer: "Ali" }),
    makeStop({ id: "s3", seq: 2, status: "done", cod: 50, customer: "Bara" }),
  ];

  test("status filter keeps only matching statuses", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: ["sla"], codOnly: false, sort: "sequence", group: "none" },
      "",
    );
    expect(r.rows.map((s) => s.id)).toEqual(["s2"]);
  });

  test("cod-only filter drops zero-COD stops", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: true, sort: "sequence", group: "none" },
      "",
    );
    expect(r.rows.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  test("sequence sort orders by seq ascending", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, sort: "sequence", group: "none" },
      "",
    );
    expect(r.rows.map((s) => s.seq)).toEqual([1, 2, 3]);
  });

  test("cod-desc sort orders by COD descending", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, sort: "cod-desc", group: "none" },
      "",
    );
    expect(r.rows.map((s) => s.cod)).toEqual([100, 50, 0]);
  });

  test("search filters on customer / address / id", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, sort: "sequence", group: "none" },
      "ali",
    );
    expect(r.rows.map((s) => s.id)).toEqual(["s2"]);
  });

  test("status grouping splits the rows into status buckets", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, sort: "sequence", group: "status" },
      "",
    );
    expect(r.groups.length).toBe(3);
    const keys = r.groups.map((g) => g.key).sort();
    expect(keys).toEqual(["done", "pending", "sla"]);
  });
});

describe("label helpers", () => {
  test("task sort + group labels resolve known keys", () => {
    expect(getMobileV2TaskSortLabel("smart")).toMatch(/smart/i);
    expect(getMobileV2TaskGroupLabel("none")).toBe("No grouping");
  });
  test("route sort + group labels resolve known keys", () => {
    expect(getMobileV2RouteSortLabel("sequence")).toBe("Route sequence");
    expect(getMobileV2RouteGroupLabel("status")).toBe("Status");
  });
  test("filter field set carries the design's filterable fields", () => {
    const keys = MOBILE_V2_TASK_FILTER_FIELDS.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["urgency", "area", "cod"]));
    expect(MOBILE_V2_ROUTE_SORT_OPTIONS.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// U4 — extended Tasks filter / sort field coverage.
// ---------------------------------------------------------------------------

describe("U4 · Tasks Type filter + Type sort", () => {
  const tasks = [
    makeTask({ task_id: "a", type: "delivery" }),
    makeTask({ task_id: "b", type: "pickup" }),
    makeTask({ task_id: "c", type: "return" }),
  ];

  test("the Type filter field is present with the design's type options", () => {
    const typeField = MOBILE_V2_TASK_FILTER_FIELDS.find((f) => f.key === "type");
    expect(typeField).toBeDefined();
    expect(typeField?.kind).toBe("enum");
    const values = typeField?.options?.map((o) => o.value) ?? [];
    expect(values).toEqual(
      expect.arrayContaining(["delivery", "pickup", "return", "approval"]),
    );
  });

  test("the Type filter keeps only matching task types", () => {
    const out = applyMobileV2TaskFilters(tasks, { type: ["pickup", "return"] });
    expect(out.map((t) => t.task_id)).toEqual(["b", "c"]);
  });

  test("the Type A→Z sort option is present and orders by type", () => {
    expect(MOBILE_V2_TASK_SORT_OPTIONS.some((o) => o.key === "type")).toBe(true);
    const out = applyMobileV2TaskSort(tasks, "type");
    expect(out.map((t) => t.type)).toEqual(["delivery", "pickup", "return"]);
  });
});

// ---------------------------------------------------------------------------
// U4 — extended Route filter / group field coverage.
// ---------------------------------------------------------------------------

describe("U4 · Route fragile + re-attempt filters", () => {
  const stops = [
    makeStop({ id: "s1", fragile: true, attempts: 1 }),
    makeStop({ id: "s2", fragile: false, attempts: 3 }),
    makeStop({ id: "s3", fragile: true, attempts: 2 }),
  ];

  test("fragileOnly keeps only fragile stops", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, fragileOnly: true, sort: "sequence", group: "none" },
      "",
    );
    expect(r.rows.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  test("reattemptOnly keeps only stops with more than one attempt", () => {
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, reattemptOnly: true, sort: "sequence", group: "none" },
      "",
    );
    expect(r.rows.map((s) => s.id).sort()).toEqual(["s2", "s3"]);
  });

  test("fragile + re-attempt compose (design 'fragile' default view)", () => {
    const r = applyMobileV2RouteView(
      stops,
      {
        statusFilter: [],
        codOnly: false,
        fragileOnly: true,
        reattemptOnly: true,
        sort: "sequence",
        group: "none",
      },
      "",
    );
    expect(r.rows.map((s) => s.id)).toEqual(["s3"]);
  });

  test("the design 'fragile' default view carries both filter flags", () => {
    const fragile = MOBILE_V2_ROUTE_DEFAULT_VIEWS.find((v) => v.id === "fragile");
    expect(fragile?.fragileOnly).toBe(true);
    expect(fragile?.reattemptOnly).toBe(true);
  });
});

describe("U4 · Route time-window grouping", () => {
  test("mobileV2RouteWindowBucket bands an HH:MM SLA", () => {
    expect(mobileV2RouteWindowBucket("09:30")).toMatch(/Morning/);
    expect(mobileV2RouteWindowBucket("12:00")).toMatch(/Midday/);
    expect(mobileV2RouteWindowBucket("16:45")).toMatch(/Afternoon/);
    expect(mobileV2RouteWindowBucket("")).toBe("No window");
  });

  test("window group is in the route group options", () => {
    expect(MOBILE_V2_ROUTE_GROUP_OPTIONS.some((o) => o.key === "window")).toBe(true);
    expect(getMobileV2RouteGroupLabel("window")).toBe("Time window");
  });

  test("group='window' splits rows into time-window sections", () => {
    const stops = [
      makeStop({ id: "s1", sla: "09:00" }),
      makeStop({ id: "s2", sla: "12:30" }),
      makeStop({ id: "s3", sla: "10:15" }),
    ];
    const r = applyMobileV2RouteView(
      stops,
      { statusFilter: [], codOnly: false, sort: "sequence", group: "window" },
      "",
    );
    // s1 + s3 land in Morning, s2 in Midday → 2 groups.
    expect(r.groups.length).toBe(2);
    const morning = r.groups.find((g) => /Morning/.test(g.label));
    expect(morning?.rows.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });
});

// ---------------------------------------------------------------------------
// E2 — Live-route map projection from resolved route stops.
// ---------------------------------------------------------------------------

describe("E2 · projectMobileV2RouteMap", () => {
  const rows = [
    makeStop({ id: "s1", seq: 1, status: "done", cod: 0 }),
    makeStop({ id: "s2", seq: 2, status: "current", cod: 320 }),
    makeStop({ id: "s3", seq: 3, status: "pending", cod: 0 }),
    makeStop({ id: "s4", seq: 4, status: "sla", cod: 0 }),
  ];

  test("active is the stop in 'current' status", () => {
    const m = projectMobileV2RouteMap(rows, "RT-1");
    expect(m.active?.id).toBe("s2");
    expect(m.active?.cod).toBe(320);
  });

  test("upcoming is every not-done stop in sequence order", () => {
    const m = projectMobileV2RouteMap(rows, "RT-1");
    expect(m.upcoming.map((s) => s.id)).toEqual(["s2", "s3", "s4"]);
  });

  test("mapStops keeps every route stop in sequence order for coordinate-backed maps", () => {
    const m = projectMobileV2RouteMap(rows, "RT-1");
    expect(m.mapStops.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  test("pendingCount counts the upcoming stops", () => {
    expect(projectMobileV2RouteMap(rows, "RT-1").pendingCount).toBe(3);
  });

  test("routeId is passed through; ETA/distance/alerts are honest empties", () => {
    const m = projectMobileV2RouteMap(rows, "RT-9");
    expect(m.routeId).toBe("RT-9");
    expect(m.distanceLeftKm).toBe(0);
    expect(m.alerts).toHaveLength(0);
    // The route resolver carries no per-stop ETA/distance — projected as 0.
    expect(m.upcoming.every((s) => s.etaMin === 0 && s.distanceKm === 0)).toBe(true);
  });

  test("passes coordinate and Saudi geocoding metadata into the map stop projection", () => {
    const m = projectMobileV2RouteMap(
      [
        makeStop({
          id: "s1",
          seq: 1,
          status: "current",
          latitude: 24.7136,
          longitude: 46.6753,
          accuracyM: 8,
          shortAddress: "TEST0000",
          geocodingStatus: "geocoded",
          geocodingAccuracy: "rooftop",
          geocodingProvider: "local_postgis",
          geocodingMatch: "sa_short_code_registry",
        }),
      ],
      "RT-GEO",
    );

    expect(m.active).toMatchObject({
      latitude: 24.7136,
      longitude: 46.6753,
      accuracyM: 8,
      shortAddress: "TEST0000",
      geocodingStatus: "geocoded",
      geocodingAccuracy: "rooftop",
      geocodingProvider: "local_postgis",
      geocodingMatch: "sa_short_code_registry",
    });
    expect(m.mapStops[0]).toMatchObject({
      latitude: 24.7136,
      longitude: 46.6753,
      shortAddress: "TEST0000",
      geocodingProvider: "local_postgis",
    });
  });

  test("an all-done route has no active stop, empty upcoming list, and preserved map stops", () => {
    const done = [
      makeStop({ id: "d1", seq: 1, status: "done", latitude: 24.713, longitude: 46.6766 }),
      makeStop({ id: "d2", seq: 2, status: "done" }),
    ];
    const m = projectMobileV2RouteMap(done, "RT-1");
    expect(m.active).toBeNull();
    expect(m.upcoming).toHaveLength(0);
    expect(m.mapStops).toHaveLength(2);
    expect(m.mapStops[0]).toMatchObject({ id: "d1", latitude: 24.713, longitude: 46.6766 });
    expect(m.pendingCount).toBe(0);
  });
});

describe("Mobile V2 route manifest summary projection", () => {
  test("scopes Route rows to the same route run as the visible manifest", () => {
    const selected = selectMobileV2RouteTasks([
      makeTask({
        task_id: "stop:route-a-1",
        code: "260029TDC",
        meta: { route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb" },
      }),
      makeTask({
        task_id: "stop:pickup-without-route",
        code: "PICKUP-BROWSER-CREATE-20260518",
        type: "pickup",
      }),
      makeTask({
        task_id: "stop:route-b-1",
        code: "26001ZS97",
        meta: { route_run_id: "c4b88a6e-a09e-4364-b1a5-67d843804e3c" },
      }),
    ]);

    expect(selected.routeRunId).toBe("046b311e-33d2-4d07-802f-694d8698a1eb");
    expect(selected.routeId).toBe("RT-046b311e");
    expect(selected.stopTasks.map((task) => task.code)).toEqual(["260029TDC"]);
  });

  test("prefers the next actionable route over an already terminal route", () => {
    const selected = selectMobileV2RouteTasks([
      makeTask({
        task_id: "stop:departed-failed",
        code: "260029TDC",
        cta: "Failed",
        meta: {
          route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
          route_stop_status: "failed",
        },
      }),
      makeTask({
        task_id: "stop:ready-to-depart",
        code: "PICKUP-FAIL-RETRY-1779341573557",
        cta: "Start",
        meta: {
          route_run_id: "bf9c8e67-c03d-4a02-8e5a-f9c40b804e4f",
          route_stop_status: "pending",
        },
      }),
    ]);

    expect(selected.routeRunId).toBe("bf9c8e67-c03d-4a02-8e5a-f9c40b804e4f");
    expect(selected.routeId).toBe("RT-bf9c8e67");
    expect(selected.stopTasks.map((task) => task.code)).toEqual([
      "PICKUP-FAIL-RETRY-1779341573557",
    ]);
  });

  test("keeps the active stop route pinned for same-context terminal readback", () => {
    const selected = selectMobileV2RouteTasks(
      [
        makeTask({
          task_id: "stop:just-failed",
          code: "MV2FAILNOTETFO9F5",
          cta: "Failed",
          meta: {
            route_run_id: "6084a377-c5d7-4eb6-99e6-a6cc7ba2dfcc",
            route_stop_status: "failed",
          },
        }),
        makeTask({
          task_id: "stop:next-active",
          code: "NEXT-ACTIONABLE",
          cta: "Start",
          meta: {
            route_run_id: "bf9c8e67-c03d-4a02-8e5a-f9c40b804e4f",
            route_stop_status: "pending",
          },
        }),
      ],
      "stop:just-failed",
    );

    expect(selected.routeRunId).toBe("6084a377-c5d7-4eb6-99e6-a6cc7ba2dfcc");
    expect(selected.stopTasks.map((task) => task.code)).toEqual(["MV2FAILNOTETFO9F5"]);
  });

  test("maps backend assignment, scan-out, and departure state into visible labels", () => {
    const summary = parseMobileV2RouteManifestSummary(
      {
        route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        route_assignment: {
          assignment_status: "accepted",
          assignment_mode: "internal_driver",
        },
        scan_out: {
          expected_stop_count: 4,
          scanned_stop_count: 4,
          missing_stop_count: 0,
          unexpected_scan_count: 0,
          ready_for_departure: true,
        },
        route_departure: {
          confirmed_at: "2026-05-25T10:00:00Z",
        },
      },
      null,
    );

    expect(summary).toEqual({
      routeLabel: "RT-046b311e",
      assignmentLabel: "Assignment Accepted",
      scanOutLabel: "Scan-out ready 4/4",
      departureLabel: "Departed",
      readyForDeparture: true,
      departed: true,
    });
  });

  test("keeps departure gated when canonical scan-out is incomplete", () => {
    const summary = parseMobileV2RouteManifestSummary(
      {
        route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        scan_out: {
          expected_stop_count: "3",
          scanned_stop_count: "1",
          missing_stop_count: "2",
          unexpected_scan_count: 0,
          ready_for_departure: false,
        },
      },
      "RT-live",
    );

    expect(summary).toMatchObject({
      routeLabel: "RT-live",
      assignmentLabel: "Assignment pending",
      scanOutLabel: "Scan-out missing 2/3",
      departureLabel: "Departure gated",
      readyForDeparture: false,
      departed: false,
    });
  });

  test("flags unexpected scan-out exceptions from backend readback", () => {
    const summary = parseMobileV2RouteManifestSummary(
      {
        route_run_id: "046b311e-33d2-4d07-802f-694d8698a1eb",
        scan_out: {
          expected_stop_count: 2,
          scanned_stop_count: 2,
          missing_stop_count: 0,
          unexpected_scan_count: 1,
          ready_for_departure: false,
        },
      },
      null,
    );

    expect(summary?.scanOutLabel).toBe("Scan-out exception 1");
    expect(summary?.departureLabel).toBe("Departure gated");
  });
});

describe("Mobile V2 route readback status projection", () => {
  test("uses route_stop_status before shipment status so POD completion is visible in Route", () => {
    const row = mapMobileV2TaskToRouteStop(
      makeTask({
        task_id: "stop:done-1",
        meta: {
          route_stop_status: "done",
          shipment_status: "pending",
          sequence_order: 9,
        },
      }),
      0,
    );

    expect(row.status).toBe("done");
  });

  test("maps failed and partial route_stop_status to distinct route-stop states", () => {
    const failed = mapMobileV2TaskToRouteStop(
      makeTask({
        task_id: "stop:failed-1",
        meta: {
          route_stop_status: "failed",
          shipment_status: "pending",
          sequence_order: 2,
        },
      }),
      0,
    );
    const partial = mapMobileV2TaskToRouteStop(
      makeTask({
        task_id: "stop:partial-1",
        meta: {
          route_stop_status: "partial",
          shipment_status: "pending",
          sequence_order: 2,
        },
      }),
      0,
    );

    expect(failed.status).toBe("failed");
    expect(partial.status).toBe("partial");
    expect(
      applyMobileV2RouteView(
        [failed, partial],
        { statusFilter: [], codOnly: false, sort: "sequence", group: "status" },
        "",
      ).groups.map((group) => group.label).sort(),
    ).toEqual(["Failed", "Partial"]);
  });
});
