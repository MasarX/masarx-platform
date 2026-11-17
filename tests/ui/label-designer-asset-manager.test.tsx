import { render, screen, fireEvent } from "@testing-library/react";
import { AssetManager } from "../../packages/ui/src/label-designer/asset-manager";

const defaultProps = {
  prefix: "ld",
  isBusy: false,
  canWrite: true,
  assets: [
    { name: "logo.png", path: "org-1/logo.png" },
    { name: "banner.jpg", path: "org-1/banner.jpg" },
  ],
  assetsError: null as string | null,
  onUpload: jest.fn(),
  onUploadFiles: jest.fn(),
  onOpen: jest.fn(),
  onDelete: jest.fn(),
};

describe("AssetManager", () => {
  beforeEach(() => {
    defaultProps.onUpload.mockClear();
    defaultProps.onUploadFiles.mockClear();
    defaultProps.onOpen.mockClear();
    defaultProps.onDelete.mockClear();
  });

  it("renders asset list", () => {
    render(<AssetManager {...defaultProps} />);
    expect(screen.getByTestId("ld-assets-list")).toBeInTheDocument();
    expect(screen.getAllByText("logo.png").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("banner.jpg").length).toBeGreaterThanOrEqual(1);
  });

  it("shows no-assets message when empty", () => {
    render(<AssetManager {...defaultProps} assets={[]} />);
    expect(screen.queryByTestId("ld-assets-list")).not.toBeInTheDocument();
  });

  it("shows assets error", () => {
    render(<AssetManager {...defaultProps} assetsError="Upload failed" />);
    expect(screen.getByTestId("ld-assets-error")).toHaveTextContent("Upload failed");
  });

  it("renders dropzone when onUploadFiles provided", () => {
    render(<AssetManager {...defaultProps} />);
    expect(screen.getByTestId("ld-dropzone-zone")).toBeInTheDocument();
  });

  it("renders file input when onUploadFiles not provided", () => {
    const { onUploadFiles: _, ...propsWithoutUploadFiles } = defaultProps;
    render(<AssetManager {...propsWithoutUploadFiles} />);
    expect(screen.getByTestId("ld-asset-upload")).toBeInTheDocument();
  });
});
