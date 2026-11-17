import { render, screen } from "@testing-library/react";
import { EmptyState } from "../../packages/ui/src/empty-state";
import { LoadingState } from "../../packages/ui/src/loading-state";

test("empty state renders title and description", () => {
  render(
    <EmptyState
      title="No shipments"
      description="Try adjusting your filters."
      testId="empty-state"
    />
  );
  expect(screen.getByText("No shipments")).toBeInTheDocument();
  expect(screen.getByText("Try adjusting your filters.")).toBeInTheDocument();
  expect(screen.getByTestId("empty-state")).toHaveAttribute("role", "status");
});

test("loading state renders aria-busy status", () => {
  render(<LoadingState testId="loading-state" />);
  const state = screen.getByTestId("loading-state");
  expect(state).toHaveAttribute("aria-busy", "true");
});
