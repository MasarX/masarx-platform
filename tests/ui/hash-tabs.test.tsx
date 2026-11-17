import { render, screen, waitFor } from "@testing-library/react";
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
        <TabsTrigger value="overlaps">Overlaps</TabsTrigger>
      </TabsList>
      <TabsContent value="studio">
        <div data-testid="demo-studio">Studio content</div>
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
});
