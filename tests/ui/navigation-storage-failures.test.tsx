import { fireEvent, render, screen } from "@testing-library/react";
import {
  NavigationStateProvider,
  useNavigationState,
} from "../../packages/ui/src/navigation-preferences";

const storageKey = "test:navigation:storage-failures";

function NavigationControls() {
  const navigation = useNavigationState();
  return (
    <>
      <output data-testid="hydrated">{String(navigation.hydrated)}</output>
      <output data-testid="favorites">{navigation.favorites.join(",")}</output>
      <button onClick={navigation.toggleSidebarCollapsed}>
        {navigation.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      </button>
      <button onClick={() => navigation.toggleFavorite("shipments")}>Favorite shipments</button>
    </>
  );
}

function renderNavigation() {
  return render(
    <NavigationStateProvider
      storageKey={storageKey}
      legacyStorageKey="test:navigation:legacy"
      maxFavorites={10}
      maxRecents={10}
      defaultSidebarCollapsed={false}
      defaultCollapsedSections={[]}
      defaultLayoutMode="full"
    >
      <NavigationControls />
    </NavigationStateProvider>
  );
}

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

it("hydrates and allows navigation preferences when browser storage is denied", () => {
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });

  renderNavigation();

  expect(screen.getByTestId("hydrated")).toHaveTextContent("true");
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Favorite shipments" }));
  expect(screen.getByTestId("favorites")).toHaveTextContent("shipments");
});

it("preserves loaded preferences and updates in memory when storage is full", () => {
  localStorage.setItem(storageKey, JSON.stringify({ favorites: ["orders"] }));
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });

  renderNavigation();

  expect(screen.getByTestId("favorites")).toHaveTextContent("orders");
  fireEvent.click(screen.getByRole("button", { name: "Favorite shipments" }));
  expect(screen.getByTestId("favorites")).toHaveTextContent("shipments,orders");
});

it("uses defaults when only legacy storage reads are denied", () => {
  const getItem = Storage.prototype.getItem;
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
    if (key === "test:navigation:legacy") {
      throw new DOMException("Storage blocked", "SecurityError");
    }
    return getItem.call(this, key);
  });

  renderNavigation();

  expect(screen.getByTestId("hydrated")).toHaveTextContent("true");
  expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
});
