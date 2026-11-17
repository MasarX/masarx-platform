import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResourceImportLauncher } from "../../packages/ui/src/resource-import-launcher";
import { QueryProvider } from "../../packages/ui/src/query-provider";
import { ToastHost } from "../../packages/ui/src/use-toast";

const pushMock = jest.fn();
const refreshMock = jest.fn();
const recordId = "4d1fbd36-6b6e-4c35-acc4-5e3ad9043830";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock, refresh: refreshMock }) }));
jest.mock("../../packages/ui/src/resource-import-page", () => ({
  ResourceImportPage: ({ onOpenImportedRecord, onReportReady }: { onOpenImportedRecord: (resource: string, id: string) => void; onReportReady: () => void }) => (
    <>
      <button onClick={onReportReady}>Report ready</button>
      <button onClick={() => onOpenImportedRecord("shipments", recordId)}>Open primary</button>
      <button onClick={() => onOpenImportedRecord("recipients", recordId)}>Open related</button>
    </>
  ),
}));

beforeEach(() => jest.clearAllMocks());

test.each([
  ["Open primary", `/console/resources/shipments?status=active&detail_layout=full&id=${recordId}&detail_open=1`],
  ["Open related", `/console/resources/recipients?id=${recordId}&detail_open=1`],
])("%s closes the importer and opens the confirmed record without a reload", (label, href) => {
  render(<QueryProvider><ToastHost><ResourceImportLauncher appBasePath="/console" resourceKey="shipments" allowed returnTo="/console/resources/shipments?status=active&detail_layout=full" /></ToastHost></QueryProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  fireEvent.click(screen.getByRole("button", { name: "Report ready" }));
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(pushMock).toHaveBeenCalledWith(href);
  expect(refreshMock).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
});
