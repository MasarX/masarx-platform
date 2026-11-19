import {
  MOBILE_V2_TASK_HIGH_PRIORITY_THRESHOLD,
  MOBILE_V2_TASK_SORT_MODES,
  deriveMobileV2TaskCompletionState,
  deriveMobileV2TaskMetaLabel,
  filterMobileV2TasksByQuery,
  getMobileV2TaskSortModeLabel,
  groupMobileV2TasksByUrgency,
  isMobileV2TaskHighPriority,
  nextMobileV2TaskSortMode,
  parseMobileV2Task,
  parseMobileV2TaskList,
  sortMobileV2TasksBy,
  sortMobileV2TasksSmart,
  type MobileV2Task,
} from "../../../apps/fieldops/src/mobile-v2-tasks-types";

const RAW_TASK = {
  task_id: "stop:abc",
  type: "delivery",
  title: "DLX-12345",
  sub: "premium · COD 250 SAR · Olaya",
  urgency: "now",
  cta: "Start",
  route: "/mobile/stop/abc",
  eta_iso: "2026-05-10T12:30:00Z",
  priority: 80,
  area: "Olaya",
  code: "DLX-12345",
  action: "delivery",
  tone: "warning",
  meta: { route_run_id: "rr-1" },
};

describe("parseMobileV2Task", () => {
  test("parses a complete task", () => {
    const t = parseMobileV2Task(RAW_TASK);
    expect(t).not.toBeNull();
    expect(t?.title).toBe("DLX-12345");
    expect(t?.urgency).toBe("now");
    expect(t?.priority).toBe(80);
    expect(t?.tone).toBe("warning");
    expect(t?.meta).toEqual({ route_run_id: "rr-1" });
  });

  test("returns null when required field missing", () => {
    expect(parseMobileV2Task({ title: "x", route: "/r" })).toBeNull(); // no task_id
    expect(parseMobileV2Task({ task_id: "x", title: "y" })).toBeNull(); // no route
  });

  test("urgency defaults to later for unknown / missing", () => {
    const t = parseMobileV2Task({ ...RAW_TASK, urgency: "imaginary" });
    expect(t?.urgency).toBe("later");
  });

  test("tone defaults to neutral for unknown", () => {
    const t = parseMobileV2Task({ ...RAW_TASK, tone: "magenta" });
    expect(t?.tone).toBe("neutral");
  });

  test("route-stop terminal readback overrides stale cta and tone", () => {
    const done = parseMobileV2Task({
      ...RAW_TASK,
      cta: "Open",
      tone: "neutral",
      meta: { route_stop_status: "done", cod_amount: 25 },
    });
    const failed = parseMobileV2Task({
      ...RAW_TASK,
      cta: "Open",
      tone: "neutral",
      meta: { route_stop_status: "failed" },
    });
    const partial = parseMobileV2Task({
      ...RAW_TASK,
      cta: "Open",
      tone: "neutral",
      meta: { route_stop_status: "partial" },
    });

    expect(done?.cta).toBe("Done");
    expect(done?.tone).toBe("success");
    expect(failed?.cta).toBe("Failed");
    expect(failed?.tone).toBe("danger");
    expect(partial?.cta).toBe("Partial");
    expect(partial?.tone).toBe("warning");
  });

  test("priority is clamped to 0..100 and rounded", () => {
    expect(parseMobileV2Task({ ...RAW_TASK, priority: -50 })?.priority).toBe(0);
    expect(parseMobileV2Task({ ...RAW_TASK, priority: 250 })?.priority).toBe(100);
    expect(parseMobileV2Task({ ...RAW_TASK, priority: 73.6 })?.priority).toBe(74);
    expect(parseMobileV2Task({ ...RAW_TASK, priority: null })?.priority).toBe(50);
  });

  test("non-record meta becomes empty frozen object", () => {
    expect(parseMobileV2Task({ ...RAW_TASK, meta: "string" })?.meta).toEqual({});
    expect(parseMobileV2Task({ ...RAW_TASK, meta: null })?.meta).toEqual({});
  });

  test("non-object input returns null", () => {
    expect(parseMobileV2Task(null)).toBeNull();
    expect(parseMobileV2Task(undefined)).toBeNull();
    expect(parseMobileV2Task("string")).toBeNull();
  });
});

describe("parseMobileV2TaskList", () => {
  test("filters out malformed rows", () => {
    const list = parseMobileV2TaskList([
      RAW_TASK,
      { task_id: "incomplete" }, // missing title + route
      null,
      { ...RAW_TASK, task_id: "stop:def", title: "DLX-2" },
    ]);
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.task_id)).toEqual(["stop:abc", "stop:def"]);
  });

  test("non-array input returns empty list", () => {
    expect(parseMobileV2TaskList(null)).toEqual([]);
    expect(parseMobileV2TaskList({})).toEqual([]);
    expect(parseMobileV2TaskList("oops")).toEqual([]);
  });

  test("an empty resolver array yields an empty list — E8: an empty task day is honest, never the fixture", () => {
    // useFieldopsTasksRpc returns parseMobileV2TaskList(raw) directly for a
    // live resolver, so a real driver with zero tasks gets [] and the Tasks
    // screen renders its real "All clear" empty state. The
    // MOBILE_V2_PREVIEW_TASKS fixture is reachable only in preview mode
    // (supabase === null) — it is never substituted for a real empty day.
    expect(parseMobileV2TaskList([])).toEqual([]);
  });

  test("a resolver array of only malformed rows yields an empty list, never the fixture", () => {
    expect(
      parseMobileV2TaskList([{ task_id: "incomplete" }, null, "oops"]),
    ).toEqual([]);
  });
});

describe("sortMobileV2TasksSmart", () => {
  function task(overrides: Partial<MobileV2Task> = {}): MobileV2Task {
    return Object.freeze({
      task_id: overrides.task_id ?? "stop:1",
      type: "delivery",
      title: overrides.title ?? "X",
      sub: null,
      urgency: overrides.urgency ?? "later",
      cta: "Open",
      route: "/r",
      eta_iso: overrides.eta_iso ?? null,
      priority: overrides.priority ?? 50,
      area: null,
      code: overrides.code ?? overrides.task_id ?? null,
      action: "open",
      tone: "neutral",
      meta: {},
      ...overrides,
    } as MobileV2Task);
  }

  test("urgency takes precedence (now < today < later)", () => {
    const sorted = sortMobileV2TasksSmart([
      task({ task_id: "L", urgency: "later" }),
      task({ task_id: "N", urgency: "now" }),
      task({ task_id: "T", urgency: "today" }),
    ]);
    expect(sorted.map((t) => t.task_id)).toEqual(["N", "T", "L"]);
  });

  test("within urgency: priority desc", () => {
    const sorted = sortMobileV2TasksSmart([
      task({ task_id: "lo", urgency: "now", priority: 30 }),
      task({ task_id: "hi", urgency: "now", priority: 90 }),
      task({ task_id: "md", urgency: "now", priority: 60 }),
    ]);
    expect(sorted.map((t) => t.task_id)).toEqual(["hi", "md", "lo"]);
  });

  test("within priority: eta asc, NULLs last", () => {
    const sorted = sortMobileV2TasksSmart([
      task({ task_id: "later", urgency: "now", priority: 50, eta_iso: "2026-05-10T14:00:00Z" }),
      task({ task_id: "null", urgency: "now", priority: 50, eta_iso: null }),
      task({ task_id: "early", urgency: "now", priority: 50, eta_iso: "2026-05-10T12:00:00Z" }),
    ]);
    expect(sorted.map((t) => t.task_id)).toEqual(["early", "later", "null"]);
  });

  test("stable tiebreaker: code locale-compare", () => {
    const sorted = sortMobileV2TasksSmart([
      task({ task_id: "a", urgency: "now", priority: 50, code: "DLX-3" }),
      task({ task_id: "b", urgency: "now", priority: 50, code: "DLX-1" }),
      task({ task_id: "c", urgency: "now", priority: 50, code: "DLX-2" }),
    ]);
    expect(sorted.map((t) => t.code)).toEqual(["DLX-1", "DLX-2", "DLX-3"]);
  });
});

describe("groupMobileV2TasksByUrgency", () => {
  test("groups in canonical order (now/today/later) and drops empty buckets", () => {
    const tasks = parseMobileV2TaskList([
      { ...RAW_TASK, task_id: "1", urgency: "today" },
      { ...RAW_TASK, task_id: "2", urgency: "now" },
      { ...RAW_TASK, task_id: "3", urgency: "today" },
    ]);
    const groups = groupMobileV2TasksByUrgency(tasks);
    expect(groups.map((g) => g.key)).toEqual(["now", "today"]);
    expect(groups.find((g) => g.key === "now")?.count).toBe(1);
    expect(groups.find((g) => g.key === "today")?.count).toBe(2);
  });

  test("empty input returns empty array", () => {
    expect(groupMobileV2TasksByUrgency([])).toEqual([]);
  });
});

describe("filterMobileV2TasksByQuery", () => {
  const tasks = parseMobileV2TaskList([
    { ...RAW_TASK, task_id: "stop:1", code: "DLX-100", title: "Olaya delivery", area: "Olaya", sub: "north" },
    { ...RAW_TASK, task_id: "stop:2", code: "DLX-200", title: "Riyadh pickup", area: "Riyadh", sub: "central" },
    { ...RAW_TASK, task_id: "stop:3", code: "DLX-300", title: "Jeddah cash drop", area: "Jeddah", sub: "west" },
  ]);

  test("empty query is passthrough", () => {
    expect(filterMobileV2TasksByQuery(tasks, "")).toHaveLength(3);
    expect(filterMobileV2TasksByQuery(tasks, "   ")).toHaveLength(3);
  });

  test("case-insensitive title match", () => {
    const out = filterMobileV2TasksByQuery(tasks, "olaya");
    expect(out).toHaveLength(1);
    expect(out[0]?.task_id).toBe("stop:1");
  });

  test("matches code", () => {
    const out = filterMobileV2TasksByQuery(tasks, "DLX-200");
    expect(out.map((t) => t.task_id)).toEqual(["stop:2"]);
  });

  test("substring across multiple fields", () => {
    expect(filterMobileV2TasksByQuery(tasks, "cash").map((t) => t.task_id)).toEqual(["stop:3"]);
  });

  test("no matches returns empty list", () => {
    expect(filterMobileV2TasksByQuery(tasks, "no-such-thing")).toEqual([]);
  });
});

describe("sort mode cycling", () => {
  const sample: MobileV2Task[] = parseMobileV2TaskList([
    { ...RAW_TASK, task_id: 't1', code: 'A-001', area: 'Olaya', priority: 30, eta_iso: '2026-05-10T13:00:00Z', urgency: 'today' },
    { ...RAW_TASK, task_id: 't2', code: 'A-002', area: 'Riyadh', priority: 90, eta_iso: '2026-05-10T12:00:00Z', urgency: 'now' },
    { ...RAW_TASK, task_id: 't3', code: 'A-003', area: 'Malaz', priority: 60, eta_iso: null, urgency: 'later' },
  ]) as MobileV2Task[];

  test('nextMobileV2TaskSortMode cycles smart -> eta -> priority -> area -> smart', () => {
    expect(nextMobileV2TaskSortMode('smart')).toBe('eta');
    expect(nextMobileV2TaskSortMode('eta')).toBe('priority');
    expect(nextMobileV2TaskSortMode('priority')).toBe('area');
    expect(nextMobileV2TaskSortMode('area')).toBe('smart');
  });

  test('MOBILE_V2_TASK_SORT_MODES contains exactly 4 modes', () => {
    expect(MOBILE_V2_TASK_SORT_MODES.length).toBe(4);
  });

  test('getMobileV2TaskSortModeLabel returns label per mode', () => {
    expect(getMobileV2TaskSortModeLabel('smart')).toBe('Smart');
    expect(getMobileV2TaskSortModeLabel('eta')).toBe('ETA');
    expect(getMobileV2TaskSortModeLabel('priority')).toBe('Priority');
    expect(getMobileV2TaskSortModeLabel('area')).toBe('Area');
  });

  test('sortMobileV2TasksBy(eta) orders by ETA asc, null last', () => {
    const r = sortMobileV2TasksBy(sample, 'eta');
    expect(r.map((t) => t.task_id)).toEqual(['t2', 't1', 't3']);
  });

  test('sortMobileV2TasksBy(priority) orders by priority desc', () => {
    const r = sortMobileV2TasksBy(sample, 'priority');
    expect(r.map((t) => t.task_id)).toEqual(['t2', 't3', 't1']);
  });

  test('sortMobileV2TasksBy(area) orders alphabetically', () => {
    const r = sortMobileV2TasksBy(sample, 'area');
    expect(r.map((t) => t.area)).toEqual(['Malaz', 'Olaya', 'Riyadh']);
  });

  test('sortMobileV2TasksBy(smart) matches sortMobileV2TasksSmart', () => {
    const a = sortMobileV2TasksBy(sample, 'smart').map((t) => t.task_id);
    const b = sortMobileV2TasksSmart(sample).map((t) => t.task_id);
    expect(a).toEqual(b);
  });
});

describe("isMobileV2TaskHighPriority", () => {
  test("true at/above the threshold, false below", () => {
    expect(MOBILE_V2_TASK_HIGH_PRIORITY_THRESHOLD).toBe(75);
    expect(isMobileV2TaskHighPriority(parseMobileV2Task({ ...RAW_TASK, priority: 75 })!)).toBe(true);
    expect(isMobileV2TaskHighPriority(parseMobileV2Task({ ...RAW_TASK, priority: 88 })!)).toBe(true);
    expect(isMobileV2TaskHighPriority(parseMobileV2Task({ ...RAW_TASK, priority: 74 })!)).toBe(false);
    expect(isMobileV2TaskHighPriority(parseMobileV2Task({ ...RAW_TASK, priority: 50 })!)).toBe(false);
  });
});

describe("deriveMobileV2TaskMetaLabel", () => {
  function task(meta: Record<string, unknown>): MobileV2Task {
    return parseMobileV2Task({ ...RAW_TASK, meta })!;
  }

  test("COD amount takes precedence and renders the raw value + ﷼ + COD", () => {
    expect(deriveMobileV2TaskMetaLabel(task({ cod_amount: 1840, cod_currency: "SAR" }))).toBe(
      "1840 ﷼ COD",
    );
  });

  test("COD honours the resolved currency code", () => {
    expect(deriveMobileV2TaskMetaLabel(task({ cod_amount: 100, cod_currency: "USD" }))).toBe(
      "100 $ COD",
    );
  });

  test("COD currency defaults to SAR when absent", () => {
    expect(deriveMobileV2TaskMetaLabel(task({ cod_amount: 320 }))).toBe("320 ﷼ COD");
  });

  test("box count is used when there is no COD (singular vs plural)", () => {
    expect(deriveMobileV2TaskMetaLabel(task({ box_count: 1 }))).toBe("1 box");
    expect(deriveMobileV2TaskMetaLabel(task({ box_count: 4 }))).toBe("4 boxes");
  });

  test("COD outranks box count", () => {
    expect(
      deriveMobileV2TaskMetaLabel(task({ cod_amount: 250, cod_currency: "SAR", box_count: 2 })),
    ).toBe("250 ﷼ COD");
  });

  test("route-stop terminal readback outranks COD and box count", () => {
    const done = task({ route_stop_status: "done", cod_amount: 250, box_count: 2 });
    const failed = task({ route_stop_status: "failed", cod_amount: 250 });
    const partial = task({ route_stop_status: "partial", cod_amount: 250, box_count: 2 });

    expect(deriveMobileV2TaskCompletionState(done)).toBe("done");
    expect(deriveMobileV2TaskMetaLabel(done)).toBe("Done");
    expect(deriveMobileV2TaskCompletionState(failed)).toBe("failed");
    expect(deriveMobileV2TaskMetaLabel(failed)).toBe("Failed");
    expect(deriveMobileV2TaskCompletionState(partial)).toBe("partial");
    expect(deriveMobileV2TaskMetaLabel(partial)).toBe("Partial");
  });

  test("queued-writes count is the last fallback", () => {
    expect(deriveMobileV2TaskMetaLabel(task({ queued: 3 }))).toBe("3 queued");
  });

  test("returns null when no meta signal is present", () => {
    expect(deriveMobileV2TaskMetaLabel(task({}))).toBeNull();
    expect(deriveMobileV2TaskMetaLabel(task({ reason: "recipient_unavailable" }))).toBeNull();
    expect(deriveMobileV2TaskMetaLabel(task({ cod_amount: 0, box_count: 0 }))).toBeNull();
  });

  test("coerces numeric strings from the JSONB envelope", () => {
    expect(deriveMobileV2TaskMetaLabel(task({ box_count: "2" }))).toBe("2 boxes");
    expect(deriveMobileV2TaskMetaLabel(task({ cod_amount: "540", cod_currency: "SAR" }))).toBe(
      "540 ﷼ COD",
    );
  });
});
