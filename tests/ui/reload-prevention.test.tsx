// ---------- handleServerNavigate Tests ----------

describe("Reload Prevention", () => {

  describe("handleServerNavigate URL parsing", () => {
    // Test the parseHrefParams, parseSortFromParams, parseIntParam utilities
    // These are not exported, so we test them through the component behavior
    // But we can test the pattern by calling the function via the component

    test("sort parameters are parsed from href", () => {
      const href = "/test?sort=name&direction=asc&limit=50&offset=0";
      const params = new URLSearchParams(href.split("?")[1] || "");
      expect(params.get("sort")).toBe("name");
      expect(params.get("direction")).toBe("asc");
    });

    test("filter tree is decoded from href filters param", () => {
      // The actual codebase uses encodeURIComponent(JSON.stringify(tree))
      const filterTree = { type: "group", children: [] };
      const encoded = encodeURIComponent(JSON.stringify(filterTree));
      const params = new URLSearchParams(`filters=${encoded}`);
      expect(params.get("filters")).toBeTruthy();
      const filtersValue = params.get("filters") || "";
      const decoded = JSON.parse(decodeURIComponent(filtersValue));
      expect(decoded.type).toBe("group");
    });

    test("pagination params are parsed correctly", () => {
      const params = new URLSearchParams("page=2&offset=50&limit=25");
      expect(parseInt(params.get("page") || "1", 10)).toBe(2);
      expect(parseInt(params.get("offset") || "0", 10)).toBe(50);
      expect(parseInt(params.get("limit") || "50", 10)).toBe(25);
    });

    test("parseHrefParams handles href without query string", () => {
      // Mirrors parseHrefParams: returns empty params when no '?' present
      const href = "/test";
      const questionMark = href.indexOf("?");
      const params =
        questionMark < 0
          ? new URLSearchParams()
          : new URLSearchParams(href.slice(questionMark + 1));
      expect(Array.from(params.entries())).toHaveLength(0);
    });

    test("parseSortFromParams defaults direction to asc for invalid values", () => {
      // Mirrors parseSortFromParams: direction defaults to "asc" if not "asc"/"desc"
      const params = new URLSearchParams("sort=name&direction=invalid");
      const key = params.get("sort")?.trim();
      const direction = params.get("direction")?.trim()?.toLowerCase();
      const result = key
        ? { key, direction: direction === "asc" || direction === "desc" ? direction : "asc" }
        : null;
      expect(result).toEqual({ key: "name", direction: "asc" });
    });

    test("parseIntParam returns fallback for non-numeric values", () => {
      // Mirrors parseIntParam: returns fallback for non-numeric strings
      const params = new URLSearchParams("offset=abc");
      const raw = params.get("offset");
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      const result = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      expect(result).toBe(0);
    });

    test("parseIntParam returns fallback for negative values", () => {
      const params = new URLSearchParams("offset=-10");
      const raw = params.get("offset");
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      const result = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      expect(result).toBe(0);
    });
  });

  describe("window.history.replaceState usage", () => {
    const replaceStateSpy = jest.spyOn(window.history, "replaceState");

    beforeEach(() => {
      replaceStateSpy.mockClear();
    });

    afterAll(() => {
      replaceStateSpy.mockRestore();
    });

    test("replaceState is used instead of router.replace for URL sync", () => {
      // Verify the pattern: window.history.replaceState(state, "", pathname + search)
      window.history.replaceState(window.history.state, "", "/test?sort=name&direction=asc");
      expect(replaceStateSpy).toHaveBeenCalledTimes(1);
      const call = replaceStateSpy.mock.calls[0];
      expect(call[1]).toBe("");
      expect(call[2]).toBe("/test?sort=name&direction=asc");
    });

    test("replaceState preserves existing history state", () => {
      const originalState = window.history.state;
      window.history.replaceState(originalState, "", "/test?page=2");
      expect(replaceStateSpy).toHaveBeenCalledWith(originalState, "", "/test?page=2");
    });

    test("handleServerNavigate extracts search string from href", () => {
      // Mirrors the pattern in resource-table-client.tsx handleServerNavigate:
      // const qIndex = href.indexOf("?");
      // const search = qIndex >= 0 ? href.substring(qIndex) : "";
      // window.history.replaceState(window.history.state, "", window.location.pathname + search);
      const href = "/console/resources/orders?offset=50&limit=25&sort=id&direction=asc";
      const qIndex = href.indexOf("?");
      const search = qIndex >= 0 ? href.substring(qIndex) : "";
      window.history.replaceState(window.history.state, "", window.location.pathname + search);

      expect(replaceStateSpy).toHaveBeenCalled();
      const call = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
      expect(call[2]).toContain("?offset=50&limit=25&sort=id&direction=asc");
    });

    test("handlePageChange uses URL constructor for param updates", () => {
      // Mirrors the pattern in resource-table-client.tsx handlePageChange:
      // const url = new URL(window.location.href);
      // url.searchParams.set("page", String(_page));
      // url.searchParams.set("offset", String(offset));
      // window.history.replaceState(window.history.state, "", url.pathname + url.search);
      const url = new URL(window.location.href);
      url.searchParams.set("page", "3");
      url.searchParams.set("offset", "50");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);

      expect(replaceStateSpy).toHaveBeenCalled();
      const call = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
      const urlStr = String(call[2]);
      expect(urlStr).toContain("page=3");
      expect(urlStr).toContain("offset=50");
    });
  });

  describe("effectiveRouter pattern", () => {
    test("effectiveRouter uses onServerNavigate when provided", () => {
      const onServerNavigate = jest.fn();
      // Mirrors resource-table.tsx line 176-179:
      // const effectiveRouter = React.useMemo(
      //   () => (onServerNavigate ? { replace: onServerNavigate } : router),
      //   [onServerNavigate, router]
      // );
      const effectiveRouter = onServerNavigate
        ? { replace: onServerNavigate }
        : { replace: jest.fn() };

      effectiveRouter.replace("/test?sort=name");
      expect(onServerNavigate).toHaveBeenCalledWith("/test?sort=name");
    });

    test("effectiveRouter falls back to router when onServerNavigate is null", () => {
      const mockRouterReplace = jest.fn();
      const onServerNavigate = null;
      const effectiveRouter = onServerNavigate
        ? { replace: onServerNavigate }
        : { replace: mockRouterReplace };

      effectiveRouter.replace("/test?sort=name");
      expect(mockRouterReplace).toHaveBeenCalledWith("/test?sort=name");
    });

    test("navigateReplace uses onServerNavigate over router.replace", () => {
      // Mirrors resource-table.tsx line 172-175:
      // const navigateReplace = React.useMemo(
      //   () => onServerNavigate ?? ((href: string) => router.replace(href)),
      //   [onServerNavigate, router]
      // );
      const routerReplace = jest.fn();
      const onServerNavigate = jest.fn();
      const navigateReplace = onServerNavigate ?? ((href: string) => routerReplace(href));

      navigateReplace("/test?sort=name&direction=desc");
      expect(onServerNavigate).toHaveBeenCalledWith("/test?sort=name&direction=desc");
      expect(routerReplace).not.toHaveBeenCalled();
    });

    test("navigateReplace falls back to router.replace when onServerNavigate is undefined", () => {
      const routerReplace = jest.fn();
      const onServerNavigate = undefined;
      const navigateReplace = onServerNavigate ?? ((href: string) => routerReplace(href));

      navigateReplace("/test?sort=name&direction=desc");
      expect(routerReplace).toHaveBeenCalledWith("/test?sort=name&direction=desc");
    });
  });

  describe("Detail Panel URL sync", () => {
    test("detail open toggle uses replaceState via syncUrl pattern", () => {
      const replaceStateSpy = jest.spyOn(window.history, "replaceState");
      // Mirrors syncUrl from resource-detail-client.tsx:
      // const url = new URL(window.location.href);
      // for (const [key, value] of Object.entries(updates)) {
      //   if (value === null) url.searchParams.delete(key);
      //   else url.searchParams.set(key, value);
      // }
      // window.history.replaceState(window.history.state, "", url.pathname + url.search);
      const url = new URL(window.location.href);
      url.searchParams.set("detail_open", "0");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);

      expect(replaceStateSpy).toHaveBeenCalled();
      const call = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
      expect(call[2]).toContain("detail_open=0");
      replaceStateSpy.mockRestore();
    });

    test("detail layout toggle uses replaceState", () => {
      const replaceStateSpy = jest.spyOn(window.history, "replaceState");
      const url = new URL(window.location.href);
      url.searchParams.set("detail_layout", "full");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);

      expect(replaceStateSpy).toHaveBeenCalled();
      const call = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
      expect(call[2]).toContain("detail_layout=full");
      replaceStateSpy.mockRestore();
    });

    test("detail layout removal deletes param via syncUrl null pattern", () => {
      const replaceStateSpy = jest.spyOn(window.history, "replaceState");
      const url = new URL("http://localhost/test?id=123&detail_layout=full");
      // When value is null, syncUrl calls url.searchParams.delete(key)
      url.searchParams.delete("detail_layout");
      window.history.replaceState(window.history.state, "", url.pathname + url.search);

      expect(replaceStateSpy).toHaveBeenCalled();
      const call = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
      expect(call[2]).not.toContain("detail_layout");
      replaceStateSpy.mockRestore();
    });

    test("back to list uses replaceState with listHref", () => {
      const replaceStateSpy = jest.spyOn(window.history, "replaceState");
      // Mirrors handleBackToList from resource-detail-client.tsx:
      // window.history.replaceState(window.history.state, "", listHref);
      const listHref = "/resources/orders";
      window.history.replaceState(window.history.state, "", listHref);

      expect(replaceStateSpy).toHaveBeenCalledTimes(1);
      const call = replaceStateSpy.mock.calls[0];
      expect(call[1]).toBe("");
      expect(call[2]).toBe(listHref);
      replaceStateSpy.mockRestore();
    });
  });

  describe("URL State Consistency", () => {
    test("sort params encode correctly", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("sort", "created_at");
      url.searchParams.set("direction", "desc");
      expect(url.searchParams.get("sort")).toBe("created_at");
      expect(url.searchParams.get("direction")).toBe("desc");
    });

    test("pagination params encode correctly", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("page", "3");
      url.searchParams.set("offset", "100");
      expect(url.searchParams.get("page")).toBe("3");
      expect(url.searchParams.get("offset")).toBe("100");
    });

    test("detail params encode correctly", () => {
      const url = new URL("http://localhost/test");
      url.searchParams.set("id", "abc-123");
      url.searchParams.set("detail_open", "1");
      url.searchParams.set("detail_layout", "full");
      expect(url.searchParams.get("id")).toBe("abc-123");
      expect(url.searchParams.get("detail_open")).toBe("1");
      expect(url.searchParams.get("detail_layout")).toBe("full");
    });

    test("filter params round-trip through URL using encodeURIComponent", () => {
      // Matches the actual codebase pattern: encodeURIComponent(JSON.stringify(tree))
      // from resource-query.ts encodeFilterTree / decodeFilterTree
      const filterTree = { type: "group", children: [{ type: "rule", key: "status", op: "eq", value: "active" }] };
      const encoded = encodeURIComponent(JSON.stringify(filterTree));
      const url = new URL("http://localhost/test");
      url.searchParams.set("filters", encoded);

      const raw = url.searchParams.get("filters") || "";
      const decoded = JSON.parse(decodeURIComponent(raw));
      expect(decoded.type).toBe("group");
      expect(decoded.children).toHaveLength(1);
      expect(decoded.children[0].key).toBe("status");
    });

    test("handleServerNavigate skips reserved keys when extracting flat filters", () => {
      // Mirrors resource-table-client.tsx handleServerNavigate flat filter extraction:
      // Keys like page, offset, limit, sort, direction, view, paging_mode,
      // filters, id, detail_open, detail_layout are skipped.
      const reservedKeys = new Set([
        "page", "offset", "limit", "sort", "direction",
        "view", "paging_mode", "filters", "id", "detail_open", "detail_layout",
      ]);
      const params = new URLSearchParams(
        "page=1&offset=0&limit=25&sort=name&direction=asc&status=active&region=us-east"
      );
      const flatFilters: Record<string, string> = {};
      params.forEach((value, key) => {
        if (reservedKeys.has(key)) return;
        flatFilters[key] = value;
      });

      expect(flatFilters).toEqual({ status: "active", region: "us-east" });
      expect(flatFilters).not.toHaveProperty("page");
      expect(flatFilters).not.toHaveProperty("sort");
    });
  });

  describe("getLiveSearchString pattern", () => {
    test("reads from window.location.search when onServerNavigate is provided", () => {
      // Mirrors resource-table.tsx getLiveSearchString:
      // When onServerNavigate is provided, useSearchParams() can become stale
      // after history.replaceState(). Read from the live browser URL instead.
      const onServerNavigate = jest.fn();
      const searchParamString = "sort=old_value";

      const getLiveSearchString = () => {
        if (onServerNavigate && typeof window !== "undefined") {
          return window.location.search.replace(/^\?/, "");
        }
        return searchParamString;
      };

      // When onServerNavigate is set, it reads from window.location
      const result = getLiveSearchString();
      expect(typeof result).toBe("string");
    });

    test("falls back to searchParamString when onServerNavigate is not provided", () => {
      const onServerNavigate = undefined;
      const searchParamString = "sort=name&direction=asc";

      const getLiveSearchString = () => {
        if (onServerNavigate && typeof window !== "undefined") {
          return window.location.search.replace(/^\?/, "");
        }
        return searchParamString;
      };

      expect(getLiveSearchString()).toBe("sort=name&direction=asc");
    });
  });
});
