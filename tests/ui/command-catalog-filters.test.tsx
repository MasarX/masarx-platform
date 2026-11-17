import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl } from "./test-utils";
import { CommandCatalogFilters } from "../../packages/ui/src/command-catalog-filters";

let pathname = "/commands";
const replaceState = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams()
}));

const originalReplaceState = window.history.replaceState;

const categories = [
  { value: "resource:shipments", label: "resource:shipments" }
];
const capabilities = [
  { value: "shipments.read", label: "shipments.read" }
];

beforeEach(() => {
  replaceState.mockClear();
  pathname = "/commands";
  window.history.replaceState = replaceState;
  jest.useFakeTimers();
});

afterEach(() => {
  window.history.replaceState = originalReplaceState;
  jest.useRealTimers();
});

test("command catalog search updates query", async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  renderWithIntl(
    <CommandCatalogFilters
      query=""
      category=""
      capability=""
      access=""
      categories={categories}
      capabilities={capabilities}
    />
  );

  await user.type(screen.getByLabelText("Search commands"), "ship");
  jest.advanceTimersByTime(250);

  expect(replaceState).toHaveBeenCalledWith(
    null,
    "",
    "/commands?q=ship"
  );
});

test("command catalog search avoids redundant replace when query matches", () => {
  renderWithIntl(
    <CommandCatalogFilters
      query="ship"
      category=""
      capability=""
      access=""
      categories={categories}
      capabilities={capabilities}
    />
  );

  jest.advanceTimersByTime(250);
  expect(replaceState).not.toHaveBeenCalled();
});

test("command catalog category filter updates query", async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  renderWithIntl(
    <CommandCatalogFilters
      query=""
      category=""
      capability=""
      access=""
      categories={categories}
      capabilities={capabilities}
    />
  );

  await user.selectOptions(screen.getByLabelText("Category"), "resource:shipments");

  expect(replaceState).toHaveBeenCalledWith(
    null,
    "",
    "/commands?category=resource%3Ashipments"
  );
});

test("command catalog strips app base path from filters", async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  pathname = "/portal/commands";

  renderWithIntl(
    <CommandCatalogFilters
      query=""
      category=""
      capability=""
      access=""
      categories={categories}
      capabilities={capabilities}
      appBasePath="/portal"
    />
  );

  await user.selectOptions(screen.getByLabelText("Category"), "resource:shipments");

  expect(replaceState).toHaveBeenCalledWith(
    null,
    "",
    "/commands?category=resource%3Ashipments"
  );
});

test("command catalog does not strip unsafe app base path from filters", async () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  pathname = "/portal/commands";

  renderWithIntl(
    <CommandCatalogFilters
      query=""
      category=""
      capability=""
      access=""
      categories={categories}
      capabilities={capabilities}
      appBasePath="javascript:alert(1)"
    />
  );

  await user.selectOptions(screen.getByLabelText("Category"), "resource:shipments");

  expect(replaceState).toHaveBeenCalledWith(
    null,
    "",
    "/portal/commands?category=resource%3Ashipments"
  );
});
