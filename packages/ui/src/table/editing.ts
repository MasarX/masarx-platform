export type InlineEditType =
  | "text"
  | "number"
  | "uuid"
  | "boolean"
  | "select"
  | "multiselect"
  | "date"
  | "datetime"
  | "textarea";

export type InlineEditState = {
  rowId: string;
  columnKey: string;
  editType: InlineEditType;
  value: string | boolean | string[];
  status: "idle" | "saving" | "error";
  error?: string | null;
};

export type SelectOption = {
  label: string;
  value: string;
};

export type EditConfig = {
  editType: InlineEditType;
  options: SelectOption[];
};
