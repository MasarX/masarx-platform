import type { Meta, StoryObj } from "@storybook/react";
import { TableColumnPanel } from "./column-panel";
import type { TranslateFn } from "./types";
import type { ResourceColumn } from "./columns";

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const sampleColumns: ResourceColumn[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "status", label: "Status" },
  { key: "created_at", label: "Created At" },
];

const noop = () => {};
const noopDrag = () => ((_event: React.DragEvent) => {}) as (event: React.DragEvent) => void;

const baseArgs = {
  t: mockT,
  columnFilter: "",
  onColumnFilterChange: noop,
  onColumnFilterClear: noop,
  onShowAllColumns: noop,
  onHideAllColumns: noop,
  filteredColumns: sampleColumns,
  columnOrder: ["name", "email", "status", "created_at"],
  columnWidths: {} as Record<string, number>,
  draggingColumn: null,
  dragOverColumn: null,
  onDragStart: noopDrag,
  onDragOver: noopDrag,
  onDrop: noopDrag,
  onDragEnd: noop as () => void,
  onToggleColumn: noop,
  onTogglePin: noop,
  onUpdateWidth: noop,
  onMoveColumn: noop,
  minColumnWidth: 60,
  resizeStep: 10,
  rowDensity: "comfortable" as const,
  onRowDensityChange: noop,
  openMode: "peek" as const,
  onOpenModeChange: noop,
  showRowNumbers: false,
  onShowRowNumbersChange: noop,
  showInternalIdHints: false,
  onShowInternalIdHintsChange: noop,
  analyticsEnabled: false,
  onAnalyticsToggle: noop,
  summaryRowEnabled: false,
  onSummaryRowToggle: noop,
  paginationModeOptions: ["client" as const, "server" as const],
  paginationMode: "client" as const,
  onPaginationModeChange: noop,
  pageSize: 25,
  pageSizeOptions: [10, 25, 50, 100],
  onPageSizeChange: noop,
};

const meta: Meta<typeof TableColumnPanel> = {
  title: "Table/ColumnPanel",
  component: TableColumnPanel,
  args: {
    ...baseArgs,
    visibleColumns: new Set(["name", "email", "status", "created_at"]),
    pinnedSet: new Set<string>(),
  },
};

export default meta;
type Story = StoryObj<typeof TableColumnPanel>;

export const Default: Story = {};

export const WithHiddenColumns: Story = {
  args: {
    visibleColumns: new Set(["name", "status"]),
    pinnedSet: new Set<string>(),
  },
};

export const WithPinnedColumn: Story = {
  args: {
    visibleColumns: new Set(["name", "email", "status", "created_at"]),
    pinnedSet: new Set(["name"]),
  },
};
