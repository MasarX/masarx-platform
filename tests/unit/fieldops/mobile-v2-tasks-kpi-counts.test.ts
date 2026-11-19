// Unit coverage for computeMobileV2TaskKpiCounts — pure helper that drives
// the Tasks screen Now / Today / Later / Total hero strip. The KPI strip is
// the most visible chrome on the Tasks screen, so this helper's correctness
// affects every gallery snapshot + the live audit gallery.

import {
  computeMobileV2TaskKpiCounts,
  parseMobileV2TaskList,
  type MobileV2Task,
  type MobileV2TaskKpiCounts,
} from "../../../apps/fieldops/src/mobile-v2-tasks-types";

function makeTask(overrides: Partial<MobileV2Task>): MobileV2Task {
  const base: MobileV2Task = {
    id: "tsk-1",
    type: "delivery",
    title: "Test task",
    sub: null,
    code: null,
    urgency: "now",
    cta: "Start",
    tone: "danger",
    eta_iso: null,
    priority: 0,
  };
  return Object.freeze({ ...base, ...overrides });
}

describe("computeMobileV2TaskKpiCounts", () => {
  test("returns zero counts for an empty list", () => {
    const out = computeMobileV2TaskKpiCounts([]);
    expect(out).toEqual({ now: 0, today: 0, later: 0, all: 0 });
  });

  test("counts a single Now task", () => {
    const out = computeMobileV2TaskKpiCounts([makeTask({ urgency: "now" })]);
    expect(out).toEqual({ now: 1, today: 0, later: 0, all: 1 });
  });

  test("buckets tasks by urgency", () => {
    const tasks: ReadonlyArray<MobileV2Task> = [
      makeTask({ id: "1", urgency: "now" }),
      makeTask({ id: "2", urgency: "now" }),
      makeTask({ id: "3", urgency: "today" }),
      makeTask({ id: "4", urgency: "later" }),
      makeTask({ id: "5", urgency: "later" }),
      makeTask({ id: "6", urgency: "later" }),
    ];
    const out = computeMobileV2TaskKpiCounts(tasks);
    expect(out).toEqual({ now: 2, today: 1, later: 3, all: 6 });
  });

  test("treats unknown urgency strings as Later when constructed directly", () => {
    // Direct construction bypasses parser validation — the counter must
    // still keep its 3-bucket invariant rather than crashing on novel
    // values. Anything not "now" / "today" is bucketed into Later.
    const tasks: ReadonlyArray<MobileV2Task> = [
      makeTask({ urgency: "weird-value" as MobileV2Task["urgency"] }),
    ];
    const out = computeMobileV2TaskKpiCounts(tasks);
    expect(out).toEqual({ now: 0, today: 0, later: 1, all: 1 });
  });

  test("parser silently drops unknown urgency strings (regression guard)", () => {
    // parseMobileV2TaskList is stricter than computeMobileV2TaskKpiCounts —
    // it rejects rows whose urgency is not one of the canonical three. This
    // test pins that behavior so we notice if the parser becomes lenient.
    const parsed = parseMobileV2TaskList([
      {
        id: "tsk-x",
        type: "delivery",
        title: "Unknown urgency task",
        urgency: "weird-value",
        cta: "Start",
        tone: "danger",
        eta_iso: null,
        priority: 0,
      },
    ]);
    expect(parsed).toHaveLength(0);
  });

  test("`all` equals sum of buckets", () => {
    const tasks: ReadonlyArray<MobileV2Task> = [
      makeTask({ id: "a", urgency: "now" }),
      makeTask({ id: "b", urgency: "today" }),
      makeTask({ id: "c", urgency: "later" }),
    ];
    const out: MobileV2TaskKpiCounts = computeMobileV2TaskKpiCounts(tasks);
    expect(out.all).toBe(out.now + out.today + out.later);
  });
});
