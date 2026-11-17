import { render, screen, fireEvent } from "@testing-library/react";
import { DraftDiff } from "../../packages/ui/src/label-designer/draft-diff";

describe("DraftDiff", () => {
  it("shows change count", () => {
    render(
      <DraftDiff
        leftJson='{"a": 1}'
        rightJson='{"a": 2}'
      />,
    );
    expect(screen.getByText(/1 change/)).toBeInTheDocument();
  });

  it("shows no differences when JSONs match", () => {
    render(
      <DraftDiff
        leftJson='{"a": 1}'
        rightJson='{"a": 1}'
      />,
    );
    expect(screen.getByText(/0 change/)).toBeInTheDocument();
  });

  it("detects added keys", () => {
    render(
      <DraftDiff
        leftJson='{"a": 1}'
        rightJson='{"a": 1, "b": 2}'
      />,
    );
    expect(screen.getByText(/1 change/)).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("toggles show unchanged", () => {
    render(
      <DraftDiff
        leftJson='{"a": 1, "b": 2}'
        rightJson='{"a": 1, "b": 3}'
      />,
    );
    // Only changed rows should show by default
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  it("handles invalid JSON gracefully", () => {
    render(
      <DraftDiff
        leftJson="not json"
        rightJson='{"a": 1}'
      />,
    );
    expect(screen.getByText(/\d+ change/)).toBeInTheDocument();
  });
});
