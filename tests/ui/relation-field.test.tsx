import { render, screen } from "@testing-library/react";
import { RelationField } from "../../packages/ui/src/relation-field";

it.each([
  [undefined, "Select visible marketplace suppliers"],
  ["Private pool suppliers", "Private pool suppliers"],
])("renders the relation field with ariaLabel %s", (ariaLabel, expectedName) => {
  render(
    <RelationField
      mode="multi"
      value={[]}
      onChange={jest.fn()}
      options={[{ value: "supplier-a", label: "Supplier A" }]}
      placeholder="Select visible marketplace suppliers"
      ariaLabel={ariaLabel}
    />,
  );

  expect(screen.getByRole("combobox", { name: expectedName })).toBeInTheDocument();
});
