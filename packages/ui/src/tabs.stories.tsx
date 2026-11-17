import type { Meta, StoryObj } from "@storybook/react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";

const meta: Meta<typeof Tabs> = {
  title: "Feedback/Tabs",
  component: Tabs
};

export default meta;
type Story = StoryObj<typeof Tabs>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-full">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="alerts">Alerts</TabsTrigger>
      </TabsList>
      <TabsContent value="overview">
        <div className="text-sm text-ui-muted">
          Overview summary metrics and KPI cards.
        </div>
      </TabsContent>
      <TabsContent value="activity">
        <div className="text-sm text-ui-muted">
          Latest workflow events and transitions.
        </div>
      </TabsContent>
      <TabsContent value="alerts">
        <div className="text-sm text-ui-muted">
          Escalations that need review.
        </div>
      </TabsContent>
    </Tabs>
  )
};
