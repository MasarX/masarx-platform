import { screen, act, fireEvent } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { ResourceDetailClient } from "../../packages/ui/src/resource-detail-client";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

jest.mock("../../packages/ui/src/resource-detail-panel", () => ({
  ResourceDetailPanel: ({ children, open, onClose }: any) =>
    open ? (
      <div data-testid="detail-panel">
        <button data-testid="close-btn" onClick={onClose}>
          Close
        </button>
        {children}
      </div>
    ) : null,
}));

jest.mock("../../packages/ui/src/resource-detail-navigation", () => ({
  ResourceDetailNavigation: (props: any) => (
    <div
      data-testid="detail-nav"
      data-prev={props.prevHref}
      data-next={props.nextHref}
    />
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const replaceStateSpy = jest
  .spyOn(window.history, "replaceState")
  .mockImplementation(() => {});

const defaultProps = {
  detailId: "rec_1",
  initialOpen: true,
  initialLayout: "peek" as const,
  detailTitle: "Test Record",
  detailBody: <div data-testid="detail-body">Detail content</div>,
  navigation: {
    prevHref: "/prev",
    nextHref: "/next",
    currentIndex: 2,
    totalCount: 10,
  },
  listHref: "/resources/items",
  table: <div data-testid="table">Table content</div>,
  splitLayoutStorageKey: "test:split",
  appBasePath: "/app",
  detailPreferenceResourceKey: "shipments",
  testIdPrefix: "test",
};

beforeEach(() => {
  replaceStateSpy.mockClear();
  window.localStorage.clear();
});

afterAll(() => {
  replaceStateSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("renders only table when detailId is null", () => {
  renderWithIntl(
    <ResourceDetailClient {...defaultProps} detailId={null} />
  );

  expect(screen.getByTestId("table")).toBeInTheDocument();
  expect(screen.queryByTestId("detail-body")).toBeNull();
  expect(screen.queryByTestId("detail-panel")).toBeNull();
});

test("renders detail panel when detailId and initialOpen", () => {
  renderWithIntl(
    <ResourceDetailClient {...defaultProps} detailId="rec_1" initialOpen initialLayout="peek" />
  );

  expect(screen.getByTestId("detail-panel")).toBeInTheDocument();
  expect(screen.getByTestId("detail-body")).toBeInTheDocument();
  expect(screen.getByTestId("table")).toBeInTheDocument();
});

test("toggles detail open state", () => {
  renderWithIntl(
    <ResourceDetailClient {...defaultProps} initialOpen initialLayout="peek" />
  );

  // Detail panel should be visible initially
  expect(screen.getByTestId("detail-panel")).toBeInTheDocument();

  // Click the close button (wired to handleToggleOpen via onClose)
  act(() => {
    fireEvent.click(screen.getByTestId("close-btn"));
  });

  // After toggle, detail panel should be closed
  expect(screen.queryByTestId("detail-panel")).toBeNull();

  // replaceState should have been called with detail_open=0
  expect(replaceStateSpy).toHaveBeenCalledWith(
    null,
    "",
    expect.stringContaining("detail_open=0")
  );
});

test("toggles layout between full and peek", () => {
  const modeListener = jest.fn((_event: Event) => undefined);
  window.addEventListener("masarx:detail-open-mode-change", modeListener as EventListener);
  renderWithIntl(
    <ResourceDetailClient {...defaultProps} initialOpen initialLayout="peek" />
  );

  // In peek layout, find the "Open full page" button and click it
  const fullBtn = screen.getByRole("button", { name: /Open full page/i });
  act(() => {
    fireEvent.click(fullBtn);
  });

  // Should have synced URL with detail_layout=full
  expect(replaceStateSpy).toHaveBeenCalledWith(
    null,
    "",
    expect.stringContaining("detail_layout=full")
  );
  expect(window.localStorage.getItem("detail-mode:shipments")).toBe("full");
  expect(modeListener).toHaveBeenCalled();

  // Now toggle back to peek: button text should now be "Open side peek"
  const peekBtn = screen.getByRole("button", { name: /Open side peek/i });
  act(() => {
    fireEvent.click(peekBtn);
  });

  // When switching to peek, detail_layout param is removed (set to null)
  const lastCall = replaceStateSpy.mock.calls[replaceStateSpy.mock.calls.length - 1];
  expect(lastCall[2]).not.toContain("detail_layout=full");
  expect(window.localStorage.getItem("detail-mode:shipments")).toBe("peek");
  window.removeEventListener(
    "masarx:detail-open-mode-change",
    modeListener as EventListener
  );
});

test("back to list replaces URL with listHref", () => {
  renderWithIntl(
    <ResourceDetailClient {...defaultProps} initialOpen initialLayout="peek" />
  );

  // Click the "Back to list" button
  const backBtn = screen.getByRole("button", { name: /Back to list/i });
  act(() => {
    fireEvent.click(backBtn);
  });

  // replaceState should have been called with the listHref
  expect(replaceStateSpy).toHaveBeenCalledWith(
    null,
    "",
    defaultProps.listHref
  );
});

test("syncs detailOpen from initialOpen prop changes", () => {
  const { rerender } = renderWithIntl(
    <ResourceDetailClient {...defaultProps} initialOpen={false} initialLayout="peek" />
  );

  // With initialOpen=false, the collapsed bar should show instead of the detail panel
  expect(screen.queryByTestId("detail-panel")).toBeNull();
  expect(screen.getByTestId("test-detail-hidden")).toBeInTheDocument();

  // Re-render with initialOpen=true to simulate prop change
  rerender(
    <ResourceDetailClient {...defaultProps} initialOpen initialLayout="peek" />
  );

  // The detail panel should now be visible via the useEffect sync
  expect(screen.getByTestId("detail-panel")).toBeInTheDocument();
});

test("renders navigation with prev/next hrefs", () => {
  renderWithIntl(
    <ResourceDetailClient
      {...defaultProps}
      initialOpen
      initialLayout="peek"
      navigation={{
        prevHref: "/items?detail_id=rec_0",
        nextHref: "/items?detail_id=rec_2",
        currentIndex: 1,
        totalCount: 5,
      }}
    />
  );

  const nav = screen.getByTestId("detail-nav");
  expect(nav).toBeInTheDocument();
  expect(nav).toHaveAttribute("data-prev", "/items?detail_id=rec_0");
  expect(nav).toHaveAttribute("data-next", "/items?detail_id=rec_2");
});
