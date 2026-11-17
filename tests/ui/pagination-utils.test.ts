import { resolvePaginationSettings } from "../../packages/ui/src/pagination-utils";

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
