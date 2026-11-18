import type { Meta, StoryObj } from "@storybook/react";

/**
 * ResourceTable is a complex client component that depends on Next.js router,
 * next-intl translations, and @masarx/api + @masarx/config at runtime.
 *
 * This documentation story captures the props surface and usage pattern
 * without triggering the heavy dependency tree in isolation.
 */

function ResourceTableDocumentation() {
  return (
    <div className="space-y-4 p-6 text-sm text-ui-ink">
      <h2 className="text-lg font-semibold">ResourceTable</h2>
      <p>
        Client-side data table with sorting, filtering, grouping, column
        management, inline editing, row selection, export, and keyboard navigation.
      </p>
      <h3 className="font-semibold mt-4">Key Props</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li><code>rows</code> &mdash; Array of data records</li>
        <li><code>columns</code> &mdash; Column definitions (ResourceColumn[])</li>
        <li><code>resourceKey</code> &mdash; Resource identifier</li>
        <li><code>totalCount</code> &mdash; Total row count for pagination</li>
        <li><code>idKey</code> &mdash; Primary key field name</li>
        <li><code>appBasePath</code> &mdash; Application base path</li>
        <li><code>views</code> &mdash; Saved table views</li>
        <li><code>detailOpenMode</code> &mdash; How detail opens (panel | page | modal)</li>
      </ul>
      <h3 className="font-semibold mt-4">Features</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li>Column reorder and visibility toggle</li>
        <li>Multi-column sort with direction indicators</li>
        <li>Advanced filter builder with operators</li>
        <li>Row grouping with aggregate summaries</li>
        <li>Inline cell editing (when write capability is present)</li>
        <li>Bulk selection with action bar</li>
        <li>CSV/JSON export</li>
        <li>Conditional formatting rules</li>
        <li>Client-side and server-side pagination</li>
      </ul>
      <h3 className="font-semibold mt-4">Usage</h3>
      <pre className="bg-ui-highlight p-3 rounded text-xs overflow-auto">
{`<ResourceTable
  rows={rows}
  columns={columns}
  resourceKey="shipments"
  totalCount={100}
  idKey="id"
  appBasePath="/console"
  detailOpenMode="panel"
/>`}
      </pre>
    </div>
  );
}

const meta: Meta<typeof ResourceTableDocumentation> = {
  title: "Resource/ResourceTable",
  component: ResourceTableDocumentation,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Full-featured data table with sorting, filtering, grouping, " +
          "inline editing, bulk selection, export, and conditional formatting. " +
          "Depends on Next.js router and next-intl at runtime.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourceTableDocumentation>;

export const Documentation: Story = {};
