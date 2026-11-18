jest.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  TextInput: "TextInput",
  Modal: "Modal",
  Dimensions: { get: () => ({ height: 800 }) },
  StyleSheet: { create: (styles: object) => styles, absoluteFillObject: {} },
}), { virtual: true });
jest.mock("../../apps/fieldops/src/mobile-theme-context", () => {
  const { getTokensForTheme } = jest.requireActual("../../apps/fieldops/src/mobile-theme");
  return {
    useTheme: () => ({ tokens: getTokensForTheme("light") }),
    useThemedStyles: (factory: (tokens: ThemeTokens) => unknown) => factory(getTokensForTheme("light")),
  };
});

import { getTokensForTheme, type ThemeTokens } from "../../apps/fieldops/src/mobile-theme";
import { FormField } from "../../apps/fieldops/src/components/FormField";

const field = { label: "Fixture value", value: "Sample", hint: "Enter a value" };

test("forwards accessible label, input settings and edits", () => {
  const onChangeText = jest.fn();
  const container = FormField({ ...field, onChangeText, secureTextEntry: true });
  const [, row, hint] = container.props.children;
  const [, input] = row.props.children;

  expect(container.props.accessibilityHint).toBe(field.hint);
  expect(hint.props.children).toBe(field.hint);
  expect(input.props).toMatchObject({
    value: field.value, accessibilityLabel: field.label, secureTextEntry: true, editable: true,
  });
  input.props.onChangeText("Updated sample");
  expect(onChangeText).toHaveBeenCalledWith("Updated sample");
});

test("announces the error before the hint and blocks disabled edits", () => {
  const onChangeText = jest.fn();
  const error = "Value is invalid";
  const container = FormField({ ...field, error, disabled: true, onChangeText });
  const [, row, support] = container.props.children;
  const [, input] = row.props.children;

  expect(container.props.accessibilityHint).toBe(error);
  expect(support.props).toMatchObject({ testID: "form-field-error", children: error });
  expect(row.props.style).toContainEqual(expect.objectContaining({
    borderColor: getTokensForTheme("light").color.danger,
  }));
  expect(input.props.editable).toBe(false);
  input.props.onChangeText("Ignored");
  expect(onChangeText).not.toHaveBeenCalled();
});
