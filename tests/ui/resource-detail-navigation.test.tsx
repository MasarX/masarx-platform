import { screen, fireEvent } from "@testing-library/react";
import { renderWithIntl } from "./test-utils";
import { ResourceDetailNavigation } from "../../packages/ui/src/resource-detail-navigation";

const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/test",
}));

beforeEach(() => {
  mockPush.mockClear();
});

test("renders prev and next buttons", () => {
  renderWithIntl(
    <ResourceDetailNavigation prevHref="/prev" nextHref="/next" />
  );

  expect(
    screen.getByRole("button", { name: /previous record/i })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /next record/i })
  ).toBeInTheDocument();
});

test("disables prev button when no prevHref", () => {
  renderWithIntl(<ResourceDetailNavigation nextHref="/next" />);

  expect(
    screen.getByRole("button", { name: /previous record/i })
  ).toBeDisabled();
});

test("disables next button when no nextHref", () => {
  renderWithIntl(<ResourceDetailNavigation prevHref="/prev" />);

  expect(
    screen.getByRole("button", { name: /next record/i })
  ).toBeDisabled();
});

test("calls onNavigate with href when clicking next", () => {
  const onNavigate = jest.fn();
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/prev"
      nextHref="/next"
      onNavigate={onNavigate}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /next record/i }));

  expect(onNavigate).toHaveBeenCalledWith("/next");
});

test("calls onNavigate with href when clicking prev", () => {
  const onNavigate = jest.fn();
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/prev"
      nextHref="/next"
      onNavigate={onNavigate}
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /previous record/i }));

  expect(onNavigate).toHaveBeenCalledWith("/prev");
});

test("uses router.push when onNavigate not provided", () => {
  renderWithIntl(
    <ResourceDetailNavigation prevHref="/prev" nextHref="/next" />
  );

  fireEvent.click(screen.getByRole("button", { name: /next record/i }));

  expect(mockPush).toHaveBeenCalledWith("/next");
});

test("strips safe appBasePath when navigating", () => {
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/portal/prev"
      nextHref="/portal/next"
      appBasePath="/portal"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /next record/i }));

  expect(mockPush).toHaveBeenCalledWith("/next");
});

test("preserves href when appBasePath is unsafe", () => {
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/portal/prev"
      nextHref="/portal/next"
      appBasePath="javascript:alert(1)"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: /next record/i }));

  expect(mockPush).toHaveBeenCalledWith("/portal/next");
});

test("Alt+ArrowLeft triggers prev navigation", () => {
  const onNavigate = jest.fn();
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/prev"
      nextHref="/next"
      onNavigate={onNavigate}
    />
  );

  fireEvent.keyDown(document, { key: "ArrowLeft", altKey: true });

  expect(onNavigate).toHaveBeenCalledWith("/prev");
});

test("Alt+ArrowRight triggers next navigation", () => {
  const onNavigate = jest.fn();
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/prev"
      nextHref="/next"
      onNavigate={onNavigate}
    />
  );

  fireEvent.keyDown(document, { key: "ArrowRight", altKey: true });

  expect(onNavigate).toHaveBeenCalledWith("/next");
});

test("shows position label when currentIndex and totalCount provided", () => {
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/prev"
      nextHref="/next"
      currentIndex={2}
      totalCount={10}
    />
  );

  expect(screen.getByText("3 / 10")).toBeInTheDocument();
});

test("does not show position label when missing index/total", () => {
  renderWithIntl(
    <ResourceDetailNavigation
      prevHref="/prev"
      nextHref="/next"
      currentIndex={2}
    />
  );

  expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
});
