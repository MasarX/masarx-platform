import dynamic from "next/dynamic";
import { LoadingState } from "@masarx/ui";
import { withPortalConfig } from "../../app-context";

const ResourceImportPage = dynamic(
  () => import("@masarx/ui").then((mod) => ({ default: mod.ResourceImportPage })),
  { loading: () => <LoadingState variant="page" /> }
);

type PageProps = {
  searchParams: Record<string, string | string[] | undefined>;
};

const firstValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default withPortalConfig<PageProps>(({ appBasePath }, { searchParams }) => (
  <ResourceImportPage
    appBasePath={appBasePath}
    initialResourceKey={firstValue(searchParams.resource) ?? null}
    initialReturnTo={firstValue(searchParams.return_to) ?? null}
    initialProfileName={firstValue(searchParams.profile) ?? null}
    initialSheetName={firstValue(searchParams.sheet) ?? null}
    testIdPrefix="portal-resource-import"
  />
));
