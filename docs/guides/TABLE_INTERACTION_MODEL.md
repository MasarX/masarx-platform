# Table Interaction Model

Notion-style table UI interaction model for the `@masarx/ui` resource table system.

--

## Component Architecture

```
ResourceTable
  ViewBar
    FilterChips          // active filter/sort/group chips
    SearchBox, ColumnPanel, etc.
  Viewport (thead + tbody)
    HeaderRow
      ColumnHeaderMenu   // per-column sort/hide/pin/autoWidth dropdown
    TableBody            // rows + empty states + create row
    SummaryRow
      CalculationPopover // per-column aggregation dropdown
  InlineEditor           // cell-level edit overlay
```

All components receive a `t: TranslateFn` for i18n; translation keys live in `packages/config/messages/en.json` under `table.*`, `viewBar.*`, `columnMenu.*`, `calculation.*`, and `edit.*`.

--

## FilterChips

Renders active view filters as removable pill chips.

- **Source:** `packages/ui/src/table/filter-chips.tsx`
- **Props:** `chips: ChipItem[]`, `onRemove`, `onClearAll?`
- **ChipItem type:** `{ id, label, detail?, type: "filter" | "sort" | "group" }`
- Chip color resolves from `type` via `chipTypeColor` map (accent/info/success).
- "Clear All" button appears when `chips.length > 1` **and** `onClearAll` is provided.
- Returns `null` for empty chips array (no DOM output).
- **Tests:** `tests/ui/table-filter-chips.test.tsx`

--

## ColumnHeaderMenu

Radix dropdown menu for per-column actions, triggered from the header row.

- **Source:** `packages/ui/src/table/column-header-menu.tsx`
- **Props:** `column: ResourceColumn`, `isPinned`, `onAction(action, columnKey)`, `trigger`
- **Actions:** `sortAsc`, `sortDesc`, `hide`, `pin`/`unpin`, `autoWidth`
- Pin/unpin text toggles based on `isPinned` prop.
- Column label resolves via `resolveColumnLabel(column)`.
- **Tests:** `tests/ui/table-column-header-menu.test.tsx`

--

## CalculationPopover

Radix dropdown for selecting per-column aggregation in the summary row.

- **Source:** `packages/ui/src/table/calculation-popover.tsx`
- **Props:** `columnKey`, `selected: AggregationType`, `onSelect(columnKey, type)`, `children` (trigger)
- **AggregationType:** `"count" | "sum" | "avg" | "min" | "max" | "median" | "none"`
- Selected option gets `font-medium text-ui-accent` styling.
- **Tests:** `tests/ui/table-calculation-popover.test.tsx`

--

## InlineEditor

Cell-level edit overlay supporting multiple field types and keyboard navigation.

- **Source:** `packages/ui/src/table/inline-editor.tsx`
- **Types:** `InlineEditState`, `EditConfig` from `packages/ui/src/table/editing.ts`
- **Props:** `editState`, `editConfig`, `editLabel`, `editPending`, `onUpdateValue`, `onCommit`, `onCancel`

### Keyboard Flow

| Key | Behavior |
|-----|----------|
| Escape | Cancel edit (`onCancel`) |
| Enter | Commit edit (`onCommit`) |
| Shift+Enter | No-op (allows multiline in textarea) |

### Field Types

| `editType` | Rendered Element | Notes |
|------------|-----------------|-------|
| `text` | `<input type="text">` | Default |
| `number` | `<input type="number">` | |
| `date` | `<input type="date">` | |
| `datetime` | `<input type="datetime-local">` | |
| `uuid` | `<input type="text">` | Monospace font, UUID placeholder |
| `boolean` | `<Checkbox>` | Auto-commits on change |
| `select` | `<Combobox mode="single">` | Auto-commits on selection |
| `multiselect` | `<Combobox mode="multi">` | |
| `textarea` | `<Textarea>` | |

### Error / Loading States

- `status: "saving"` or `editPending: true` disables the input.
- `status: "error"` shows error message (falls back to `edit.error` key).
- UUID type shows `edit.uuidHint` helper text below the input.

- **Tests:** `tests/ui/table-inline-editor.test.tsx`

--

## Empty States (TableBody)

Three distinct empty state variants rendered inside `<tbody>`.

- **Source:** `packages/ui/src/table/body.tsx`

| Condition | Icon | Title Key | Description Key |
|-----------|------|-----------|-----------------|
| `noColumnsSelected` | NoColumnsIcon | `table.noColumns` | `table.noColumnsHint` |
| `isEmpty && !clientFilterActive` | EmptyTableIcon | `table.noRecords` | `table.noRecordsHint` |
| `isEmpty && clientFilterActive` | EmptySearchIcon | `table.noSearchResults` | `table.noSearchResultsHint` |

- `emptyMessage` prop overrides the default "no records" title.
- `emptyAction` / `noColumnsAction` render optional action buttons in the empty state.
- When data rows are present and `onCreateRow` is provided, a "+" create row button appears below the last row.

- **Tests:** `tests/ui/table-body-empty-states.test.tsx`

--

## Testing

### Run Tests

```bash
# Individual component
npx jest --config config/tooling/jest.config.ui.js tests/ui/table-filter-chips.test.tsx

# All table tests
npx jest --config config/tooling/jest.config.ui.js --testPathPattern table

# Full UI suite
npm run test:ui
```

### Patterns

- Use `renderWithIntl` from `tests/ui/test-utils.tsx` for components that need `next-intl` context.
- Use plain `render` from `@testing-library/react` for components that take `t: TranslateFn` directly.
- For Radix dropdown components, use `userEvent.setup()` + `findByRole("menuitem")` to handle portal rendering.
- For `TableBody`, wrap in `<table>` to satisfy DOM nesting requirements.
- Use `t: TranslateFn = (key) => key` stub for unit tests — assertions match translation keys directly.
