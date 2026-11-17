jest.mock("@masarx/auth", () => ({
  createServerClient: jest.fn(),
}));

jest.mock("@masarx/api/server", () => ({
  createUiServerClient: jest.fn(),
}));

import { DashboardPage } from "@masarx/ui";
import { createServerClient } from "@masarx/auth";
import { createUiServerClient } from "@masarx/api/server";

const mockedCreateServerClient = createServerClient as jest.Mock;
const mockedCreateUiServerClient = createUiServerClient as jest.Mock;

describe("DashboardPage", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("skips context calls when there is no session", async () => {
    mockedCreateServerClient.mockReturnValue({
      auth: {
        getSession: jest.fn().mockResolvedValue({ data: { session: null } }),
      },
    });

    const result = await DashboardPage({
      appLabel: "Console",
      appKey: "console",
      appBasePath: "/console",
      testIdPrefix: "console-dashboard",
    });

    expect(result).toBeNull();
    expect(mockedCreateUiServerClient).not.toHaveBeenCalled();
  });
});
