import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Combobox } from "../../packages/ui/src/combobox";

describe("Combobox", () => {
  test("commits a single-select option on pointer interaction", () => {
    function Harness() {
      const [value, setValue] = React.useState("");
      return (
        <Combobox
          mode="single"
          options={[
            { value: "alpha", label: "Alpha option" },
            { value: "beta", label: "Beta option" },
          ]}
          value={value}
          onChange={(nextValue) => setValue(String(nextValue ?? ""))}
          placeholder="Pick one"
        />
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.pointerDown(screen.getByRole("option", { name: "Alpha option" }));

    expect(screen.getByRole("combobox")).toHaveTextContent("Alpha option");
    expect(screen.queryByRole("searchbox", { name: "Search options" })).not.toBeInTheDocument();
  });
});
