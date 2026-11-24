import * as React from "react";
import { render, screen } from "@testing-library/react";
import { FormFieldLayout } from "../../packages/ui/src/form";
import { Input } from "../../packages/ui/src/input";

function Field({ error }: { error?: string }) {
  return (
    <FormFieldLayout label="Transfer code" description="Use the code on the manifest." error={error}
      messageTestId="field-error">
      {({ fieldId, describedBy, invalid }) => (
        <Input id={fieldId} invalid={invalid} aria-describedby={describedBy} />
      )}
    </FormFieldLayout>
  );
}

// DESIGN.md section 9: every field has a label, its hint is announced, and an error is tied to its field.
test("labels the field and describes it with its hint", () => {
  render(<Field />);
  const input = screen.getByLabelText("Transfer code");
  expect(input).toHaveAccessibleDescription("Use the code on the manifest.");
  expect(input).not.toHaveAttribute("aria-invalid");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("adds the error to the description and marks the field invalid", () => {
  render(<Field error="Transfer code is required." />);
  const input = screen.getByLabelText("Transfer code");
  expect(input).toHaveAttribute("aria-invalid", "true");
  expect(input).toHaveAccessibleDescription("Use the code on the manifest. Transfer code is required.");
  expect(screen.getByRole("alert")).toHaveTextContent("Transfer code is required.");
  expect(screen.getByTestId("field-error")).toBe(screen.getByRole("alert"));
});
