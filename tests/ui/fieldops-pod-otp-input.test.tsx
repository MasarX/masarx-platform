import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MobileV2PodScreen } from "../../apps/fieldops/src/mobile-v2-pod-screen";
import { MOBILE_V2_POD_DEFAULT_POLICY } from "../../apps/fieldops/src/mobile-v2-pod-policy";
import { MOBILE_V2_THEMES } from "../../apps/fieldops/src/mobile-v2-themes";
import { AR_STRINGS, EN_STRINGS } from "../../apps/fieldops/src/i18n";

const mockInputProps: Array<Record<string, any>> = [];
jest.mock("react-native", () => {
  const web = jest.requireActual("react-native-web");
  const react = jest.requireActual("react");
  // Records the props the screen gives its TextInput, then renders the real web TextInput.
  const TextInput = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    mockInputProps.push(props);
    return react.createElement(web.TextInput, { ...props, ref });
  });
  return { ...web, TextInput };
}, { virtual: true });
jest.mock("expo-camera", () => ({ CameraView: () => null, useCameraPermissions: () => [null, jest.fn()] }), { virtual: true });
jest.mock("react-native-svg", () => {
  const Stub = () => null;
  return { __esModule: true, default: Stub, Path: Stub, Circle: Stub, Rect: Stub };
}, { virtual: true });

const { StyleSheet } = jest.requireMock("react-native");
const noop = () => undefined;

test.each([
  ["en-SA", EN_STRINGS.podOtp],
  ["ar-SA", AR_STRINGS.podOtp],
])("the POD OTP field is a named, on-screen input with a visible focus ring (%s)", (locale, strings) => {
  mockInputProps.length = 0;
  const { container } = render(
    <MobileV2PodScreen
      theme={MOBILE_V2_THEMES.light}
      policy={{ ...MOBILE_V2_POD_DEFAULT_POLICY, methods: ["otp"] }}
      locale={locale}
      failSheetOpen={false}
      onCloseFailSheet={noop}
      onExit={noop}
      onCommit={noop}
      onSubmitFail={noop}
    />,
  );

  const props = mockInputProps[mockInputProps.length - 1];
  expect(props).toMatchObject({
    accessibilityLabel: strings.label,
    accessibilityHint: strings.hint,
    textContentType: "oneTimeCode",
    autoComplete: "sms-otp",
    keyboardType: "number-pad",
    maxLength: 4,
  });
  if (locale === "ar-SA") expect(props.accessibilityLabel).toMatch(/[\u0600-\u06ff]/);
  // On screen over the digit boxes, never parked off screen or faded out.
  expect(StyleSheet.flatten(props.style)).toMatchObject({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 });
  expect(StyleSheet.flatten(props.style)).not.toHaveProperty("opacity");

  const input = container.querySelector("input") as HTMLInputElement;
  expect(screen.queryByTestId("pod-otp-focus-ring")).toBeNull();
  act(() => input.focus());
  expect(screen.getByTestId("pod-otp-focus-ring")).toBeInTheDocument();

  fireEvent.change(input, { target: { value: "4a27" } });
  for (const digit of ["4", "2", "7"]) expect(screen.getByText(digit)).toBeInTheDocument();

  act(() => input.blur());
  expect(screen.queryByTestId("pod-otp-focus-ring")).toBeNull();
});
