jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useParams: () => ({}),
}));

import { screen } from "@testing-library/react";
import { createUiServerClient } from "@masarx/api/server";
import { ResourcePage } from "../../packages/ui/src/resource-page";
import { renderWithIntl } from "./test-utils";

const mockedCreateUiServerClient = createUiServerClient as unknown as jest.Mock;

describe("ResourcePage signed-out permission failure", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it.each(["registry", "list"] as const)(
    "renders the sign-in state without the raw %s error or setup hint",
    async (source) => {
      const error = {
        code: "42501",
        message: "permission denied for function synthetic_read_v1",
        hint: "Grant execute on synthetic_read_v1 to the anon role.",
      };
      mockedCreateUiServerClient.mockReturnValue({
        readRegistry: source === "registry"
          ? jest.fn().mockRejectedValue(error)
          : jest.fn().mockResolvedValue({ resources: [{ key: "shipments" }] }),
        me: jest.fn().mockResolvedValue({ capabilities: ["shipments.read"] }),
        listResource: jest.fn().mockRejectedValue(error),
      });

      renderWithIntl(await ResourcePage({
        appKey: "portal",
        appBasePath: "/portal",
        resourceKey: "shipments",
        searchParams: { tracking_number: "ZZTEST000000" },
        testIdPrefix: "portal-tracking-results",
      }));

      const notice = screen.getByTestId("portal-tracking-results-error");
      expect(notice).toHaveTextContent("This page isn’t available right now.");
      expect(notice).toHaveTextContent("Sign in or try again later.");
      expect(screen.getByRole("link", { name: "Sign in" }))
        .toHaveAttribute("href", expect.stringMatching(/\/portal\/signin$/));
      expect(document.body).not.toHaveTextContent(
        /permission denied|synthetic_read_v1|grant execute|anon role|provisioned|Resource view unavailable/i
      );
    }
  );
});
