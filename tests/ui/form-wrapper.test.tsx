import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { z } from "zod";
import { Input } from "../../packages/ui/src/input";
import { Form, FormField, useZodForm } from "../../packages/ui/src/form";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
});

function DemoForm({ onSubmit }: { onSubmit?: (values: z.infer<typeof schema>) => void }) {
  const form = useZodForm(schema, {
    defaultValues: { email: "demo@example.com" },
  });

  return (
    <Form form={form} onSubmit={onSubmit}>
      <FormField
        name="email"
        label="Email"
        description="We will never share your email."
        render={({ field, fieldId, describedBy, invalid }) => (
          <Input
            id={fieldId}
            {...field}
            aria-describedby={describedBy}
            aria-invalid={invalid}
          />
        )}
      />
      <button type="submit">Save</button>
    </Form>
  );
}

test("form field renders label and description", () => {
  render(<DemoForm />);
  expect(screen.getByText("Email")).toBeInTheDocument();
  expect(screen.getByText("We will never share your email.")).toBeInTheDocument();
  expect(screen.getByDisplayValue("demo@example.com")).toBeInTheDocument();
});

test("form blocks invalid submissions and clears accessible errors after correction", async () => {
  const onSubmit = jest.fn();
  render(<DemoForm onSubmit={onSubmit} />);
  const email = screen.getByLabelText("Email");

  fireEvent.change(email, { target: { value: "not-an-email" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  const error = await screen.findByRole("alert");
  expect(error).toHaveTextContent("Enter a valid email");
  expect(email).toHaveAttribute("aria-invalid", "true");
  expect(email.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.change(email, { target: { value: "corrected@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  expect(onSubmit.mock.calls[0][0]).toEqual({ email: "corrected@example.com" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(email).toHaveAttribute("aria-invalid", "false");
});

test("fixed Zod rejects oversized arrays before visiting their elements", () => {
  let visited = 0;
  const result = z.array(z.string().refine(() => {
    visited += 1;
    return false;
  })).max(2).safeParse(Array(16).fill("synthetic"));

  expect(result.success).toBe(false);
  expect(visited).toBe(0);
  expect(result.error?.issues).toHaveLength(1);
  expect(result.error?.issues[0].code).toBe("too_big");
});
