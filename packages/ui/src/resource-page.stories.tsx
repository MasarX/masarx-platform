import type { Meta, StoryObj } from "@storybook/react";

/**
 * ResourcePage is a server component that renders a full resource list page
 * with table, filters, detail panel, bulk actions, and import/export.
 *
 * It depends on server-only imports (createUiServerClient, getUiDefaults)
 * and cannot be rendered directly in Storybook. This entry documents its
 * API surface and composition pattern for reference.
 *
 * Key sub-components (each with their own stories):
 * - ResourceTable (client, table rendering)
 * - ResourceDetail (detail view)
 * - ResourceDetailPanel (split panel / drawer)
 * - ResourceFilterChips (applied filter pills)
 * - BulkActions (selection actions)
 * - PageHeader + PageContainer (layout)
 */

function ResourcePageDocumentation() {
  return (
    <div className="space-y-4 p-6 text-sm text-ui-ink">
      <h2 className="text-lg font-semibold">ResourcePage (Server Component)</h2>
      <p>
        Renders a full resource list page with server-fetched data, filters,
        table view, detail panel, and bulk actions.
      </p>
      <h3 className="font-semibold mt-4">Props</h3>
      <ul className="list-disc pl-5 space-y-1">
        <li><code>resourceKey</code> &mdash; The resource identifier (e.g. &quot;shipments&quot;)</li>
        <li><code>appKey</code> &mdash; Application identifier (&quot;console&quot; | &quot;portal&quot;)</li>
        <li><code>appBasePath</code> &mdash; URL base path for the application</li>
        <li><code>searchParams</code> &mdash; URL search parameters for filtering/pagination</li>
        <li><code>me</code> &mdash; Current user context (UiMe)</li>
        <li><code>testIdPrefix</code> &mdash; Test ID prefix for automation</li>
      </ul>
      <h3 className="font-semibold mt-4">Composition</h3>
      <pre className="bg-ui-highlight p-3 rounded text-xs overflow-auto">
{`<ResourcePage
  resourceKey="shipments"
  appKey="console"
  appBasePath="/console"
  searchParams={searchParams}
  me={me}
/>`}
      </pre>
    </div>
  );
}

const meta: Meta<typeof ResourcePageDocumentation> = {
  title: "Resource/ResourcePage",
  component: ResourcePageDocumentation,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Server component that renders a full resource list page. " +
          "Cannot be rendered in Storybook directly due to server-only dependencies. " +
          "See ResourceTable, ResourceDetail, and ResourceDetailPanel for interactive stories.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof ResourcePageDocumentation>;

export const Documentation: Story = {};
