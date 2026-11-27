import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import {
  isTrustedDownloadUrl,
  safeDownloadUrls,
  ResourceDownloadAction,
} from "../../packages/ui/src/resource-download-action";
import { ToastHost } from "../../packages/ui/src/use-toast";
import { downloadTrustedFile } from "../../packages/ui/src/file-download";
import { setUiReporter } from "../../packages/ui/src/reporting";

jest.mock("../../packages/ui/src/file-download", () => ({
  downloadTrustedFile: jest.fn(),
}));
beforeEach(() => {
  (downloadTrustedFile as jest.Mock).mockReset().mockResolvedValue(true);
});

function renderWithToast(ui: React.ReactNode) {
  return render(<ToastHost>{ui}</ToastHost>);
}

test("downloads wait for file activation and count only successful files", async () => {
  let finish!: (ok: boolean) => void;
  (downloadTrustedFile as jest.Mock).mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(false);
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({ ok: true, headers: { get: () => null },
    json: async () => ({ urls: ["/one.pdf", "/two.pdf"] }) });
  try {
    renderWithToast(<ResourceDownloadAction resourceKey="shipments" downloadBasePath="/api/resource-download"
      selectedIds={["1", "2"]} />);
    const button = screen.getByRole("button", { name: "Download selected labels" });
    await userEvent.click(button);
    await waitFor(() => expect(downloadTrustedFile).toHaveBeenCalledWith("/one.pdf"));
    expect(button).toBeDisabled();
    expect(document.querySelector('[data-tone="success"]')).not.toBeInTheDocument();
    await act(async () => { finish(true); });
    await waitFor(() => expect(button).toBeEnabled());
    expect(document.querySelector('[data-tone="warning"]')).toBeInTheDocument();
    expect(document.querySelector('span.sr-only[role="status"]')).toHaveTextContent("Opened 1 label downloads. 1 failed.");
    expect(downloadTrustedFile).toHaveBeenCalledTimes(2);
  } finally { global.fetch = originalFetch; }
});

test("download action is disabled without selection", () => {
  renderWithToast(
    <ResourceDownloadAction
      resourceKey="shipments"
      downloadBasePath="/console/api/resource-download"
      selectedIds={[]}
      maxBatch={2}
    />
  );

  const button = screen.getByRole("button", { name: "Download selected labels" });
  expect(button).toBeDisabled();
  expect(button).toHaveTextContent("Download labels");
});

test("download action is disabled when selection exceeds max batch", () => {
  renderWithToast(
    <ResourceDownloadAction
      resourceKey="shipments"
      downloadBasePath="/console/api/resource-download"
      selectedIds={["1", "2"]}
      maxBatch={1}
    />
  );

  const button = screen.getByRole("button", { name: "Download selected labels" });
  expect(button).toBeDisabled();
  expect(button).toHaveTextContent("Download labels (2)");
});

test("download action enables when selection is within batch", () => {
  renderWithToast(
    <ResourceDownloadAction
      resourceKey="shipments"
      downloadBasePath="/console/api/resource-download"
      selectedIds={["1"]}
      maxBatch={2}
    />
  );

  const button = screen.getByRole("button", { name: "Download selected labels" });
  expect(button).toBeEnabled();
  expect(button).toHaveTextContent("Download labels");
});

test("bulk download sends request-id with the download request", async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: jest.fn(() => null) },
    json: async () => ({
      urls: ["/download/1"],
      total: 1,
    }),
  });
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;

  try {
    renderWithToast(
      <ResourceDownloadAction
        resourceKey="shipments"
        downloadBasePath="/console/api/resource-download"
        selectedIds={["1", "2"]}
        maxBatch={2}
      />
    );

    const button = screen.getByRole("button", {
      name: "Download selected labels",
    });
    await userEvent.click(button);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "GET",
        credentials: "include",
        headers: expect.objectContaining({
          accept: "application/json",
          "x-request-id": expect.any(String),
        }),
      })
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("download action ignores rapid repeat clicks while request is in-flight", async () => {
  type DownloadResponse = {
    ok: boolean;
    headers: {
      get: () => undefined | string;
    };
    json: () => Promise<unknown>;
  };

  const deferred = (() => {
    let resolve!: (value: {
      ok: boolean;
      headers: { get: () => undefined | string };
      json: () => Promise<unknown>;
    }) => void;
    const promise = new Promise<DownloadResponse>(
      (resolveFn) => {
        resolve = resolveFn;
      }
    );
    return { promise, resolve };
  })();

  const fetchMock = jest.fn().mockReturnValue(deferred.promise);
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;

  try {
    renderWithToast(
      <ResourceDownloadAction
        resourceKey="shipments"
        downloadBasePath="/console/api/resource-download"
        selectedIds={["1", "2", "3"]}
        maxBatch={5}
      />
    );

    const button = screen.getByRole("button", {
      name: "Download selected labels",
    });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          urls: ["/download/1", "/download/2", "/download/3"],
          total: 3,
        }),
      });

      await Promise.resolve();
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("single download waits for JSON before activating a signed URL and reporting success", async () => {
  let resolveResponse!: (value: unknown) => void;
  let resolveJson!: (value: unknown) => void;
  const responsePromise = new Promise((resolve) => { resolveResponse = resolve; });
  const jsonPromise = new Promise((resolve) => { resolveJson = resolve; });
  const fetchMock = jest.fn().mockReturnValue(responsePromise);
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;
  const activated: string[] = [];
  const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) { activated.push(this.href); });
  try {
    renderWithToast(<ResourceDownloadAction resourceKey="shipments"
      downloadBasePath="/api/resource-download" selectedIds={["1"]} maxBatch={2} />);
    const button = screen.getByRole("button", { name: "Download selected labels" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [href, options] = fetchMock.mock.calls[0];
    const requestUrl = new URL(href, window.location.origin);
    expect(requestUrl.searchParams.get("ids")).toBe("1");
    expect(requestUrl.searchParams.has("id")).toBe(false);
    expect(options).toMatchObject({ method: "GET", credentials: "include",
      headers: { accept: "application/json", "x-request-id": expect.any(String) } });
    expect(button).toBeDisabled();
    expect(clickSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-tone="success"]')).not.toBeInTheDocument();
    await act(async () => {
      resolveResponse({ ok: true, headers: { get: () => null }, json: () => jsonPromise });
      await Promise.resolve();
    });
    expect(clickSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[data-tone="success"]')).not.toBeInTheDocument();
    await act(async () => { resolveJson({ urls: ["/download/signed-1"], total: 1 }); });
    await waitFor(() => {
      expect(downloadTrustedFile).toHaveBeenCalledWith("/download/signed-1");
      expect(activated).toEqual([]);
      expect(document.querySelector('[data-tone="success"]')).toBeInTheDocument();
      expect(button).toBeEnabled();
    });
  } finally {
    global.fetch = originalFetch;
    clickSpy.mockRestore();
  }
});

test("bulk download partial failures use warning toast tone", async () => {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: jest.fn(() => null) },
    json: async () => ({
      urls: ["/download/1", "/download/2"],
      total: 2,
      errors: [{ id: "2", error: "quota exceeded" }],
    }),
  });
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;

  try {
    renderWithToast(
      <ResourceDownloadAction
        resourceKey="shipments"
        downloadBasePath="/console/api/resource-download"
        selectedIds={["1", "2"]}
        maxBatch={2}
      />
    );

    const button = screen.getByRole("button", {
      name: "Download selected labels",
    });
    await userEvent.click(button);

    await waitFor(() => {
      expect(document.querySelector('[data-tone="warning"]')).toBeInTheDocument();
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test.each([
  ["HTTP rejection", { ok: false, payload: { errors: [{ id: "1", error: "Access denied" }] } }],
  ["empty URLs", { ok: true, payload: { urls: [] } }],
  ["207 business failure", { ok: true, payload: { urls: [], errors: [{ id: "1", error: "Access denied eyJsecret.payload.signature" }] }, expectedError: "Unable to download labels. [requestId=server-request-id]" }],
  ["missing URLs", { ok: true, payload: {} }],
  ["unsafe returned URL", { ok: true, payload: { urls: ["javascript:alert(1)"] } }],
  ["mixed trusted and unsafe URLs", { ok: true, payload: { urls: ["/download/safe", "https://attacker.example/file"] } }],
  ["invalid JSON", { ok: true, invalidJson: true }],
  ["network failure", { networkFailure: true }],
  ["anchor failure", { ok: true, payload: { urls: ["/download/safe"] }, anchorFailure: true }],
] as const)("single download reports %s without success", async (_name, scenario) => {
  const fixture = scenario as { ok?: boolean; payload?: unknown; invalidJson?: boolean; networkFailure?: boolean; anchorFailure?: boolean; expectedError?: string };
  if (fixture.anchorFailure) (downloadTrustedFile as jest.Mock).mockResolvedValue(false);
  const fetchMock = fixture.networkFailure
    ? jest.fn().mockRejectedValue(new Error("Network unavailable"))
    : jest.fn().mockResolvedValue({ ok: fixture.ok,
      headers: { get: () => "server-request-id" },
      json: () => fixture.invalidJson ? Promise.reject(new Error("invalid JSON")) : Promise.resolve(fixture.payload),
    });
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;
  const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => { if (fixture.anchorFailure) throw new Error("blocked download"); });
  try {
    renderWithToast(<ResourceDownloadAction resourceKey="shipments" downloadBasePath="/api/resource-download"
      selectedIds={["1"]} maxBatch={2} />);
    const button = screen.getByRole("button", { name: "Download selected labels" });
    await userEvent.click(button);
    await waitFor(() => {
      expect(document.querySelector('[data-tone="error"]')).toBeInTheDocument();
      expect(document.querySelector('[data-tone="success"]')).not.toBeInTheDocument();
      expect(button).toBeEnabled();
    });
    if (!fixture.anchorFailure) expect(clickSpy).not.toHaveBeenCalled();
    if (fixture.expectedError) {
      expect(within(document.querySelector('[data-tone="error"]') as HTMLElement).getByText(fixture.expectedError)).toBeInTheDocument();
      expect(document.querySelector('[data-tone="error"]')).not.toHaveTextContent("eyJsecret.payload.signature");
      expect(document.querySelector('[data-tone="error"]')).not.toHaveTextContent("Access denied");
    }
    if (!fixture.networkFailure && !fixture.anchorFailure) {
      expect(document.querySelector('[data-tone="error"]')).toHaveTextContent("requestId=server-request-id");
    }
  } finally {
    global.fetch = originalFetch;
    clickSpy.mockRestore();
  }
});

test.each([1, 2])("%i selected downloads retain redacted diagnosis only in telemetry", async (count) => {
  const reporter = jest.fn();
  setUiReporter(reporter);
  const diagnosis = "Backend statement timeout\nCookie: session=synthetic-first; sid=synthetic-second";
  const error = count === 1 ? new Error(diagnosis) : { details: diagnosis };
  const originalFetch = global.fetch;
  global.fetch = jest.fn().mockRejectedValue(error) as typeof fetch;
  const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw error; });

  try {
    renderWithToast(<ResourceDownloadAction resourceKey="shipments"
      downloadBasePath="/console/api/resource-download" selectedIds={["1", "2"].slice(0, count)} />);
    await userEvent.click(screen.getByRole("button", { name: "Download selected labels" }));

    await waitFor(() => expect(reporter).toHaveBeenCalledWith(expect.objectContaining({
      type: "ui.error",
      context: "ResourceDownloadAction",
      message: "Backend statement timeout\nCookie: [redacted]",
      requestId: expect.any(String),
    })));
    expect(document.querySelector('[data-tone="error"]')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Backend");
    expect(document.body).not.toHaveTextContent("synthetic-");
    expect(JSON.stringify(reporter.mock.calls)).not.toContain("synthetic-");
  } finally {
    global.fetch = originalFetch;
    clickSpy.mockRestore();
    setUiReporter(null);
  }
});

test.each([
  "javascript:alert(1)",
  "https://attacker.example/resource-download",
])("bulk download blocks unsafe generated request href %s before fetch", async (downloadBasePath) => {
  const user = userEvent.setup();
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  global.fetch = fetchMock as unknown as typeof fetch;

  try {
    renderWithToast(
      <ResourceDownloadAction
        resourceKey="shipments"
        downloadBasePath={downloadBasePath}
        selectedIds={["1", "2"]}
        maxBatch={2}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "Download selected labels",
      })
    );

    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(document.querySelector('[data-tone="error"]')).toBeInTheDocument();
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test.each([
  "javascript:alert(1)",
  "https://attacker.example/resource-download",
])("single download blocks unsafe generated request href %s before link activation", async (downloadBasePath) => {
  const user = userEvent.setup();
  const clickSpy = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);

  try {
    renderWithToast(
      <ResourceDownloadAction
        resourceKey="shipments"
        downloadBasePath={downloadBasePath}
        selectedIds={["1"]}
        maxBatch={2}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "Download selected labels",
      })
    );

    await waitFor(() => {
      expect(clickSpy).not.toHaveBeenCalled();
      expect(document.querySelector('[data-tone="error"]')).toBeInTheDocument();
    });
  } finally {
    clickSpy.mockRestore();
  }
});
test("download URL validation fails closed on arbitrary external origins", () => {
  const previous = process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
  try {
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://trusted.example";
    expect(isTrustedDownloadUrl("https://trusted.example/path")).toBe(true);
    expect(isTrustedDownloadUrl("https://untrusted.example/path")).toBe(false);
    expect(isTrustedDownloadUrl("/downloads/object.csv")).toBe(true);
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS = previous;
    }
  }
});

test("download URL validation blocks unsafe schemes", () => {
  expect(isTrustedDownloadUrl("javascript:alert(1)")).toBe(false);
  expect(isTrustedDownloadUrl("data:text/plain,boom")).toBe(false);
  expect(isTrustedDownloadUrl("ftp://files.example/download.csv")).toBe(false);
});

test("download URL validation enforces allowlist when configured", () => {
  const allowlist = new Set(["cdn.example.com", "storage.example.com"]);

  expect(
    isTrustedDownloadUrl("https://storage.example.com/object.csv", allowlist)
  ).toBe(true);
  expect(
    isTrustedDownloadUrl("https://api.example.com/object.csv", allowlist)
  ).toBe(false);
});

test("safe download url list strips unsafe entries", () => {
  const previous = process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
  try {
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://cdn.example.com";
    expect(
      safeDownloadUrls([
        "https://cdn.example.com/object.csv",
        "javascript:alert(1)",
        "https://another.example.com/object.csv",
      ])
    ).toEqual(["https://cdn.example.com/object.csv"]);
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS = previous;
    }
  }
});

test.each([
  ["single", { urls: ["/download/1"] }, "Label download opened.", "status"],
  ["partial", { urls: ["/download/1"], errors: [{ error: "Unavailable" }] }, "Opened 1 label downloads. 1 failed.", "status"],
  ["unsafe", { urls: ["javascript:alert(1)"] }, "Blocked unsafe download URL returned by API.", "alert"],
] as Array<[string, Record<string, unknown>, string, "status" | "alert"]>)("retains assistive %s readback after pending state", async (_name, payload, expected, role) => {
  const originalFetch = global.fetch;
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => { resolve = done; });
  global.fetch = jest.fn(() => pending) as unknown as typeof fetch;
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  try {
    const { container } = renderWithToast(<ResourceDownloadAction resourceKey="shipments"
      downloadBasePath="/console/api/resource-download" selectedIds={["1"]} maxBatch={2} />);
    await userEvent.click(screen.getByRole("button", { name: "Download selected labels" }));
    expect(container.querySelector('span.sr-only[role="status"]')).toHaveTextContent("Preparing label download.");
    await act(async () => { resolve({ ok: true, headers: { get: () => null }, json: async () => payload }); });
    await waitFor(() => expect(container.querySelector(`span.sr-only[role="${role}"]`)).toHaveTextContent(expected));
    expect(container.querySelector(`span.sr-only[role="${role}"]`)).toHaveAttribute("aria-atomic", "true");
    if (role === "alert") expect(click).not.toHaveBeenCalled();
    else expect(downloadTrustedFile).toHaveBeenCalledTimes(1);
  } finally {
    global.fetch = originalFetch;
    click.mockRestore();
  }
});
