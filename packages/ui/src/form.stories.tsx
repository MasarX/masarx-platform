import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { z } from "zod";
import { Button } from "./button";
import { Form, FormField, useZodForm } from "./form";
import { Input } from "./input";

const meta: Meta<typeof Form> = {
  title: "Forms/Form",
  component: Form
};

export default meta;
type Story = StoryObj<typeof Form>;

const schema = z.object({
  email: z.string().email("Enter a valid email")
});

export const WithValidation: Story = {
  render: () => {
    const form = useZodForm(schema, { defaultValues: { email: "" } });
    const [submitted, setSubmitted] = React.useState<string | null>(null);
    return (
      <div className="space-y-4">
        <Form
          form={form}
          onSubmit={(values) => setSubmitted(values.email)}
        >
          <FormField
            name="email"
            label="Email"
            description="Send notifications to this address."
            render={({ field, fieldId, describedBy, invalid }) => (
              <Input
                {...field}
                id={fieldId}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                placeholder="iwjxpqiwyuyklntvxxkxvirv@example.invalid"
              />
            )}
          />
          <Button type="submit">Save</Button>
        </Form>
        {submitted ? (
          <div className="text-sm text-ui-muted">
            Submitted: {submitted}
          </div>
        ) : null}
      </div>
    );
  }
};
