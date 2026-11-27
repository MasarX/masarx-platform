import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { createUiClient } from "@masarx/api";
import { unwrapMessagesImport } from "@masarx/config";
import * as enRaw from "../../packages/config/messages/en.json";
import * as arRaw from "../../packages/config/messages/ar.json";
import { MappingStudioPage } from "../../packages/ui/src/mapping-studio-page";
import { renderWithIntl } from "./test-utils";

type Messages = Record<string, unknown>;
type MappingStudioMessages = {
  page: Record<string, string> & { artifacts: Record<string, string> };
  reviewDiagnostics: Record<string, string>;
  payloadPathPicker: Record<string, string>;
  spreadsheetPreview: Record<string, string>;
};
const unwrap = (raw: unknown) =>
  unwrapMessagesImport(raw as Messages | { default: Messages }) as { ui: { mappingStudio: MappingStudioMessages } };
const enMessages = unwrap(enRaw);
const arMessages = unwrap(arRaw);
const en = enMessages.ui.mappingStudio;
const ar = arMessages.ui.mappingStudio;
const ARABIC = /[؀-ۿ]/;

const readRegistry = jest.fn();
const listResource = jest.fn();
const preview = jest.fn();

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: jest.fn(),
}));

describe("MappingStudioPage in Arabic", () => {
  const previousLocale = process.env.NEXT_PUBLIC_LOCALE;

  beforeEach(() => {
    // createUiTranslator reads the locale from the public config at render time.
    process.env.NEXT_PUBLIC_LOCALE = "ar";
    readRegistry.mockResolvedValue({ resources: [] });
    listResource.mockResolvedValue({ resource: "workflow_templates", keys: ["id", "name"], items: [] });
    preview.mockResolvedValue({
      ok: true,
      save_modes: { direct_allowed: true, recommended: "direct" },
      review: { diagnostics: [], review_summary: { blocking_count: 0, warning_count: 0, coercion_count: 0 } },
    });
    (createUiClient as jest.Mock).mockReturnValue({
      readRegistry,
      listResource,
      mappingStudio: { parse: jest.fn(), infer: jest.fn(), preview, save: jest.fn() },
    });
  });

  afterEach(() => {
    if (previousLocale === undefined) delete process.env.NEXT_PUBLIC_LOCALE;
    else process.env.NEXT_PUBLIC_LOCALE = previousLocale;
  });

  test("renders the page, previews and review diagnostics from the Arabic catalog", async () => {
    renderWithIntl(<MappingStudioPage appBasePath="/console" initialArtifact="tabular_import" />, {
      locale: "ar",
      messages: arMessages as unknown as Messages,
    });

    await waitFor(() => expect(screen.getByRole("button", { name: ar.page.parse })).toBeEnabled());
    expect(screen.getByText(ar.page.title)).toBeInTheDocument();
    expect(screen.getByText(ar.page.sourceAndTarget)).toBeInTheDocument();
    expect(screen.getByLabelText(ar.page.uploadFile)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: ar.page.artifacts.webhook_inbound })).toBeInTheDocument();
    expect(await screen.findByText(ar.spreadsheetPreview.empty)).toBeInTheDocument();
    expect(await screen.findByText(ar.page.detectedColumns)).toBeInTheDocument();
    expect(screen.getByText(ar.payloadPathPicker.empty)).toBeInTheDocument();
    expect(screen.getByText(ar.page.noRules)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: ar.page.buildReview }));
    expect(await screen.findByText(ar.reviewDiagnostics.blockedTitle)).toBeInTheDocument();
    expect(screen.getByText(ar.reviewDiagnostics.noWarnings)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ar.page.submit })).toBeEnabled();
    expect(screen.getByText(ar.page.reviewSection)).toBeInTheDocument();
  });

  test("keeps the English catalog values equal to the previous literals", () => {
    expect(en.page.title).toBe("Mapping Studio");
    expect(en.page.parse).toBe("Parse / infer");
    expect(en.reviewDiagnostics.blockedTitle).toBe("Blocked issues");
    expect(en.spreadsheetPreview.title).toBe("Spreadsheet preview");
    for (const value of [ar.page.title, ar.page.parse, ar.reviewDiagnostics.blockedTitle, ar.spreadsheetPreview.title]) {
      expect(value).toMatch(ARABIC);
    }
  });
});
