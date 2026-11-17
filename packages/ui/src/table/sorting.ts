export type SortDirection = "asc" | "desc";

export type SortState = {
  key: string;
  direction: SortDirection;
};

export type SortStateInput = {
  key: string;
  direction?: string | null;
};

export type SortInput =
  | SortState
  | SortState[]
  | SortStateInput
  | SortStateInput[]
  | null
  | undefined;
