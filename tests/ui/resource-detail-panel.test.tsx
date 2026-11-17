import { render, screen } from "@testing-library/react";
import { ResourceDetailPanel } from "../../packages/ui/src/resource-detail-panel";

const pushMock = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

const setMatchMedia = (matches: boolean) => {
  window.matchMedia = (query) =>
    ({
      matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
};

beforeEach(() => {
  pushMock.mockClear();
});

test("resource detail panel renders in drawer on mobile", () => {
  setMatchMedia(false);
  render(
    <ResourceDetailPanel
      open
      title="Shipment detail"
      detailToggleHref="/resources/shipments?id=1&detail_open=0"
    >
      <div>Detail body</div>
    </ResourceDetailPanel>
  );

  expect(screen.getByText("Detail body")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

test("resource detail panel renders inline on desktop", () => {
  setMatchMedia(true);
  render(
    <ResourceDetailPanel
      open
      title="Shipment detail"
      detailToggleHref="/resources/shipments?id=1&detail_open=0"
    >
      <div>Detail body</div>
    </ResourceDetailPanel>
  );

  expect(screen.getByText("Detail body")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
});
