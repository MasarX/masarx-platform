import React from "react";
import { screen, within } from "@testing-library/react";
import { useToast, type ToastOptions } from "../../packages/ui/src/use-toast";
import { renderWithIntl } from "./test-utils";

function ShowToast(options: ToastOptions) {
  const { toast } = useToast();
  const shown = React.useRef(false);
  React.useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    toast(options);
  });
  return null;
}

test("toast shows a description equal to its title only once", async () => {
  renderWithIntl(<ShowToast tone="error" title="Run schedule" description="Run schedule" />);
  await screen.findByText("Run schedule");
  const toast = document.querySelector('[data-tone="error"]') as HTMLElement;
  expect(within(toast).getAllByText("Run schedule")).toHaveLength(1);
});

test("toast still shows a different description with its title", async () => {
  renderWithIntl(<ShowToast tone="error" title="Run schedule" description="Schedule run could not be confirmed. Try again." />);
  await screen.findByText("Schedule run could not be confirmed. Try again.");
  const toast = document.querySelector('[data-tone="error"]') as HTMLElement;
  expect(within(toast).getByText("Run schedule")).toBeInTheDocument();
  expect(within(toast).getByText("Schedule run could not be confirmed. Try again.")).toBeInTheDocument();
});
