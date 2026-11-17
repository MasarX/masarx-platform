import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnHeaderMenu } from "../../packages/ui/src/table/column-header-menu";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { TranslateFn } from "../../packages/ui/src/table/types";
import { renderWithIntl } from "./test-utils";

const t: TranslateFn = (key) => key;

const column: ResourceColumn = { key: "name", label: "Name" };

function renderMenu(overrides: Partial<{
  column: ResourceColumn;
  isPinned: boolean;
  onAction: jest.Mock;
}> = {}) {
  const onAction = overrides.onAction ?? jest.fn();
  const result = renderWithIntl(
    <ColumnHeaderMenu
      t={t}
      column={overrides.column ?? column}
      isPinned={overrides.isPinned ?? false}
      onAction={onAction}
      trigger={<button>Menu</button>}
    />
  );
  return { ...result, onAction };
}

async function openMenu() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Menu" }));
  return user;
}

test("renders sort/hide/pin/autoWidth actions", async () => {
  renderMenu();
  await openMenu();

  expect(
    await screen.findByRole("menuitem", { name: "columnMenu.sortAsc" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: "columnMenu.sortDesc" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: "columnMenu.hide" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: "columnMenu.pin" })
  ).toBeInTheDocument();
  expect(
    screen.getByRole("menuitem", { name: "columnMenu.autoWidth" })
  ).toBeInTheDocument();
});

test("sortAsc dispatches correctly", async () => {
  const { onAction } = renderMenu();
  const user = await openMenu();

  const item = await screen.findByRole("menuitem", {
    name: "columnMenu.sortAsc",
  });
  await user.click(item);

  expect(onAction).toHaveBeenCalledWith("sortAsc", "name");
});

test("sortDesc dispatches correctly", async () => {
  const { onAction } = renderMenu();
  const user = await openMenu();

  const item = await screen.findByRole("menuitem", {
    name: "columnMenu.sortDesc",
  });
  await user.click(item);

  expect(onAction).toHaveBeenCalledWith("sortDesc", "name");
});

test("hide dispatches correctly", async () => {
  const { onAction } = renderMenu();
  const user = await openMenu();

  const item = await screen.findByRole("menuitem", {
    name: "columnMenu.hide",
  });
  await user.click(item);

  expect(onAction).toHaveBeenCalledWith("hide", "name");
});

test('shows "Unpin" text when isPinned=true', async () => {
  renderMenu({ isPinned: true });
  await openMenu();

  expect(
    await screen.findByRole("menuitem", { name: "columnMenu.unpin" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "columnMenu.pin" })
  ).toBeNull();
});

test('shows "Pin" text when isPinned=false', async () => {
  renderMenu({ isPinned: false });
  await openMenu();

  expect(
    await screen.findByRole("menuitem", { name: "columnMenu.pin" })
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("menuitem", { name: "columnMenu.unpin" })
  ).toBeNull();
});

test("pin dispatches correct action", async () => {
  const { onAction } = renderMenu({ isPinned: false });
  const user = await openMenu();

  const item = await screen.findByRole("menuitem", {
    name: "columnMenu.pin",
  });
  await user.click(item);

  expect(onAction).toHaveBeenCalledWith("pin", "name");
});

test("unpin dispatches correct action", async () => {
  const { onAction } = renderMenu({ isPinned: true });
  const user = await openMenu();

  const item = await screen.findByRole("menuitem", {
    name: "columnMenu.unpin",
  });
  await user.click(item);

  expect(onAction).toHaveBeenCalledWith("unpin", "name");
});

test("autoWidth dispatches correctly", async () => {
  const { onAction } = renderMenu();
  const user = await openMenu();

  const item = await screen.findByRole("menuitem", {
    name: "columnMenu.autoWidth",
  });
  await user.click(item);

  expect(onAction).toHaveBeenCalledWith("autoWidth", "name");
});
