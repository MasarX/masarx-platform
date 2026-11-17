jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: unknown }) => children,
  useTranslations:
    (namespace?: string) =>
    (key: string) =>
      namespace ? `${namespace}.${key}` : key,
  createTranslator:
    ({ namespace }: { namespace?: string } = {}) =>
    (key: string, values?: Record<string, unknown>) => {
      if (key === "ui.resourceDetail.sections.general") return "General";
      if (key === "ui.resourceDetail.internalIdLabel") return "Internal ID";
      if (key === "ui.resourceDetail.media.openImage") {
        return `Open image ${String(values?.index ?? "")}`.trim();
      }
      if (key === "ui.resourceDetail.media.openFile") {
        return `Open file ${String(values?.index ?? "")}`.trim();
      }
      if (key === "ui.resourceDetail.media.imagePreviewAlt") {
        return `${String(values?.label ?? "")} preview ${String(values?.index ?? "")}`.trim();
      }
      return namespace ? `${namespace}.${key}` : key;
    },
}));

jest.mock("../../packages/ui/src/i18n", () => ({
  createUiTranslator:
    (namespace?: string) =>
    (key: string, values?: Record<string, unknown>) => {
      const fullKey = namespace ? `${namespace}.${key}` : key;
      if (fullKey === "ui.resourceDetail.sections.general") return "General";
      if (fullKey === "ui.resourceDetail.internalIdLabel") return "Internal ID";
      if (fullKey === "ui.resourceDetail.media.openImage") {
        return `Open image ${String(values?.index ?? "")}`.trim();
      }
      if (fullKey === "ui.resourceDetail.media.openFile") {
        return `Open file ${String(values?.index ?? "")}`.trim();
      }
      if (fullKey === "ui.resourceDetail.media.imagePreviewAlt") {
        return `${String(values?.label ?? "")} preview ${String(values?.index ?? "")}`.trim();
      }
      return fullKey;
    },
}));

import { fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "../../packages/ui/src/use-toast";
import { ResourceDetail } from "../../packages/ui/src/resource-detail";

function renderDetail(ui: React.ReactElement) {
  return render(<ToastHost>{ui}</ToastHost>);
}

test("resource detail groups entries by section metadata", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        id: "ship_123",
        status: "ready",
        recipient_name: "Sam Doe",
      }}
      columns={[
        { key: "status", label: "Status", detailSection: "Shipment" },
        { key: "recipient_name", label: "Recipient", detailSection: "Contact" },
        { key: "id", label: "ID" },
      ]}
    />
  );

  expect(screen.getByText("Shipment")).toBeInTheDocument();
  expect(screen.getByText("Contact")).toBeInTheDocument();
  expect(screen.getByText("General")).toBeInTheDocument();
  expect(screen.getByText("Status")).toBeInTheDocument();
  expect(screen.getByText("Recipient")).toBeInTheDocument();
  expect(screen.getByText("ID")).toBeInTheDocument();
  expect(screen.getByText("ready")).toBeInTheDocument();
  expect(screen.getByText("Sam Doe")).toBeInTheDocument();
});

test("resource detail sections are collapsible", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{ id: "ship_123", status: "ready" }}
      columns={[
        { key: "status", label: "Status", detailSection: "Shipment" },
        { key: "id", label: "ID" },
      ]}
    />
  );

  const section = screen.getByText("Shipment").closest("details");
  if (!section) {
    throw new Error("Expected details section to render.");
  }
  expect(section).toHaveAttribute("open");
  const summary = section.querySelector("summary");
  if (!summary) {
    throw new Error("Expected section summary to render.");
  }
  fireEvent.click(summary);
  expect(section).not.toHaveAttribute("open");
});

test("resource detail favors business identifiers for UUID records", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
        tracking_number: "TESTB-62836344",
      }}
      columns={[
        { key: "id", label: "ID" },
        { key: "tracking_number", label: "Tracking Number" },
      ]}
    />
  );

  expect(screen.getAllByText("TESTB-62836344").length).toBeGreaterThan(0);
});

test("resource detail compacts long business identifiers and keeps full tooltip", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
        tracking_number: "LOAD-2-61-1770496616829",
      }}
      columns={[
        { key: "id", label: "ID" },
        { key: "tracking_number", label: "Tracking Number" },
      ]}
    />
  );

  const compact = screen.getAllByText("LOAD-2-61-...616829")[0];
  expect(compact).toBeInTheDocument();
  expect(compact?.closest("dd")).toHaveAttribute(
    "title",
    "LOAD-2-61-1770496616829"
  );
});

test("resource detail uses readable reference when only internal UUID is present", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      }}
      columns={[{ key: "id", label: "ID" }]}
    />
  );

  expect(screen.getAllByText("REF-E5E9E25C").length).toBeGreaterThan(0);
  expect(screen.queryByText("Internal ID: e5e9...e25c")).not.toBeInTheDocument();
});

test("resource detail formats UUID literals in non-id fields as readable references", () => {
  renderDetail(
    <ResourceDetail
      title="Workflow detail"
      data={{
        correlation_token: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      }}
      columns={[{ key: "correlation_token", label: "Correlation token" }]}
    />
  );

  expect(screen.getByText("REF-E5E9E25C")).toBeInTheDocument();
});

test("resource detail shows internal hints for UUID literals when enabled", () => {
  renderDetail(
    <ResourceDetail
      title="Workflow detail"
      data={{
        correlation_token: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
      }}
      columns={[{ key: "correlation_token", label: "Correlation token" }]}
      showInternalIdHints
    />
  );

  expect(screen.getByText("Internal ID: e5e9...e25c")).toBeInTheDocument();
});

test("resource detail summary surfaces descriptor text for operator context", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
        tracking_number: "TESTB-62836344",
        description: "Priority route handoff",
      }}
      columns={[
        { key: "id", label: "ID" },
        { key: "description", label: "Description" },
      ]}
    />
  );

  expect(screen.getAllByText("TESTB-62836344").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Priority route handoff").length).toBeGreaterThan(0);
});

test("resource detail renders proof-of-delivery media links and image preview", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        signature_url: "https://cdn.example.com/signature.png",
        pod_evidence: [
          { signed_url: "https://cdn.example.com/photo-1.jpg" },
          { signed_url: "https://cdn.example.com/photo-2.jpg" },
        ],
      }}
      columns={[
        {
          key: "signature_url",
          label: "Signature",
          detailSection: "Proof of delivery",
          renderType: "image",
        },
        {
          key: "pod_evidence",
          label: "Evidence",
          detailSection: "Proof of delivery",
          renderType: "media",
        },
      ]}
    />
  );

  expect(screen.getByText("Proof Of Delivery")).toBeInTheDocument();
  const mediaLinks = screen
    .getAllByRole("link")
    .map((link) => link.getAttribute("href"));
  expect(mediaLinks).toEqual(
    expect.arrayContaining([
      "https://cdn.example.com/signature.png",
      "https://cdn.example.com/photo-1.jpg",
      "https://cdn.example.com/photo-2.jpg",
    ])
  );
  expect(
    screen.getByRole("img", { name: "Signature preview 1" })
  ).toBeInTheDocument();
});

test("resource detail renders delivery handover visibility fields", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment action detail"
      data={{
        handover_mode: "mailroom",
        recipient_name: "Faisal QA",
        recipient_class: "mailroom",
        completion_notes: "Accepted by the building mailroom team.",
      }}
      columns={[
        {
          key: "handover_mode",
          label: "Handover mode",
          detailSection: "Delivery handover",
        },
        {
          key: "recipient_name",
          label: "Recipient",
          detailSection: "Delivery handover",
        },
        {
          key: "recipient_class",
          label: "Recipient class",
          detailSection: "Delivery handover",
        },
        {
          key: "completion_notes",
          label: "Completion notes",
          detailSection: "Delivery handover",
        },
      ]}
    />
  );

  expect(screen.getByText("Delivery Handover")).toBeInTheDocument();
  expect(screen.getByText("Handover mode")).toBeInTheDocument();
  expect(screen.getByText("Recipient")).toBeInTheDocument();
  expect(screen.getByText("Recipient class")).toBeInTheDocument();
  expect(screen.getByText("Completion notes")).toBeInTheDocument();
  expect(screen.getAllByText("mailroom").length).toBeGreaterThan(0);
  expect(screen.getByText("Faisal QA")).toBeInTheDocument();
  expect(
    screen.getByText("Accepted by the building mailroom team.")
    ).toBeInTheDocument();
});

test("resource detail renders payment collection visibility fields", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment action detail"
      data={{
        expected_amount: 150,
        cod_currency: "SAR",
        payment_mode_label: "Card or cash",
        payment_collection: {
          collection_required: true,
          allowed_methods: ["cash", "card"],
          payment_mode_label: "Card or cash",
        },
      }}
      columns={[
        {
          key: "expected_amount",
          label: "Expected amount",
          detailSection: "Payment collection",
        },
        {
          key: "cod_currency",
          label: "Currency",
          detailSection: "Payment collection",
        },
        {
          key: "payment_mode_label",
          label: "Payment mode",
          detailSection: "Payment collection",
        },
        {
          key: "payment_collection",
          label: "Collection payload",
          detailSection: "Payment collection",
        },
      ]}
    />
  );

  expect(screen.getByText("Payment Collection")).toBeInTheDocument();
  expect(screen.getByText("Expected amount")).toBeInTheDocument();
  expect(screen.getByText("Currency")).toBeInTheDocument();
  expect(screen.getByText("Payment mode")).toBeInTheDocument();
  expect(screen.getByText("150")).toBeInTheDocument();
  expect(screen.getByText("SAR")).toBeInTheDocument();
  expect(screen.getAllByText("Card or cash").length).toBeGreaterThan(0);
  expect(screen.getByText(/allowed_methods/i)).toBeInTheDocument();
});

test("resource detail renders partial delivery completion visibility fields", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment action detail"
      data={{
        delivery_completion_kind: "partial",
        delivered_box_count: 2,
        remaining_box_count: 1,
      }}
      columns={[
        {
          key: "delivery_completion_kind",
          label: "Completion kind",
          detailSection: "Delivery completion",
        },
        {
          key: "delivered_box_count",
          label: "Delivered boxes",
          detailSection: "Delivery completion",
        },
        {
          key: "remaining_box_count",
          label: "Remaining boxes",
          detailSection: "Delivery completion",
        },
      ]}
    />
  );

  expect(screen.getByText("Delivery Completion")).toBeInTheDocument();
  expect(screen.getByText("Completion kind")).toBeInTheDocument();
  expect(screen.getByText("Delivered boxes")).toBeInTheDocument();
  expect(screen.getByText("Remaining boxes")).toBeInTheDocument();
  expect(screen.getByText("partial")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument();
  expect(screen.getByText("1")).toBeInTheDocument();
});

test("resource detail shows internal id hints when explicitly enabled via prop", () => {
  renderDetail(
    <ResourceDetail
      title="Shipment detail"
      data={{
        id: "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c",
        tracking_number: "TESTB-62836344",
      }}
      columns={[
        { key: "id", label: "ID" },
        { key: "tracking_number", label: "Tracking Number" },
      ]}
      showInternalIdHints
    />
  );

  expect(screen.getAllByText("Internal ID: e5e9...e25c").length).toBeGreaterThan(
    0
  );
});
