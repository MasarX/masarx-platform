import { act, render, screen, waitFor } from "@testing-library/react";
import { ResourcePageSplitLayout } from "../../packages/ui/src/resource-page-split-layout";

describe("ResourcePageSplitLayout", () => {
  const originalInnerWidth = window.innerWidth;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: originalInnerWidth,
    });
  });

  it("renders table content when not enabled", () => {
    render(
      <ResourcePageSplitLayout
        enabled={false}
        storageKey="test:key"
        table={<div>Table</div>}
        detail={<div>Detail</div>}
        testIdPrefix="console-resource"
      />
    );

    expect(screen.getByText("Table")).toBeInTheDocument();
    expect(screen.getByText("Detail")).toBeInTheDocument();
    expect(screen.queryByTestId("console-resource-detail-resizer")).toBeNull();
  });

  it("hydrates detail width from local storage and exposes a resizer handle", async () => {
    window.localStorage.setItem("test:key", "520");

    render(
      <ResourcePageSplitLayout
        enabled
        storageKey="test:key"
        table={<div>Table</div>}
        detail={<div>Detail</div>}
        testIdPrefix="console-resource"
      />
    );

    expect(screen.getByText("Table")).toBeInTheDocument();
    expect(screen.getByText("Detail")).toBeInTheDocument();

    const container = screen.getByTestId(
      "console-resource-detail-panel-container"
    );
    const resizer = screen.getByTestId("console-resource-detail-resizer");

    expect(resizer).toBeInTheDocument();

    await waitFor(() => {
      expect(container).toHaveStyle("--ui-detail-panel-width: 520px");
    });
  });

  it("uses responsive auto width when no stored preference exists", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1400,
    });

    render(
      <ResourcePageSplitLayout
        enabled
        storageKey="test:key"
        table={<div>Table</div>}
        detail={<div>Detail</div>}
        testIdPrefix="console-resource"
      />
    );

    const container = screen.getByTestId(
      "console-resource-detail-panel-container"
    );

    await waitFor(() => {
      expect(container).toHaveStyle("--ui-detail-panel-width: 504px");
    });

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1000,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(container).toHaveStyle("--ui-detail-panel-width: 360px");
    });
  });

  it("keeps stored widths and clamps them on smaller viewports", async () => {
    window.localStorage.setItem("test:key", "700");
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 1000,
    });

    render(
      <ResourcePageSplitLayout
        enabled
        storageKey="test:key"
        table={<div>Table</div>}
        detail={<div>Detail</div>}
        testIdPrefix="console-resource"
      />
    );

    const container = screen.getByTestId(
      "console-resource-detail-panel-container"
    );

    await waitFor(() => {
      expect(container).toHaveStyle("--ui-detail-panel-width: 700px");
    });

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: 800,
    });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(container).toHaveStyle("--ui-detail-panel-width: 560px");
    });
  });
});
