import type { Page } from "@playwright/test";

jest.mock("@playwright/test", () => ({
  expect: Object.assign(
    jest.fn((locator: { isVisible: () => Promise<boolean> }) => ({
      toBeVisible: async () => {
        if (!(await locator.isVisible())) throw new Error("option not visible");
      },
    })),
    {
      poll: jest.fn((read: () => string) => ({
        toContain: async (value: string) => expect(read()).toContain(value),
        not: {
          toContain: async (value: string) => expect(read()).not.toContain(value),
        },
      })),
    },
  ),
}));

import { applyAndClearFirstFilter } from "../e2e/utils/table-actions";

function filterHarness(options: {
  autocomplete?: boolean;
  matchingOption?: boolean;
  single?: boolean;
  applyDisabled?: boolean;
} = {}) {
  const prefix = "console-resource-table";
  const sample = "ready";
  let query = "";
  let selected = "";
  let open = false;
  let url = "https://example.test/resources/shipments";
  const field = {
    count: jest.fn(async () => 1),
    first: () => field,
    selectOption: jest.fn(async () => undefined),
  };
  const input = {
    count: jest.fn(async () => options.autocomplete ? 0 : 1),
    first: () => input,
    fill: jest.fn(async (value: string) => { selected = value; }),
  };
  const searchbox = {
    fill: jest.fn(async (value: string) => { query = value; }),
    isVisible: jest.fn(async () => open),
    press: jest.fn(async () => { open = false; }),
  };
  const option = {
    isVisible: jest.fn(async () => options.matchingOption !== false && query === sample),
    click: jest.fn(async () => {
      selected = sample;
      if (options.single) open = false;
    }),
  };
  const optionContainer = {
    getByRole: jest.fn((role: string, match: { name: string; exact: boolean }) => {
      if (role !== "option" || match.name !== sample || !match.exact) {
        throw new Error("Expected the exact authenticated sample option");
      }
      return option;
    }),
  };
  const combobox = {
    count: jest.fn(async () => options.autocomplete ? 1 : 0),
    first: () => combobox,
    click: jest.fn(async () => { open = true; }),
    getByRole: jest.fn((role: string) => {
      if (role !== "searchbox") throw new Error(`Unexpected role: ${role}`);
      return searchbox;
    }),
    locator: jest.fn((selector: string) => {
      if (selector !== "..") throw new Error(`Unexpected selector: ${selector}`);
      return optionContainer;
    }),
  };
  const apply = {
    count: jest.fn(async () => 1),
    first: () => apply,
    isDisabled: jest.fn(async () => options.applyDisabled === true || !selected),
    click: jest.fn(async () => { url += `?filters=${selected}`; }),
  };
  const clear = {
    count: jest.fn(async () => 1),
    first: () => clear,
    click: jest.fn(async () => { url = url.split("?")[0]; }),
  };
  const children = new Map<string, unknown>([
    [`[data-testid="${prefix}-filter-field"]`, field],
    [`[data-testid="${prefix}-filter-value"]`, input],
    [`[data-testid="${prefix}-filter-apply"]`, apply],
    [`[data-testid="${prefix}-filter-clear"]`, clear],
    ['[role="combobox"]', combobox],
  ]);
  const builder = {
    count: jest.fn(async () => 1),
    locator: jest.fn((selector: string) => {
      if (!children.has(selector)) throw new Error(`Unexpected selector: ${selector}`);
      return children.get(selector);
    }),
  };
  const page = {
    locator: jest.fn((selector: string) => {
      if (selector !== `[data-testid="${prefix}-filter-builder"]`) {
        throw new Error(`Unexpected page selector: ${selector}`);
      }
      return builder;
    }),
    url: () => url,
  } as unknown as Page;
  return { page, prefix, sample, field, input, combobox, searchbox, option, optionContainer, apply, clear };
}

describe("applyAndClearFirstFilter", () => {
  it("keeps the plain-input apply and clear path", async () => {
    const h = filterHarness();
    expect(await applyAndClearFirstFilter({
      page: h.page, testIdPrefix: h.prefix, filterKey: "status", filterValue: h.sample,
    })).toBe(true);
    expect(h.field.selectOption).toHaveBeenCalledWith("status");
    expect(h.input.fill).toHaveBeenCalledWith(h.sample);
    expect(h.combobox.click).not.toHaveBeenCalled();
    expect(h.apply.click).toHaveBeenCalledTimes(1);
    expect(h.clear.click).toHaveBeenCalledTimes(1);
    expect(h.page.url()).not.toContain("filters=");
  });

  it.each([false, true])("selects the exact scoped autocomplete sample (single=%s)", async (single) => {
    const h = filterHarness({ autocomplete: true, single });
    expect(await applyAndClearFirstFilter({
      page: h.page, testIdPrefix: h.prefix, filterKey: "status", filterValue: h.sample,
    })).toBe(true);
    expect(h.input.fill).not.toHaveBeenCalled();
    expect(h.combobox.click).toHaveBeenCalledTimes(1);
    expect(h.searchbox.fill).toHaveBeenCalledWith(h.sample);
    expect(h.optionContainer.getByRole).toHaveBeenCalledWith("option", { name: h.sample, exact: true });
    expect(h.option.click).toHaveBeenCalledTimes(1);
    expect(h.searchbox.press).toHaveBeenCalledTimes(single ? 0 : 1);
    if (!single) expect(h.searchbox.press).toHaveBeenCalledWith("Escape");
    expect(h.apply.click).toHaveBeenCalledTimes(1);
    expect(h.clear.click).toHaveBeenCalledTimes(1);
  });

  it("does not substitute another option when the authenticated sample is missing", async () => {
    const h = filterHarness({ autocomplete: true, matchingOption: false });
    await expect(applyAndClearFirstFilter({
      page: h.page, testIdPrefix: h.prefix, filterKey: "status", filterValue: h.sample,
    })).rejects.toThrow("option not visible");
    expect(h.option.click).not.toHaveBeenCalled();
    expect(h.apply.click).not.toHaveBeenCalled();
    expect(h.clear.click).not.toHaveBeenCalled();
  });

  it("preserves the original autocomplete visibility failure", async () => {
    const h = filterHarness({ autocomplete: true });
    const failure = new Error("locator visibility failed");
    h.option.isVisible.mockRejectedValueOnce(failure);
    await expect(applyAndClearFirstFilter({
      page: h.page, testIdPrefix: h.prefix, filterKey: "status", filterValue: h.sample,
    })).rejects.toBe(failure);
    expect(h.option.click).not.toHaveBeenCalled();
    expect(h.apply.click).not.toHaveBeenCalled();
  });

  describe.each([false, true])("autocomplete=%s", (autocomplete) => {
    it.each([null, undefined, ""])("does not invent a missing sample (%s)", async (filterValue) => {
      const h = filterHarness({ autocomplete });
      expect(await applyAndClearFirstFilter({
        page: h.page, testIdPrefix: h.prefix, filterKey: "status", filterValue,
      })).toBe(false);
      expect(h.input.fill).not.toHaveBeenCalled();
      expect(h.combobox.click).not.toHaveBeenCalled();
      expect(h.apply.click).not.toHaveBeenCalled();
    });

    it("keeps a disabled Apply as an optional false result", async () => {
      const h = filterHarness({ autocomplete, applyDisabled: true });
      expect(await applyAndClearFirstFilter({
        page: h.page, testIdPrefix: h.prefix, filterKey: "status", filterValue: h.sample,
      })).toBe(false);
      expect(h.apply.click).not.toHaveBeenCalled();
      expect(h.clear.click).not.toHaveBeenCalled();
      expect(h.page.url()).not.toContain("filters=");
    });
  });
});
