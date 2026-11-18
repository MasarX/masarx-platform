import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HashTabs } from "../../packages/ui/src/hash-tabs";
import { TabsContent, TabsList, TabsTrigger } from "../../packages/ui/src/tabs";

function DemoTabs() {
  return (
    <HashTabs
      defaultValue="studio"
      hashToValue={{ foo: "overlaps" }}
      valueToHash={{ overlaps: "foo" }}
    >
      <TabsList>
        <TabsTrigger value="studio">Studio</TabsTrigger>
        <TabsTrigger value="runs">Runs</TabsTrigger>
        <TabsTrigger value="overlaps">Overlaps</TabsTrigger>
      </TabsList>
      <TabsContent value="studio">
        <div data-testid="demo-studio">Studio content</div>
      </TabsContent>
      <TabsContent value="runs">
        <div data-testid="demo-runs">Runs content</div>
      </TabsContent>
      <TabsContent value="overlaps">
        <div data-testid="demo-overlaps">Overlaps content</div>
      </TabsContent>
    </HashTabs>
  );
}

describe("HashTabs", () => {
  beforeEach(() => {
    window.location.hash = "";
    window.history.replaceState({}, "", "http://localhost/");
  });

  it("renders default tab when hash is empty", () => {
    render(<DemoTabs />);
    expect(screen.getByTestId("demo-studio")).toBeVisible();
    expect(screen.queryByTestId("demo-overlaps")).not.toBeInTheDocument();
  });

  it("selects mapped tab when hash matches", async () => {
    window.location.hash = "#foo";
    render(<DemoTabs />);
    await waitFor(() => {
      expect(screen.getByTestId("demo-overlaps")).toBeVisible();
    });
    expect(screen.queryByTestId("demo-studio")).not.toBeInTheDocument();
  });

  it("clears mapped hash when switching away", async () => {
    window.location.hash = "#foo";
    render(<DemoTabs />);
    await waitFor(() => expect(screen.getByTestId("demo-overlaps")).toBeVisible());

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Studio" }));
    await waitFor(() => expect(screen.getByTestId("demo-studio")).toBeVisible());
    await waitFor(() => expect(window.location.hash).toBe(""));
  });

  it("keeps an unmapped tab selected when leaving a mapped tab", async () => {
    window.location.hash = "#foo";
    const { rerender } = render(<DemoTabs />);
    await waitFor(() => expect(screen.getByTestId("demo-overlaps")).toBeVisible());

    await userEvent.setup().click(screen.getByRole("tab", { name: "Runs" }));
    rerender(<DemoTabs />);

    expect(screen.getByTestId("demo-runs")).toBeVisible();
    expect(window.location.hash).toBe("");
  });

  it("returns to the default tab when browser hash navigation clears a mapped hash", async () => {
    window.location.hash = "#foo";
    render(<DemoTabs />);
    await waitFor(() => expect(screen.getByTestId("demo-overlaps")).toBeVisible());

    act(() => {
      window.history.replaceState({}, "", "/");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(screen.getByTestId("demo-studio")).toBeVisible();
  });

  it("allows tab selection without hash mappings", async () => {
    render(
      <HashTabs defaultValue="first">
        <TabsList>
          <TabsTrigger value="first">First</TabsTrigger>
          <TabsTrigger value="second">Second</TabsTrigger>
        </TabsList>
        <TabsContent value="first">First content</TabsContent>
        <TabsContent value="second">Second content</TabsContent>
      </HashTabs>
    );

    await userEvent.setup().click(screen.getByRole("tab", { name: "Second" }));

    expect(screen.getByText("Second content")).toBeVisible();
  });
});
