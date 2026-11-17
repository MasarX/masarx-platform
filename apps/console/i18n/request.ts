import { getRequestConfig } from "next-intl/server";
import { loadMessages } from "./index";

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = (await requestLocale) || "en";
  return {
    locale,
    messages: await loadMessages(locale),
  };
});
