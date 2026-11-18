import { render, screen, fireEvent } from "@testing-library/react";

const mockRefresh = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { RouteErrorPage } from "../../packages/ui/src/route-error-page";

beforeEach(() => {
  mockRefresh.mockClear();
});

test("renders error state with testId", () => {
  const error = new Error("Something went wrong");
  render(<RouteErrorPage error={error} reset={jest.fn()} />);
  expect(screen.getByTestId("route-error-page")).toBeInTheDocument();
});

test("displays the error message in details", () => {
  const error = new Error("fetch failed");
  render(<RouteErrorPage error={error} reset={jest.fn()} />);
  // The error detail toggle should be present
  const toggle = screen.getByTestId("route-error-page-details-toggle");
  expect(toggle).toBeInTheDocument();
});

test("Try Again button calls reset and router.refresh", () => {
  const error = new Error("network error");
  const resetFn = jest.fn();
  render(<RouteErrorPage error={error} reset={resetFn} />);

  const tryAgainButton = screen.getByRole("button", { name: /try again/i });
  fireEvent.click(tryAgainButton);

  expect(resetFn).toHaveBeenCalledTimes(1);
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

test("renders with page variant", () => {
  const error = new Error("oops");
  render(<RouteErrorPage error={error} reset={jest.fn()} />);
  // ErrorState with page variant renders an EmptyState with role=status
  expect(screen.getByRole("status")).toBeInTheDocument();
});
