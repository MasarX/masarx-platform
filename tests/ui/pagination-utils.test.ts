import { resolvePaginationDisplay, resolvePaginationSettings } from "../../packages/ui/src/pagination-utils";

describe("pagination display counts", () => {
  test.each([
    [1, 0, 4, { total: 4, start: 1, end: 4 }],
    [1, 50, 4, { total: 54, start: 51, end: 54 }],
    [100, 0, 4, { total: 100, start: 1, end: 4 }],
    [0, 0, 4, { total: 4, start: 1, end: 4 }],
    [1, 50, 0, { total: 1, start: 0, end: 0 }],
    [0, 50, 0, { total: 0, start: 0, end: 0 }],
  ])("keeps estimated totals consistent with observed rows (%s, %s, %s)", (total, offset, itemsCount, expected) => {
    expect(resolvePaginationDisplay({ total, totalIsEstimate: true, offset, itemsCount })).toEqual(expected);
  });

  test.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1])("does not invent a total when it is unknown (%s)", (total) => {
    expect(resolvePaginationDisplay({ total, totalIsEstimate: true, offset: 50, itemsCount: 4 }))
      .toEqual({ total: null, start: 51, end: 54 });
  });

  test("exact ranges describe returned rows rather than the requested page size", () => {
    expect(resolvePaginationDisplay({ total: 100, totalIsEstimate: false, offset: 25, itemsCount: 4 }))
      .toEqual({ total: 100, start: 26, end: 29 });
  });
});

test("resolvePaginationSettings returns defaults", () => {
  const settings = resolvePaginationSettings(null);

  expect(settings.maxPageSize).toBe(200);
  expect(settings.allowedSizes).toEqual([10, 25, 50, 100, 200]);
  expect(settings.defaultPageSize).toBe(25);
  expect(settings.clientMaxRows).toBe(200);
  expect(settings.clientAllowedSizes).toEqual([10, 25, 50, 100, 200]);
  expect(settings.clientDefaultPageSize).toBe(25);
});

test("resolvePaginationSettings normalizes client settings", () => {
  const settings = resolvePaginationSettings({
    max_page_size: 50,
    allowed_sizes: [5, 10, 60, "20"],
    default_page_size: 60,
    client_max_rows: 30,
    client_allowed_sizes: [5, 25, 40],
    client_default_page_size: 40,
  });

  expect(settings.maxPageSize).toBe(50);
  expect(settings.allowedSizes).toEqual([5, 10, 20]);
  expect(settings.defaultPageSize).toBe(5);
  expect(settings.clientMaxRows).toBe(30);
  expect(settings.clientAllowedSizes).toEqual([5, 25]);
  expect(settings.clientDefaultPageSize).toBe(5);
});
