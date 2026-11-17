import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import {
  isTrustedDownloadUrl,
  safeDownloadUrls,
  ResourceDownloadAction,
} from "../../packages/ui/src/resource-download-action";
import { ToastHost } from "../../packages/ui/src/use-toast";

function renderWithToast(ui: React.ReactNode) {
  return render(<ToastHost>{ui}</ToastHost>);
}

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

test("single download uses success toast tone", async () => {
  const user = userEvent.setup();
  const clickSpy = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => undefined);

  renderWithToast(
    <ResourceDownloadAction
      resourceKey="shipments"
      downloadBasePath="/console/api/resource-download"
      selectedIds={["1"]}
      maxBatch={2}
    />
  );

  try {
    await user.click(
      screen.getByRole("button", {
        name: "Download selected labels",
      })
    );

    await waitFor(() => {
      expect(document.querySelector('[data-tone="success"]')).toBeInTheDocument();
    });
  } finally {
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

test("download failures use error toast tone", async () => {
  const user = userEvent.setup();
  const clickSpy = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {
      throw new Error("blocked download");
    });

  renderWithToast(
    <ResourceDownloadAction
      resourceKey="shipments"
      downloadBasePath="/console/api/resource-download"
      selectedIds={["1"]}
      maxBatch={2}
    />
  );

  try {
    await user.click(
      screen.getByRole("button", {
        name: "Download selected labels",
      })
    );

    await waitFor(() => {
      expect(document.querySelector('[data-tone="error"]')).toBeInTheDocument();
    });
  } finally {
    clickSpy.mockRestore();
  }
});

test("download URL validation allows https URLs by default", () => {
  expect(isTrustedDownloadUrl("https://trusted.example/path")).toBe(true);
  expect(isTrustedDownloadUrl("/downloads/object.csv")).toBe(true);
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
  expect(
    safeDownloadUrls([
      "https://cdn.example.com/object.csv",
      "javascript:alert(1)",
      "https://another.example.com/object.csv",
    ])
  ).toEqual([
    "https://cdn.example.com/object.csv",
    "https://another.example.com/object.csv",
  ]);
});
