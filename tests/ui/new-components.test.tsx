/**
 * Tests for new frontend enhancement components (Phases 1-22).
 * Covers: Badge, Skeleton, ActivityTimeline, KpiCard, KanbanBoard,
 * OnboardingChecklist, CodReconciliation, MobileCardView, NotificationCenter.
 */

import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { DashboardMetricsSkeleton } from "../../packages/ui/src/dashboard-metrics-skeleton";
import { ResourceDetailSkeleton } from "../../packages/ui/src/resource-detail-skeleton";

// ── Badge ──

describe("Badge", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Badge } = require("@masarx/ui/client");

  test("renders with default neutral tone and md size", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  test("renders dot indicator when dot prop is true", () => {
    const { container } = render(<Badge dot tone="success">OK</Badge>);
    const dots = container.querySelectorAll(".rounded-full");
    // Badge itself is rounded-full + dot is rounded-full
    expect(dots.length).toBeGreaterThanOrEqual(2);
  });

  test("renders sm size with smaller padding", () => {
    const { container } = render(<Badge size="sm">Small</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain("py-0.5");
  });

  test("renders lg size with larger padding", () => {
    const { container } = render(<Badge size="lg">Large</Badge>);
    const badge = container.firstChild as HTMLElement;
    expect(badge.className).toContain("py-1.5");
  });
});

// ── Skeleton ──

describe("Skeleton", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Skeleton } = require("@masarx/ui/client");

  test("renders with shimmer class", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("ui-shimmer");
  });

  test("has aria-label for accessibility", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("aria-label")).toBe("Loading");
  });

  test("has role=status for screen readers", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el.getAttribute("role")).toBe("status");
  });

  test("applies custom className", () => {
    const { container } = render(<Skeleton className="h-8 w-32" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain("h-8");
    expect(el.className).toContain("w-32");
  });

  test.each([
    { label: "Loading metrics", Component: DashboardMetricsSkeleton },
    { label: "Loading details", Component: ResourceDetailSkeleton },
  ])("exposes one busy status for $label", ({ label, Component }) => {
    render(<Component />);

    const status = screen.getByRole("status", { name: label });
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("status", { hidden: true })).toEqual([status]);
  });
});

// ── ActivityTimeline ──

describe("ActivityTimeline", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ActivityTimeline } = require("@masarx/ui/client");

  test("renders empty message when no entries", () => {
    render(<ActivityTimeline entries={[]} />);
    expect(screen.getByText("No activity recorded.")).toBeInTheDocument();
  });

  test("renders custom empty message", () => {
    render(<ActivityTimeline entries={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  test("renders timeline entries with labels", () => {
    const entries = [
      { id: "1", timestamp: new Date().toISOString(), type: "created", label: "Shipment created", tone: "success" as const },
      { id: "2", timestamp: new Date().toISOString(), type: "dispatched", label: "Dispatched", tone: "info" as const },
    ];
    render(<ActivityTimeline entries={entries} />);
    expect(screen.getByText("Shipment created")).toBeInTheDocument();
    expect(screen.getByText("Dispatched")).toBeInTheDocument();
  });

  test("shows actor name when provided", () => {
    const entries = [
      { id: "1", timestamp: new Date().toISOString(), type: "created", actor: "John Doe" },
    ];
    render(<ActivityTimeline entries={entries} />);
    expect(screen.getByText("John Doe")).toBeInTheDocument();
  });
});

// ── KpiCard ──

describe("KpiCard", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KpiCard } = require("@masarx/ui/client");

  test("renders title and value", () => {
    render(<KpiCard title="Shipments" value={42} />);
    expect(screen.getByText("Shipments")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  test("shows positive change with + prefix", () => {
    render(<KpiCard title="Revenue" value="$10K" change={12} />);
    expect(screen.getByText("+12%")).toBeInTheDocument();
  });

  test("shows negative change without + prefix", () => {
    render(<KpiCard title="Errors" value={5} change={-8} />);
    expect(screen.getByText("-8%")).toBeInTheDocument();
  });

  test("handles null change gracefully", () => {
    render(<KpiCard title="Test" value={0} />);
    // Should not crash and should render title/value without change indicator
    expect(screen.getByText("Test")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
    // No percentage should be visible
    expect(screen.queryByText(/%/)).toBeNull();
  });
});

// ── KanbanBoard ──

describe("KanbanBoard", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KanbanBoard } = require("@masarx/ui/client");

  const columns = [
    { id: "pending", title: "Pending", tone: "neutral" as const, cards: [
      { id: "1", title: "Ship-001", subtitle: "Riyadh" },
    ]},
    { id: "transit", title: "In Transit", tone: "info" as const, cards: [] },
    { id: "delivered", title: "Delivered", tone: "success" as const, cards: [] },
  ];

  test("renders all columns", () => {
    render(<KanbanBoard columns={columns} />);
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("In Transit")).toBeInTheDocument();
    expect(screen.getByText("Delivered")).toBeInTheDocument();
  });

  test("renders cards in correct columns", () => {
    render(<KanbanBoard columns={columns} />);
    expect(screen.getByText("Ship-001")).toBeInTheDocument();
    expect(screen.getByText("Riyadh")).toBeInTheDocument();
  });

  test("shows empty message for columns with no cards", () => {
    render(<KanbanBoard columns={columns} />);
    const emptyTexts = screen.getAllByText("No items");
    expect(emptyTexts.length).toBe(2); // transit + delivered
  });

  test("calls onCardClick when card is clicked", () => {
    const onClick = jest.fn();
    render(<KanbanBoard columns={columns} onCardClick={onClick} />);
    fireEvent.click(screen.getByText("Ship-001"));
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "1", title: "Ship-001" }),
      "pending"
    );
  });
});

// ── OnboardingChecklist ──

describe("OnboardingChecklist", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OnboardingChecklist } = require("@masarx/ui/client");

  const steps = [
    { id: "1", title: "Create profile", completed: true },
    { id: "2", title: "Add first client", completed: false, description: "Set up your first client account" },
    { id: "3", title: "Create shipment", completed: false },
  ];

  test("renders all steps", () => {
    render(<OnboardingChecklist steps={steps} />);
    expect(screen.getByText("Create profile")).toBeInTheDocument();
    expect(screen.getByText("Add first client")).toBeInTheDocument();
    expect(screen.getByText("Create shipment")).toBeInTheDocument();
  });

  test("shows correct progress count", () => {
    render(<OnboardingChecklist steps={steps} />);
    expect(screen.getByText("1 of 3 steps completed")).toBeInTheDocument();
  });

  test("shows all done message when complete", () => {
    const allDone = steps.map((s) => ({ ...s, completed: true }));
    render(<OnboardingChecklist steps={allDone} />);
    expect(screen.getByText("All steps completed!")).toBeInTheDocument();
  });

  test("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = jest.fn();
    render(<OnboardingChecklist steps={steps} onDismiss={onDismiss} />);
    const dismissBtn = screen.getByLabelText("Dismiss onboarding checklist");
    fireEvent.click(dismissBtn);
    expect(onDismiss).toHaveBeenCalled();
  });
});

// ── CodReconciliation ──

describe("CodReconciliation", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CodReconciliation } = require("@masarx/ui/client");

  const entries = [
    { id: "1", orderId: "ORD-001", expectedAmount: 100, collectedAmount: 100, currency: "SAR", status: "matched" as const },
    { id: "2", orderId: "ORD-002", expectedAmount: 200, collectedAmount: 150, currency: "SAR", status: "short" as const },
  ];

  test("renders order IDs", () => {
    render(<CodReconciliation entries={entries} />);
    expect(screen.getByText("ORD-001")).toBeInTheDocument();
    expect(screen.getByText("ORD-002")).toBeInTheDocument();
  });

  test("calculates total expected correctly", () => {
    render(<CodReconciliation entries={entries} />);
    expect(screen.getByText("300 SAR")).toBeInTheDocument(); // 100 + 200
  });

  test("shows variance with sign", () => {
    render(<CodReconciliation entries={entries} />);
    // Total collected: 250, expected: 300, variance: -50
    expect(screen.getByText("-50 SAR")).toBeInTheDocument();
  });
});

// ── MobileCardView ──

describe("MobileCardView", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { MobileCardView } = require("@masarx/ui/client");

  const items = [
    {
      id: "1",
      title: "Shipment DLX-001",
      subtitle: "Riyadh → Jeddah",
      fields: [
        { key: "status", label: "Status", value: "In Transit", isBadge: true, tone: "info" as const },
        { key: "tracking", label: "Tracking", value: "DLX001" },
        { key: "eta", label: "ETA", value: "Apr 15" },
        { key: "weight", label: "Weight", value: "2.5 kg" },
      ],
    },
  ];

  test("renders item title and subtitle", () => {
    render(<MobileCardView items={items} />);
    expect(screen.getByText("Shipment DLX-001")).toBeInTheDocument();
    expect(screen.getByText("Riyadh → Jeddah")).toBeInTheDocument();
  });

  test("shows preview fields (first 3)", () => {
    render(<MobileCardView items={items} />);
    expect(screen.getByText("In Transit")).toBeInTheDocument();
    expect(screen.getByText("DLX001")).toBeInTheDocument();
  });

  test("shows empty message when no items", () => {
    render(<MobileCardView items={[]} />);
    expect(screen.getByText("No items found")).toBeInTheDocument();
  });

  test("shows custom empty message", () => {
    render(<MobileCardView items={[]} emptyMessage="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  test("expands card on click to show extra fields", () => {
    render(<MobileCardView items={items} />);
    fireEvent.click(screen.getByText("Shipment DLX-001"));
    // After expansion, the 4th field (Weight) should appear
    expect(screen.getByText("Weight")).toBeInTheDocument();
    expect(screen.getByText("2.5 kg")).toBeInTheDocument();
  });
});
