import {
  buildRowHrefForDetailOpenMode,
  normalizeDetailOpenMode,
} from "../../packages/ui/src/table/open-mode";
import { buildViewPayload } from "../../packages/ui/src/table/table-views";

describe("detail open mode", () => {
  test("normalizeDetailOpenMode defaults to peek", () => {
    expect(normalizeDetailOpenMode(null)).toBe("peek");
    expect(normalizeDetailOpenMode(undefined)).toBe("peek");
    expect(normalizeDetailOpenMode("peek")).toBe("peek");
    expect(normalizeDetailOpenMode("anything-else")).toBe("peek");
  });

  test("normalizeDetailOpenMode returns full when configured", () => {
    expect(normalizeDetailOpenMode("full")).toBe("full");
  });

  test("buildRowHrefForDetailOpenMode returns null without baseHref", () => {
    expect(
      buildRowHrefForDetailOpenMode({
        baseHref: null,
        searchParamString: "",
        rowId: "123",
        openMode: "peek",
      })
    ).toBeNull();
  });

  test("peek mode sets id, opens detail, and strips detail_layout", () => {
    const href = buildRowHrefForDetailOpenMode({
      baseHref: "/resources/shipments",
      searchParamString: "detail_layout=full&detail_open=0&foo=bar",
      rowId: "123",
      openMode: "peek",
    });
    expect(href).not.toBeNull();

    const url = new URL(href as string, "https://example.com");
    expect(url.pathname).toBe("/resources/shipments");
    expect(url.searchParams.get("id")).toBe("123");
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("detail_open")).toBe("1");
    expect(url.searchParams.has("detail_layout")).toBe(false);
  });

  test("full mode sets detail_layout=full and removes detail_open", () => {
    const href = buildRowHrefForDetailOpenMode({
      baseHref: "/resources/shipments",
      searchParamString: "detail_open=0&foo=bar",
      rowId: "123",
      openMode: "full",
    });
    expect(href).not.toBeNull();

    const url = new URL(href as string, "https://example.com");
    expect(url.pathname).toBe("/resources/shipments");
    expect(url.searchParams.get("id")).toBe("123");
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("detail_layout")).toBe("full");
    expect(url.searchParams.has("detail_open")).toBe(false);
  });

  test("path mode uses canonical detail path for mapped resources", () => {
    const href = buildRowHrefForDetailOpenMode({
      baseHref: "/portal/resources/workflow_runs",
      searchParamString: "foo=bar&detail_open=1",
      rowId: "run-1",
      openMode: "peek",
      resourceKey: "workflow_runs",
    });
    expect(href).toBe("/portal/resources/workflow_runs/run-1");
  });

  test("manual review task path mode is scoped to queue base path", () => {
    expect(
      buildRowHrefForDetailOpenMode({
        baseHref: "/console/workflows/queue",
        searchParamString: "foo=bar&detail_open=1",
        rowId: "task-1",
        openMode: "full",
        resourceKey: "manual_review_tasks",
      })
    ).toBe("/console/workflows/queue/task-1");

    expect(
      buildRowHrefForDetailOpenMode({
        baseHref: "/console/workflows/tasks",
        searchParamString: "foo=bar&detail_open=1",
        rowId: "task-1",
        openMode: "peek",
        resourceKey: "manual_review_tasks",
      })
    ).toBe("/console/workflows/tasks?foo=bar&detail_open=1&id=task-1");
  });

  test("unknown resources keep query detail navigation", () => {
    const href = buildRowHrefForDetailOpenMode({
      baseHref: "/resources/shipments",
      searchParamString: "foo=bar",
      rowId: "123",
      openMode: "peek",
      resourceKey: "shipments",
    });
    expect(href).not.toBeNull();
    const url = new URL(href as string, "https://example.com");
    expect(url.pathname).toBe("/resources/shipments");
    expect(url.searchParams.get("foo")).toBe("bar");
    expect(url.searchParams.get("id")).toBe("123");
    expect(url.searchParams.get("detail_open")).toBe("1");
  });

  test("buildViewPayload persists open_mode as a view-level setting", () => {
    const payload = buildViewPayload({
      viewId: "current",
      label: "Current",
      columnOrder: ["id", "name"],
      visibleColumns: new Set(["id", "name"]),
      pinnedColumns: [],
      columnWidths: {},
      rowDensity: "compact",
      openMode: "full",
      showInternalIdHints: false,
      analyticsEnabled: true,
      activeFilters: null,
      sortState: [],
      resolvedGroupBy: [],
      pageSize: null,
      paginationMode: "server",
      searchDebounceMs: 0,
    });

    expect(payload.open_mode).toBe("full");
    expect(payload.show_internal_id_hints).toBe(false);
  });
});
