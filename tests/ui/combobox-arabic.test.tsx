import * as React from "react";
import { fireEvent, screen } from "@testing-library/react";
import { unwrapMessagesImport } from "@masarx/config";
import * as arRaw from "../../packages/config/messages/ar.json";
import { Combobox } from "../../packages/ui/src/combobox";
import { renderWithIntl } from "./test-utils";

type Messages = Record<string, unknown>;
const ar = unwrapMessagesImport(arRaw as Messages | { default: Messages }) as {
  ui: { combobox: Record<string, string> };
};
const text = ar.ui.combobox;
const arabic = { locale: "ar", messages: ar as Messages };

describe("Combobox under the Arabic provider", () => {
  test("names its controls and list from the ui.combobox catalog", () => {
    renderWithIntl(
      <Combobox mode="multi" options={[{ value: "a", label: "Alpha" }]} value={["a"]} onChange={jest.fn()} />,
      arabic,
    );
    expect(screen.getByRole("button", { name: text.removeAria.replace("{label}", "Alpha") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: text.clearAria })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox", { name: text.listAria })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: text.searchAria })).toBeInTheDocument();
  });

  test("shows the Arabic placeholder, empty, loading and create text", () => {
    const view = renderWithIntl(
      <Combobox mode="single" options={[]} value="" onChange={jest.fn()} allowCreate onCreateOption={jest.fn()} />,
      arabic,
    );
    expect(screen.getByRole("combobox", { name: text.placeholder })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByText(text.empty)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Zeta" } });
    expect(screen.getByText(text.createOption.replace("{query}", "Zeta"))).toBeInTheDocument();
    view.rerender(<Combobox mode="single" options={[]} value="" onChange={jest.fn()} loading />);
    expect(screen.getByText(text.loading)).toBeInTheDocument();
  });
});
