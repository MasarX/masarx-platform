import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StopAddressActions } from "../../apps/fieldops/src/mobile-address-actions-controls";
import { AR_STRINGS, EN_STRINGS } from "../../apps/fieldops/src/i18n";

jest.mock("react-native", () => jest.requireActual("react-native-web"), { virtual: true });

describe("FieldOps address controls", () => {
  const copy = jest.fn();
  const share = jest.fn();
  const copyDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
  const props = {
    address: "10 Test Street", note: "Gate B", reference: "REF-42", disabled: false,
    runAction: async (action: () => Promise<void>) => action(),
    strings: EN_STRINGS.addressActions,
    styles: {},
  } as React.ComponentProps<typeof StopAddressActions>;

  beforeEach(() => {
    jest.resetAllMocks();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
  });
  afterEach(() => {
    if (copyDescriptor) Object.defineProperty(navigator, "clipboard", copyDescriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
    if (shareDescriptor) Object.defineProperty(navigator, "share", shareDescriptor);
    else Reflect.deleteProperty(navigator, "share");
  });

  test.each([EN_STRINGS.addressActions, AR_STRINGS.addressActions])(
    "uses localized controls and waits for clipboard completion before confirming (case %#)",
    async (strings) => {
      let finish!: () => void;
      copy.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
      const { container } = render(<StopAddressActions {...props} strings={strings} />);
      expect(container.querySelector('[aria-live="polite"]')).toBeEmptyDOMElement();
      fireEvent.click(screen.getByRole("button", { name: strings.copy }));
      expect(copy).toHaveBeenCalledWith("10 Test Street\nGate B\nREF-42");
      expect(screen.queryByText(strings.copied)).not.toBeInTheDocument();
      await act(async () => finish());
      expect(screen.getByText(strings.copied)).toHaveAttribute("aria-live", "polite");
      expect(screen.getByRole("button", { name: strings.share })).toBeEnabled();
    },
  );

  test("cancellation produces no success message and never writes the clipboard", async () => {
    share.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    render(<StopAddressActions {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: props.strings.share })));
    expect(share).toHaveBeenCalledWith({ text: "10 Test Street\nGate B\nREF-42" });
    expect(copy).not.toHaveBeenCalled();
    expect(screen.queryByText(props.strings.shared)).not.toBeInTheDocument();
    expect(screen.queryByText(props.strings.unavailable, { exact: false })).not.toBeInTheDocument();
  });

  test("opens Share in the click handler and confirms only after its promise resolves", async () => {
    let finish!: () => void;
    share.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<StopAddressActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: props.strings.share }));
    expect(share).toHaveBeenCalledWith({ text: "10 Test Street\nGate B\nREF-42" });
    expect(screen.queryByText(props.strings.shared)).not.toBeInTheDocument();
    await act(async () => finish());
    expect(screen.getByText(props.strings.shared)).toHaveAttribute("aria-live", "polite");
    expect(copy).not.toHaveBeenCalled();
  });

  test("unsupported sharing offers Copy explicitly, without copying automatically", async () => {
    Reflect.deleteProperty(navigator, "share");
    render(<StopAddressActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: props.strings.share }));
    await waitFor(() => expect(screen.getByText(`${props.strings.unavailable}: ${props.strings.shareUnsupported}`)).toHaveAttribute("aria-live", "polite"));
    expect(copy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: props.strings.copy })).toBeEnabled();
  });

  test("reports denial without a success message", async () => {
    copy.mockRejectedValue(new Error("denied"));
    render(<StopAddressActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: props.strings.copy }));
    await waitFor(() => expect(screen.getByText(`${props.strings.unavailable}: ${props.strings.failed}`)).toHaveAttribute("aria-live", "polite"));
    expect(screen.queryByText(props.strings.copied)).not.toBeInTheDocument();
  });

  test("clears old feedback when another action starts and does not retain it for another address", async () => {
    copy.mockResolvedValue(undefined);
    const { rerender } = render(<StopAddressActions {...props} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: props.strings.copy })));
    expect(screen.getByText(props.strings.copied)).toBeInTheDocument();
    share.mockRejectedValue(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: props.strings.share })));
    expect(screen.queryByText(props.strings.copied)).not.toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: props.strings.copy })));
    rerender(<StopAddressActions {...props} address="Another address" />);
    expect(screen.queryByText(props.strings.copied)).not.toBeInTheDocument();
  });

  test("does not show a late Copy result on a different address", async () => {
    let finish!: () => void;
    copy.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { rerender } = render(<StopAddressActions {...props} />);
    fireEvent.click(screen.getByRole("button", { name: props.strings.copy }));
    rerender(<StopAddressActions {...props} address="Another address" />);
    await act(async () => finish());
    expect(screen.queryByText(props.strings.copied)).not.toBeInTheDocument();
  });

  test.each([
    { disabled: true },
    { address: " " },
    { address: null },
  ])("honors the route lock and absent addresses (%p)", (overrides) => {
    render(<StopAddressActions {...props} {...overrides} />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(copy).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });
});
