import {
  classifyError,
  MobileErrorBoundary,
  type ErrorCategory,
} from "../../apps/fieldops/src/mobile-error-boundary";

test.each<[unknown, ErrorCategory]>([
  [new Error("Network unavailable"), "offline"],
  [new Error("Permission denied"), "permission"],
  [new Error("Request returned 503"), "server"],
  ["Fetch failed after a permission check", "offline"],
  [new Error("Unexpected failure"), "unknown"],
  [null, "unknown"],
])("categorizes errors for retry guidance", (error, category) => {
  expect(classifyError(error)).toBe(category);
});

test("passes the retry action and safe category to a custom fallback", () => {
  const fallback = jest.fn((state: { retry: () => void; category: ErrorCategory }) => "Try again: " + state.category);
  const boundary = new MobileErrorBoundary({ children: "Ready", fallback });
  const error = new Error("Network unavailable");
  boundary.state = MobileErrorBoundary.getDerivedStateFromError(error);

  expect(boundary.render()).toBe("Try again: offline");
  expect(fallback).toHaveBeenCalledWith({ retry: expect.any(Function), category: "offline" });

  const setState = jest.spyOn(boundary, "setState").mockImplementation(() => undefined);
  try {
    fallback.mock.calls[0]![0].retry();
    expect(setState).toHaveBeenCalledWith({ hasError: false, category: "unknown" });
  } finally {
    setState.mockRestore();
  }
});
