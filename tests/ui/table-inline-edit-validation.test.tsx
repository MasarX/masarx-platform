import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useInlineEdit } from "../../packages/ui/src/table/table-inline-edit";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";
import type { TranslateFn } from "../../packages/ui/src/table/types";

const updateResourceMock = jest.fn();
const toastMock = jest.fn();

jest.mock("@masarx/api", () => ({
  ...jest.requireActual("@masarx/api"),
  createUiClient: () => ({
    updateResource: updateResourceMock,
  }),
}));

const t: TranslateFn = ((key: string, values?: Record<string, unknown>) => {
  if (key === "edit.error") return "Unable to save change.";
  if (key === "edit.errors.invalidUuid") {
    return `${String(values?.label ?? "Value")} must be a valid UUID.`;
  }
  if (key === "edit.errors.invalidNumber") {
    return `${String(values?.label ?? "Value")} must be a valid number.`;
  }
  if (key === "edit.success") return `Saved ${String(values?.label ?? "value")}.`;
  return key;
}) as TranslateFn;

const columnsByKey = new Map<string, ResourceColumn>([
  [
    "organization_id",
    {
      key: "organization_id",
      label: "Organization Id",
    },
  ],
]);

const columnsByLabelStyleKey = new Map<string, ResourceColumn>([
  [
    "organization id",
    {
      key: "organization id",
      label: "Organization Id",
    },
  ],
]);

const baseItems = [
  {
    id: "1",
    organization_id: "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
  },
];

const nonUuidItems = [
  {
    id: "1",
    organization_id: "org-001",
  },
];

const labelStyleUuidItems = [
  {
    id: "1",
    "organization id": "121e5acf-103b-4e1d-9b4b-7326a4f3e25c",
  },
];

function InlineEditValidationHarness() {
  const [rowOverrides, setRowOverrides] = React.useState<
    Record<string, Record<string, unknown>>
  >({});
  const editConfigByKey = React.useMemo(
    () =>
      new Map([
        [
          "organization_id",
          {
            editType: "uuid" as const,
            options: [],
          },
        ],
      ]),
    []
  );
  const startTransition: React.TransitionStartFunction = (callback) => {
    void callback();
  };

  const { inlineEdit, startInlineEdit, updateInlineEditValue, commitInlineEdit } =
    useInlineEdit({
      editConfigByKey,
      inlineEditEnabled: true,
      columnsByKey,
      resolvedResourceKey: "shipments",
      resolvedItems: baseItems,
      idKey: "id",
      t,
      toast: toastMock,
      startTransition,
      setRowOverrides,
    });

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          startInlineEdit(
            "1",
            {
              key: "organization_id",
              label: "Organization Id",
            },
            "121e5acf-103b-4e1d-9b4b-7326a4f3e25c"
          )
        }
      >
        Start
      </button>
      <button
        type="button"
        onClick={() => updateInlineEditValue("e2e-170320818206")}
      >
        SetInvalid
      </button>
      <button type="button" onClick={() => commitInlineEdit()}>
        Commit
      </button>
      <output data-testid="inline-status">{inlineEdit?.status ?? "none"}</output>
      <output data-testid="inline-error">{inlineEdit?.error ?? ""}</output>
      <output data-testid="row-overrides-count">
        {String(Object.keys(rowOverrides).length)}
      </output>
    </div>
  );
}

function InlineEditApiUuidErrorHarness() {
  const [rowOverrides, setRowOverrides] = React.useState<
    Record<string, Record<string, unknown>>
  >({});
  const editConfigByKey = React.useMemo(
    () =>
      new Map([
        [
          "organization_id",
          {
            editType: "text" as const,
            options: [],
          },
        ],
      ]),
    []
  );
  const startTransition: React.TransitionStartFunction = (callback) => {
    void callback();
  };

  const { inlineEdit, startInlineEdit, updateInlineEditValue, commitInlineEdit } =
    useInlineEdit({
      editConfigByKey,
      inlineEditEnabled: true,
      columnsByKey,
      resolvedResourceKey: "shipments",
      resolvedItems: nonUuidItems,
      idKey: "id",
      t,
      toast: toastMock,
      startTransition,
      setRowOverrides,
    });

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          startInlineEdit(
            "1",
            {
              key: "organization_id",
              label: "Organization Id",
            },
            "org-001"
          )
        }
      >
        Start
      </button>
      <button
        type="button"
        onClick={() => updateInlineEditValue("e2e-170320818206")}
      >
        SetInvalid
      </button>
      <button type="button" onClick={() => commitInlineEdit()}>
        Commit
      </button>
      <output data-testid="inline-status">{inlineEdit?.status ?? "none"}</output>
      <output data-testid="inline-error">{inlineEdit?.error ?? ""}</output>
      <output data-testid="row-overrides-count">
        {String(Object.keys(rowOverrides).length)}
      </output>
    </div>
  );
}

function InlineEditInferredUuidHarness() {
  const [rowOverrides, setRowOverrides] = React.useState<
    Record<string, Record<string, unknown>>
  >({});
  const editConfigByKey = React.useMemo(
    () =>
      new Map([
        [
          "organization_id",
          {
            editType: "text" as const,
            options: [],
          },
        ],
      ]),
    []
  );
  const startTransition: React.TransitionStartFunction = (callback) => {
    void callback();
  };

  const { inlineEdit, startInlineEdit, updateInlineEditValue, commitInlineEdit } =
    useInlineEdit({
      editConfigByKey,
      inlineEditEnabled: true,
      columnsByKey,
      resolvedResourceKey: "shipments",
      resolvedItems: baseItems,
      idKey: "id",
      t,
      toast: toastMock,
      startTransition,
      setRowOverrides,
    });

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          startInlineEdit(
            "1",
            {
              key: "organization_id",
              label: "Organization Id",
            },
            "121e5acf-103b-4e1d-9b4b-7326a4f3e25c"
          )
        }
      >
        Start
      </button>
      <button
        type="button"
        onClick={() => updateInlineEditValue("e2e-170320818206")}
      >
        SetInvalid
      </button>
      <button type="button" onClick={() => commitInlineEdit()}>
        Commit
      </button>
      <output data-testid="inline-status">{inlineEdit?.status ?? "none"}</output>
      <output data-testid="inline-error">{inlineEdit?.error ?? ""}</output>
      <output data-testid="row-overrides-count">
        {String(Object.keys(rowOverrides).length)}
      </output>
    </div>
  );
}

function InlineEditInferredUuidLabelStyleHarness() {
  const [rowOverrides, setRowOverrides] = React.useState<
    Record<string, Record<string, unknown>>
  >({});
  const editConfigByKey = React.useMemo(
    () =>
      new Map([
        [
          "organization id",
          {
            editType: "text" as const,
            options: [],
          },
        ],
      ]),
    []
  );
  const startTransition: React.TransitionStartFunction = (callback) => {
    void callback();
  };

  const { inlineEdit, startInlineEdit, updateInlineEditValue, commitInlineEdit } =
    useInlineEdit({
      editConfigByKey,
      inlineEditEnabled: true,
      columnsByKey: columnsByLabelStyleKey,
      resolvedResourceKey: "shipments",
      resolvedItems: labelStyleUuidItems,
      idKey: "id",
      t,
      toast: toastMock,
      startTransition,
      setRowOverrides,
    });

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          startInlineEdit(
            "1",
            {
              key: "organization id",
              label: "Organization Id",
            },
            "121e5acf-103b-4e1d-9b4b-7326a4f3e25c"
          )
        }
      >
        Start
      </button>
      <button
        type="button"
        onClick={() => updateInlineEditValue("e2e-170320818206")}
      >
        SetInvalid
      </button>
      <button type="button" onClick={() => commitInlineEdit()}>
        Commit
      </button>
      <output data-testid="inline-status">{inlineEdit?.status ?? "none"}</output>
      <output data-testid="inline-error">{inlineEdit?.error ?? ""}</output>
      <output data-testid="row-overrides-count">
        {String(Object.keys(rowOverrides).length)}
      </output>
    </div>
  );
}

beforeEach(() => {
  updateResourceMock.mockReset();
  toastMock.mockReset();
});

test("useInlineEdit rejects invalid uuid values before API submit", async () => {
  render(<InlineEditValidationHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "SetInvalid" }));
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));

  await waitFor(() => {
    expect(screen.getByTestId("inline-status")).toHaveTextContent("error");
  });

  expect(screen.getByTestId("inline-error")).toHaveTextContent(
    "Organization Id must be a valid UUID."
  );
  expect(updateResourceMock).not.toHaveBeenCalled();
  expect(toastMock).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Unable to save change.",
      tone: "warning",
    })
  );
});

test("useInlineEdit infers uuid validation for *_id text columns with uuid values", async () => {
  render(<InlineEditInferredUuidHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "SetInvalid" }));
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));

  await waitFor(() => {
    expect(screen.getByTestId("inline-status")).toHaveTextContent("error");
  });

  expect(screen.getByTestId("inline-error")).toHaveTextContent(
    "Organization Id must be a valid UUID."
  );
  expect(updateResourceMock).not.toHaveBeenCalled();
  expect(toastMock).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Unable to save change.",
      tone: "warning",
    })
  );
});

test("useInlineEdit infers uuid validation for label-style keys ending in id", async () => {
  render(<InlineEditInferredUuidLabelStyleHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "SetInvalid" }));
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));

  await waitFor(() => {
    expect(screen.getByTestId("inline-status")).toHaveTextContent("error");
  });

  expect(screen.getByTestId("inline-error")).toHaveTextContent(
    "Organization Id must be a valid UUID."
  );
  expect(updateResourceMock).not.toHaveBeenCalled();
  expect(toastMock).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Unable to save change.",
      tone: "warning",
    })
  );
});

test("useInlineEdit normalizes backend uuid syntax errors", async () => {
  updateResourceMock.mockRejectedValueOnce({
    code: "22P02",
    message: 'invalid input syntax for type uuid: "e2e-170320818206"',
  });

  render(<InlineEditApiUuidErrorHarness />);

  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  fireEvent.click(screen.getByRole("button", { name: "SetInvalid" }));
  fireEvent.click(screen.getByRole("button", { name: "Commit" }));

  await waitFor(() => {
    expect(screen.getByTestId("inline-status")).toHaveTextContent("error");
  });

  expect(updateResourceMock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("inline-error")).toHaveTextContent(
    "Organization Id must be a valid UUID."
  );
  expect(toastMock).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "Unable to save change.",
      description: "Organization Id must be a valid UUID.",
      tone: "error",
    })
  );
});
