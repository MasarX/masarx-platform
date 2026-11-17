import { render, screen } from "@testing-library/react";
import { AssetThumbnail } from "../../packages/ui/src/label-designer/asset-thumbnail";

const originalTrustedExternalDataOrigins =
  process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;

describe("AssetThumbnail", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
      "https://cdn.example.com";
  });

  afterEach(() => {
    if (originalTrustedExternalDataOrigins === undefined) {
      delete process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS;
    } else {
      process.env.NEXT_PUBLIC_UI_TRUSTED_EXTERNAL_DATA_ORIGINS =
        originalTrustedExternalDataOrigins;
    }
  });

  it("renders only exact-origin signed image urls", () => {
    const { rerender } = render(
      <AssetThumbnail
        asset={{ name: "logo.png", path: "tenant/logo.png" }}
        signedUrl="https://cdn.example.com/tenant/logo.png"
      />
    );

    expect(screen.getByRole("img", { name: "logo.png" })).toHaveAttribute(
      "src",
      "https://cdn.example.com/tenant/logo.png"
    );

    rerender(
      <AssetThumbnail
        asset={{ name: "logo.png", path: "tenant/logo.png" }}
        signedUrl="https://cdn.example.com.evil.test/tenant/logo.png"
      />
    );

    expect(screen.queryByRole("img", { name: "logo.png" })).not.toBeInTheDocument();
  });

  it("keeps relative-authority bypass candidates inert", () => {
    const { rerender } = render(
      <AssetThumbnail
        asset={{ name: "logo.png", path: "tenant/logo.png" }}
        signedUrl="/\\evil.test/tenant/logo.png"
      />
    );

    expect(screen.queryByRole("img", { name: "logo.png" })).not.toBeInTheDocument();

    rerender(
      <AssetThumbnail
        asset={{ name: "logo.png", path: "tenant/logo.png" }}
        signedUrl="/\tevil.test/tenant/logo.png"
      />
    );

    expect(screen.queryByRole("img", { name: "logo.png" })).not.toBeInTheDocument();
  });
});
