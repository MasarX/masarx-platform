import { render, screen } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { Badge } from "../../packages/ui/src/badge";
import { Button } from "../../packages/ui/src/button";
import { ContextStrip } from "../../packages/ui/src/context-strip";
import { ErrorState } from "../../packages/ui/src/error-state";
import { Section } from "../../packages/ui/src/section";
import { Skeleton } from "../../packages/ui/src/skeleton";
import { ThemeProvider } from "../../packages/ui/src/theme";
import { ThemeToggle } from "../../packages/ui/src/theme-toggle";

test("button shows loading state with aria-busy", () => {
  render(<Button loading>Save</Button>);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button).toHaveAttribute("aria-busy", "true");
});

test("badge renders accent tone", () => {
  render(<Badge tone="accent">New</Badge>);
  const badge = screen.getByText("New");
  expect(badge).toHaveClass("bg-ui-accent-soft");
});

test("skeleton renders default size classes", () => {
  const { container } = render(<Skeleton />);
  const skeleton = container.firstElementChild;
  expect(skeleton).toHaveClass("h-4");
  expect(skeleton).toHaveClass("w-full");
});

test("theme toggle renders select control", () => {
  render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>
  );
  expect(screen.getByLabelText("Theme")).toBeInTheDocument();
});

test("context strip renders metadata badges", () => {
  renderWithIntl(
    <ContextStrip
      userLabel="lpnoiwlvqmryinlkzgwwiosw@example.invalid"
      orgLabel="Demo Org"
      scopeLabel="platform:demo"
      capabilityCount={4}
    />
  );
  expect(screen.getByText("Signed in")).toBeInTheDocument();
  expect(screen.getByText("Demo Org")).toBeInTheDocument();
});

test("error state renders action button", () => {
  render(
    <ErrorState
      title="Something went wrong"
      description="Retry the request."
      actionLabel="Retry"
      onAction={() => {}}
    />
  );
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();    
});

test("section renders collapsible header when enabled", () => {
  render(
    <Section title="Profile details" description="Identity context" collapsible>
      <div>Section body</div>
    </Section>
  );
  const summary = screen.getByText("Profile details").closest("summary");
  expect(summary).toBeInTheDocument();
  expect(screen.getByText("Section body")).toBeInTheDocument();
});
