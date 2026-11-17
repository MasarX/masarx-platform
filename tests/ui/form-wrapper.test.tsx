import { render, screen } from "@testing-library/react";
import { z } from "zod";
import { Input } from "../../packages/ui/src/input";
import { Form, FormField, useZodForm } from "../../packages/ui/src/form";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
});

function DemoForm() {
  const form = useZodForm(schema, {
    defaultValues: { email: "demo@example.com" },
  });

  return (
    <Form form={form}>
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
    </Form>
  );
}

test("form field renders label and description", () => {
  render(<DemoForm />);
  expect(screen.getByText("Email")).toBeInTheDocument();
  expect(screen.getByText("We will never share your email.")).toBeInTheDocument();
  expect(screen.getByDisplayValue("demo@example.com")).toBeInTheDocument();
});
