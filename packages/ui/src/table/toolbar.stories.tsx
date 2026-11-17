import type { Meta, StoryObj } from "@storybook/react";
import { TableToolbar } from "./toolbar";
import type { TranslateFn } from "./types";

const noop = () => {};

const mockT: TranslateFn = (key, values) => {
  if (values) return `${key} ${JSON.stringify(values)}`;
  return key;
};

const meta: Meta<typeof TableToolbar> = {
  title: "Table/Toolbar",
  component: TableToolbar,
  args: {
    t: mockT,
    searchTerm: "",
    onSearchChange: noop,
    onSearchClear: noop,
    searchDebounceMs: 300,
    searchDebounceOptions: [300],
    onSearchDebounceChange: noop,
    clientFilterActive: false,
    filteredCount: 25,
    totalCount: 25,
    clientPaginationEnabled: false,
    resolvedClientPage: 1,
    totalClientPages: 1,
    canPageBack: false,
    canPageForward: false,
    showPageControls: false,
    pageInput: "1",
    onPageInputChange: noop,
    onPageInputBlur: noop,
    onFirstPage: noop,
    onPrevPage: noop,
    onNextPage: noop,
    onLastPage: noop,
  },
};

export default meta;
type Story = StoryObj<typeof TableToolbar>;

export const Default: Story = {};

export const WithSearch: Story = {
  args: {
    searchTerm: "hello",
  },
};

export const WithPagination: Story = {
  args: {
    clientPaginationEnabled: true,
    showPageControls: true,
    resolvedClientPage: 2,
    totalClientPages: 5,
    canPageBack: true,
    canPageForward: true,
    filteredCount: 50,
    totalCount: 50,
    pageSummaryLabel: "11-20 of 50",
    pageInput: "2",
  },
};
