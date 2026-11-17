import { Suspense } from "react";
import {
  LoadingState,
  CommandCatalogPage as UiCommandCatalogPage,
} from "@masarx/ui";

type CommandCatalogPageProps = Parameters<typeof UiCommandCatalogPage>[0];
const CommandCatalogPageInner = UiCommandCatalogPage as unknown as (
  props: CommandCatalogPageProps
) => JSX.Element;

export function CommandCatalogPage(props: CommandCatalogPageProps) {
  return (
    <Suspense
      fallback={
        <LoadingState variant="page" testId="console-commands-loading" />
      }
    >
      <CommandCatalogPageInner {...props} />
    </Suspense>
  );
}
