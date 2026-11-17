import { render, screen, fireEvent } from "@testing-library/react";
import { ScopeSelector } from "../../packages/ui/src/label-designer/scope-selector";

const defaultProps = {
  prefix: "ld",
  scopeOptions: [
    { key: "tenant:org-1", scopeType: "tenant" as const, scopeId: "org-1", label: "Tenant \u2022 org-1" },
    { key: "client:cl-1", scopeType: "client" as const, scopeId: "cl-1", label: "Client \u2022 Acme" },
  ],
  selectedScopeKey: "tenant:org-1",
  organizationId: "org-12345678-full-uuid",
  scopeLoading: false,
  onScopeChange: jest.fn(),
};

describe("ScopeSelector", () => {
  beforeEach(() => {
    defaultProps.onScopeChange.mockClear();
  });

  it("renders scope options in select", () => {
    render(<ScopeSelector {...defaultProps} />);
    const select = screen.getByTestId("ld-scope-select");
    expect(select).toBeInTheDocument();
    const options = select.querySelectorAll("option");
    expect(options).toHaveLength(2);
  });

  it("displays organization ID", () => {
    render(<ScopeSelector {...defaultProps} />);
    expect(screen.getByText(/org-1234/)).toBeInTheDocument();
  });

  it("calls onScopeChange when selection changes", () => {
    render(<ScopeSelector {...defaultProps} />);
    const select = screen.getByTestId("ld-scope-select");
    fireEvent.change(select, { target: { value: "client:cl-1" } });
    expect(defaultProps.onScopeChange).toHaveBeenCalledWith("client:cl-1");
  });

  it("shows loading badge when scopeLoading is true", () => {
    render(<ScopeSelector {...defaultProps} scopeLoading={true} />);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });
});
