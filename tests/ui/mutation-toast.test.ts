import { withMutationToast } from "../../packages/ui/src/mutation-toast";

describe("withMutationToast", () => {
  test("shows success toast on resolved promise", async () => {
    const toastFn = jest.fn();
    const result = await withMutationToast(
      toastFn,
      Promise.resolve("ok"),
      { successMessage: "Saved!" }
    );

    expect(result).toBe("ok");
    expect(toastFn).toHaveBeenCalledTimes(1);
    expect(toastFn).toHaveBeenCalledWith({
      title: "Saved!",
      tone: "success",
    });
  });

  test("shows error toast on rejected promise and re-throws", async () => {
    const toastFn = jest.fn();
    const err = new Error("network error");

    await expect(
      withMutationToast(toastFn, Promise.reject(err), {
        errorMessage: "Save failed",
      })
    ).rejects.toThrow("network error");

    expect(toastFn).toHaveBeenCalledTimes(1);
    expect(toastFn).toHaveBeenCalledWith({
      title: "Save failed",
      description: "network error",
      tone: "error",
      durationMs: 10000,
    });
  });

  test("uses default messages when none provided", async () => {
    const toastFn = jest.fn();
    await withMutationToast(toastFn, Promise.resolve(42));

    expect(toastFn).toHaveBeenCalledWith({
      title: "Operation completed successfully",
      tone: "success",
    });
  });

  test("handles non-Error thrown values", async () => {
    const toastFn = jest.fn();

    await expect(
      withMutationToast(toastFn, Promise.reject("string error"))
    ).rejects.toBe("string error");

    expect(toastFn).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "string error",
        tone: "error",
      })
    );
  });

  test("returns the resolved value from the promise", async () => {
    const toastFn = jest.fn();
    const data = { id: 1, name: "test" };
    const result = await withMutationToast(toastFn, Promise.resolve(data));
    expect(result).toEqual(data);
  });
});
