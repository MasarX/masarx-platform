import type { Meta, StoryObj } from "@storybook/react";
import { NotificationCenter, type Notification } from "./notification-center";

const meta: Meta<typeof NotificationCenter> = {
  title: "Feedback/NotificationCenter",
  component: NotificationCenter,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Bell icon with badge count and dropdown panel for notifications. " +
          "Supports mark-read, mark-all-read, and click-through to resources.",
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof NotificationCenter>;

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60000).toISOString();

const sampleNotifications: Notification[] = [
  {
    id: "n1",
    type: "shipment",
    title: "Shipment SH-100 delivered",
    body: "Package was delivered to the recipient in Riyadh.",
    resourceType: "shipments",
    resourceId: "sh_100",
    readAt: null,
    createdAt: minutesAgo(3),
  },
  {
    id: "n2",
    type: "exception",
    title: "Delivery exception on SH-101",
    body: "Address not found. Manual review required.",
    resourceType: "shipments",
    resourceId: "sh_101",
    readAt: null,
    createdAt: minutesAgo(15),
  },
  {
    id: "n3",
    type: "workflow",
    title: "Workflow run completed",
    body: "Auto-dispatch workflow processed 42 orders.",
    resourceType: "workflow_runs",
    resourceId: "wr_500",
    readAt: minutesAgo(10),
    createdAt: minutesAgo(45),
  },
  {
    id: "n4",
    type: "system",
    title: "System maintenance scheduled",
    body: "Planned downtime on April 15 from 02:00-04:00 UTC.",
    readAt: null,
    createdAt: minutesAgo(120),
  },
];

export const WithUnread: Story = {
  args: {
    notifications: sampleNotifications,
    unreadCount: 3,
    onMarkRead: () => {},
    onMarkAllRead: () => {},
    onNotificationClick: () => {},
  },
};

export const AllRead: Story = {
  args: {
    notifications: sampleNotifications.map((n) => ({
      ...n,
      readAt: n.readAt ?? now.toISOString(),
    })),
    unreadCount: 0,
    onMarkRead: () => {},
    onMarkAllRead: () => {},
  },
};

export const Empty: Story = {
  args: {
    notifications: [],
    unreadCount: 0,
  },
};
