import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { ToastHost, useToast } from "./use-toast";

function ToastDemo() {
  const { toast } = useToast();
  return (
    <div className="space-y-4">
      <Button
        onClick={() =>
          toast({
            title: "View saved",
            description: "Your configuration is ready for use.",
            tone: "success"
          })
        }
      >
        Trigger toast
      </Button>
    </div>
  );
}

const meta: Meta<typeof ToastHost> = {
  title: "Feedback/Toast",
  component: ToastHost
};

export default meta;
type Story = StoryObj<typeof ToastHost>;

export const Default: Story = {
  render: () => (
    <ToastHost>
      <ToastDemo />
    </ToastHost>
  )
};
