import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { unwrapMessagesImport } from "@masarx/config";
import * as uiMessagesRaw from "../../packages/config/messages/en.json";
import * as appMessagesRaw from "../../apps/console/messages/en.json";
import { QueryProvider } from "../../packages/ui/src/query-provider";
import { ToastHost } from "../../packages/ui/src/use-toast";

type MessagesImport = Record<string, unknown> | { default: Record<string, unknown> };
const uiMessages = unwrapMessagesImport(uiMessagesRaw as MessagesImport);
const appMessages = unwrapMessagesImport(appMessagesRaw as MessagesImport);

const defaultMessages = { ...uiMessages, ...appMessages };

type RenderOptions = Parameters<typeof render>[1] & {
  locale?: string;
  messages?: Record<string, unknown>;
};

export function renderWithIntl(
  ui: React.ReactElement,
  { locale = "en", messages = defaultMessages, ...options }: RenderOptions = {}
) {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <QueryProvider>
        <ToastHost>{children}</ToastHost>
      </QueryProvider>
    </NextIntlClientProvider>
  );

  return render(ui, { ...options, wrapper: Wrapper });
}
