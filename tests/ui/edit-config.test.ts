import { buildEditConfigByKey } from "../../packages/ui/src/table/edit-config";
import type { ResourceColumn } from "../../packages/ui/src/table/columns";

describe("buildEditConfigByKey", () => {
  it("does not allow implicit uuid editing for id-like columns", () => {
    const columns: ResourceColumn[] = [
      {
        key: "organization_id",
        label: "Organization Id",
        editMode: "inline",
        renderType: "id",
      },
    ];

    const config = buildEditConfigByKey(columns, true, new Set<string>());

    expect(config.has("organization_id")).toBe(false);
  });

  it("allows id-like editing when editAllowId is enabled", () => {
    const columns: ResourceColumn[] = [
      {
        key: "organization_id",
        label: "Organization Id",
        editMode: "inline",
        renderType: "id",
        editAllowId: true,
      },
    ];

    const config = buildEditConfigByKey(columns, true, new Set<string>());

    expect(config.get("organization_id")).toEqual({
      editType: "uuid",
      options: [],
    });
  });

  it("blocks explicit uuid edit type without editAllowId", () => {
    const columns: ResourceColumn[] = [
      {
        key: "client_id",
        label: "Client Id",
        editMode: "inline",
        editType: "uuid",
      },
    ];

    const config = buildEditConfigByKey(columns, true, new Set<string>());

    expect(config.has("client_id")).toBe(false);
  });

  it("keeps explicit uuid edit type when editAllowId is enabled", () => {
    const columns: ResourceColumn[] = [
      {
        key: "client_id",
        label: "Client Id",
        editMode: "inline",
        editType: "uuid",
        editAllowId: true,
      },
    ];

    const config = buildEditConfigByKey(columns, true, new Set<string>());

    expect(config.get("client_id")).toEqual({
      editType: "uuid",
      options: [],
    });
  });

  it("blocks label-style id columns without editAllowId", () => {
    const columns: ResourceColumn[] = [
      {
        key: "organization id",
        label: "Organization Id",
        editMode: "inline",
        editType: "text",
      },
    ];

    const config = buildEditConfigByKey(columns, true, new Set<string>());

    expect(config.has("organization id")).toBe(false);
  });

  it("does not allow inline editing for primary id column", () => {
    const columns: ResourceColumn[] = [
      {
        key: "id",
        label: "ID",
        editMode: "inline",
        editType: "uuid",
      },
      {
        key: "status",
        label: "Status",
        editMode: "inline",
        editType: "text",
      },
    ];

    const config = buildEditConfigByKey(columns, true, new Set<string>());

    expect(config.has("id")).toBe(false);
    expect(config.get("status")).toEqual({
      editType: "text",
      options: [],
    });
  });
});
