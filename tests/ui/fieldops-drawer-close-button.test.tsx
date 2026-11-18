import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { FieldOpsDrawerCloseButton } from "../../apps/fieldops/src/mobile-drawer-close-button";
import { getFieldOpsStrings } from "../../apps/fieldops/src/i18n";

jest.mock("react-native", () => ({
  Pressable: ({ accessibilityLabel, testID, onPress, style, children }: any) => <button
    aria-label={accessibilityLabel} data-testid={testID} onClick={onPress}
    style={Object.assign({}, ...style({ pressed: false }).filter(Boolean))}>{children}</button>,
  Text: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}), { virtual: true });
test.each(["en", "ar"] as const)("renders the real named 44dp Pressable and closes the drawer in %s", (locale) => {
  const onClose = jest.fn();
  render(<FieldOpsDrawerCloseButton locale={locale} onClose={onClose} style={{}} textStyle={{}} />);
  const control = screen.getByRole("button", { name: getFieldOpsStrings(locale).more.closeModulesMenu });
  expect(control).toHaveStyle({ width: "44px", height: "44px" });
  if (locale === "ar") expect(control.getAttribute("aria-label")).toMatch(/[\u0600-\u06ff]/);
  fireEvent.click(control);
  expect(onClose).toHaveBeenCalledTimes(1);
});
