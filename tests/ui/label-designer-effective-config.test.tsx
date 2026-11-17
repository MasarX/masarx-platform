import { render, screen } from "@testing-library/react";
import { EffectiveConfigPanel } from "../../packages/ui/src/label-designer/effective-config-panel";

const defaultProps = {
  prefix: "ld",
  effectiveDesignJson: '{"templates": {}}',
  effectiveRenderPolicyJson: '{"dpi": 203}',
  effectivePrintProfileJson: '{"paper": "4x6"}',
  fieldCatalogJson: '{"fields": []}',
  mediaCatalogJson: '{"media": []}',
};

describe("EffectiveConfigPanel", () => {
  it("renders all five config textareas", () => {
    render(<EffectiveConfigPanel {...defaultProps} />);
    expect(screen.getByTestId("ld-effective-design")).toHaveValue('{"templates": {}}');
    expect(screen.getByTestId("ld-effective-render-policy")).toHaveValue('{"dpi": 203}');
    expect(screen.getByTestId("ld-effective-print-profile")).toHaveValue('{"paper": "4x6"}');
    expect(screen.getByTestId("ld-field-catalog")).toHaveValue('{"fields": []}');
    expect(screen.getByTestId("ld-media-catalog")).toHaveValue('{"media": []}');
  });

  it("textareas are read-only", () => {
    render(<EffectiveConfigPanel {...defaultProps} />);
    const textarea = screen.getByTestId("ld-effective-design");
    expect(textarea).toHaveAttribute("readonly");
  });
});
