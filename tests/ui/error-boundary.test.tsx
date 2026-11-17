import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../../packages/ui/src/error-boundary";
import { setUiReporter } from "../../packages/ui/src/reporting";

afterEach(() => {
  setUiReporter(null);
});

test("error boundary renders fallback and reports error", () => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});

  const Thrower = () => {
    throw new Error("boom");
  };

  render(
    <ErrorBoundary fallback={<div>Fallback</div>}>
      <Thrower />
    </ErrorBoundary>
  );

  expect(screen.getByText("Fallback")).toBeInTheDocument();
  expect(reporter).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ui.error", message: "boom" })
  );

  consoleError.mockRestore();
});
