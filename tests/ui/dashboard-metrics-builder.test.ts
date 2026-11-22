import {
  buildKpiCards,
  buildStatusDonut,
} from "../../packages/ui/src/dashboard-metrics-builder";

const mockT = (key: string) => key;

describe("buildKpiCards", () => {
  it("computes KPI cards from resource counts", () => {
    const counts = new Map<string, number | null>([
      ["shipments", 100],
      ["in_transit", 20],
      ["out_for_delivery", 10],
      ["exceptions", 5],
      ["delivered", 80],
    ]);

    const cards = buildKpiCards(counts, mockT);

    expect(cards).toHaveLength(4);
    expect(cards[0]).toMatchObject({
      title: "metricsTotalShipments",
      value: "100",
      tone: "neutral",
    });
    expect(cards[1]).toMatchObject({
      title: "metricsActiveDeliveries",
      value: "30",
      tone: "success",
    });
    expect(cards[2]).toMatchObject({
      title: "metricsPendingExceptions",
      value: "5",
      tone: "warning",
    });
    expect(cards[3]).toMatchObject({
      title: "metricsDeliveryRate",
      value: "80%",
      tone: "warning",
    });
  });

  it("handles empty counts gracefully", () => {
    const counts = new Map<string, number | null>();
    const cards = buildKpiCards(counts, mockT);

    expect(cards).toHaveLength(4);
    expect(cards[0].value).toBe("0");
    expect(cards[3].value).toBe("0%");
  });

  it("handles null counts", () => {
    const counts = new Map<string, number | null>([
      ["shipments", null],
      ["in_transit", null],
    ]);
    const cards = buildKpiCards(counts, mockT);

    expect(cards[0].value).toBe("0");
    expect(cards[1].value).toBe("0");
  });

  it("applies warning tone for exceptions > 0", () => {
    const counts = new Map<string, number | null>([["exceptions", 3]]);
    const cards = buildKpiCards(counts, mockT);
    const exceptionsCard = cards.find((c) => c.title === "metricsPendingExceptions");
    expect(exceptionsCard?.tone).toBe("warning");
  });

  it("applies neutral tone when exceptions is 0", () => {
    const counts = new Map<string, number | null>([["exceptions", 0]]);
    const cards = buildKpiCards(counts, mockT);
    const exceptionsCard = cards.find((c) => c.title === "metricsPendingExceptions");
    expect(exceptionsCard?.tone).toBe("neutral");
  });

  it("computes delivery rate with correct rounding", () => {
    const counts = new Map<string, number | null>([
      ["shipments", 3],
      ["delivered", 2],
    ]);
    const cards = buildKpiCards(counts, mockT);
    expect(cards[3].value).toBe("67%");
  });

  it("applies danger tone for low delivery rate", () => {
    const counts = new Map<string, number | null>([
      ["shipments", 10],
      ["delivered", 5],
    ]);
    const cards = buildKpiCards(counts, mockT);
    expect(cards[3].tone).toBe("danger");
  });

  it("applies warning tone for medium delivery rate", () => {
    const counts = new Map<string, number | null>([
      ["shipments", 10],
      ["delivered", 8],
    ]);
    const cards = buildKpiCards(counts, mockT);
    expect(cards[3].tone).toBe("warning");
  });
});

describe("buildStatusDonut", () => {
  it("builds donut segments from resource counts", () => {
    const counts = new Map<string, number | null>([
      ["delivered", 80],
      ["in_transit", 15],
      ["out_for_delivery", 5],
      ["exceptions", 3],
      ["pending", 2],
    ]);

    const { segments, total } = buildStatusDonut(counts, mockT);

    expect(segments).toHaveLength(5);
    expect(total).toBe(105);
    expect(segments[0]).toMatchObject({ name: "metricsStatusDelivered", value: 80 });
    expect(segments[1]).toMatchObject({ name: "metricsStatusInTransit", value: 15 });
  });

  it("omits segments with zero values", () => {
    const counts = new Map<string, number | null>([
      ["delivered", 10],
      ["in_transit", 0],
      ["exceptions", 0],
    ]);

    const { segments, total } = buildStatusDonut(counts, mockT);

    expect(segments).toHaveLength(1);
    expect(total).toBe(10);
  });

  it("returns empty segments for empty counts", () => {
    const counts = new Map<string, number | null>();
    const { segments, total } = buildStatusDonut(counts, mockT);

    expect(segments).toHaveLength(0);
    expect(total).toBe(0);
  });

  it("assigns colors to segments", () => {
    const counts = new Map<string, number | null>([["delivered", 5]]);
    const { segments } = buildStatusDonut(counts, mockT);

    expect(segments[0].color).toBeDefined();
    expect(segments[0].color).toContain("--ui-success");
  });
});
