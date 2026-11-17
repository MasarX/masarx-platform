import type { Meta, StoryObj } from "@storybook/react";
import { HashTabs } from "./hash-tabs";
import { TabsList, TabsTrigger, TabsContent } from "./tabs";

const meta: Meta<typeof HashTabs> = {
  title: "Forms/HashTabs",
  component: HashTabs
};

export default meta;
type Story = StoryObj<typeof HashTabs>;

export const Default: Story = {
  render: () => (
    <HashTabs defaultValue="tab1" className="w-full">
      <TabsList>
        <TabsTrigger value="tab1">General</TabsTrigger>
        <TabsTrigger value="tab2">Settings</TabsTrigger>
        <TabsTrigger value="tab3">Advanced</TabsTrigger>
      </TabsList>
      <TabsContent value="tab1">
        <div className="text-sm text-ui-muted">
          General configuration and overview.
        </div>
      </TabsContent>
      <TabsContent value="tab2">
        <div className="text-sm text-ui-muted">
          Notification and display settings.
        </div>
      </TabsContent>
      <TabsContent value="tab3">
        <div className="text-sm text-ui-muted">
          Advanced options for power users.
        </div>
      </TabsContent>
    </HashTabs>
  )
};

export const WithHashMapping: Story = {
  render: () => (
    <HashTabs
      defaultValue="overview"
      hashToValue={{ info: "overview", log: "activity", warn: "alerts" }}
      valueToHash={{ overview: "info", activity: "log", alerts: "warn" }}
      className="w-full"
    >
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="alerts">Alerts</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <div className="text-sm text-ui-muted">
          Overview panel synced via #info hash.
        </div>
      </TabsContent>
      <TabsContent value="activity">
        <div className="text-sm text-ui-muted">
          Activity log synced via #log hash.
        </div>
      </TabsContent>
      <TabsContent value="alerts">
        <div className="text-sm text-ui-muted">
          Alerts synced via #warn hash.
        </div>
      </TabsContent>
    </HashTabs>
  )
};
