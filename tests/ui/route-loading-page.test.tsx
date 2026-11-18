import { render, screen } from "@testing-library/react";
import { RouteLoadingPage } from "../../packages/ui/src/route-loading-page";

test("renders loading state with testId", () => {
  render(<RouteLoadingPage />);
  expect(screen.getByTestId("route-loading-page")).toBeInTheDocument();
});

test("sets aria-busy for accessibility", () => {
  render(<RouteLoadingPage />);
  const el = screen.getByTestId("route-loading-page");
  expect(el).toHaveAttribute("aria-busy", "true");
});

test("has role status on the wrapper", () => {
  render(<RouteLoadingPage />);
  const el = screen.getByTestId("route-loading-page");
  expect(el).toHaveAttribute("role", "status");
});

test("renders shimmer skeleton lines", () => {
  const { container } = render(<RouteLoadingPage />);
  const skeletons = container.querySelectorAll(".ui-shimmer");
  expect(skeletons.length).toBeGreaterThan(0);
});
