import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it.each([["ltr", "mouse"], ["rtl", "mouse"], ["ltr", "pointer"], ["rtl", "pointer"]])(
    "resizes from the shared edge in %s with %s and keyboard", async (direction, mode) => {
    window.localStorage.setItem("test:key", "440");
    render(
      <ResourcePageSplitLayout enabled storageKey="test:key" table={<div>Table</div>}
        detail={<div>Detail</div>} testIdPrefix="console-resource" />
    );
    const panel = screen.getByTestId("console-resource-detail-panel-container");
    const container = panel.parentElement!;
    container.style.direction = direction;
    container.getBoundingClientRect = () => ({ left: 100, right: 1100, width: 1000 }) as DOMRect;
    const resizer = screen.getByTestId("console-resource-detail-resizer");
    expect(resizer).toHaveStyle("inset-inline-start: -0.75rem");
    await waitFor(() => expect(panel).toHaveStyle("--ui-detail-panel-width: 440px"));
    const clientX = direction === "rtl" ? 660 : 540;
    if (mode === "mouse") {
      fireEvent.mouseDown(resizer, { button: 0 });
      fireEvent.mouseMove(window, { clientX });
      fireEvent.mouseUp(window);
    } else {
      resizer.setPointerCapture = jest.fn();
      fireEvent(resizer, Object.assign(new Event("pointerdown", { bubbles: true }),
        { button: 0, pointerType: "touch", pointerId: 1 }));
      fireEvent(resizer, Object.assign(new Event("pointermove", { bubbles: true }),
        { clientX, pointerId: 2 }));
      expect(panel).toHaveStyle("--ui-detail-panel-width: 440px");
      fireEvent(resizer, Object.assign(new Event("pointermove", { bubbles: true }),
        { clientX, pointerId: 1 }));
      fireEvent(resizer, Object.assign(new Event("pointerup", { bubbles: true }), { pointerId: 1 }));
    }
    expect(panel).toHaveStyle("--ui-detail-panel-width: 560px");
    expect(window.localStorage.getItem("test:key")).toBe("560");
    fireEvent.keyDown(resizer, { key: direction === "rtl" ? "ArrowRight" : "ArrowLeft" });
    expect(panel).toHaveStyle("--ui-detail-panel-width: 584px");
    fireEvent.keyDown(resizer, { key: direction === "rtl" ? "ArrowLeft" : "ArrowRight" });
    expect(panel).toHaveStyle("--ui-detail-panel-width: 560px");
    fireEvent.keyDown(resizer, { key: "Home" });
    expect(panel).toHaveStyle("--ui-detail-panel-width: 440px");
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
