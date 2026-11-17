import type { Preview } from "@storybook/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../packages/config/messages/en.json";
import "./storybook.css";

const preview: Preview = {
  decorators: [
    (Story) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <Story />
      </NextIntlClientProvider>
    )
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i
      }
    }
  }
};

export default preview;
