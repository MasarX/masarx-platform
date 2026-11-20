import {
  formatMachineValueLabel,
  formatDisplayIdentifierValue,
  formatIdValue,
  formatReferenceValue,
  formatResourceValue,
  isHumanizableMachineValue,
  resolveRecordDescriptor,
} from "../../packages/ui/src/resource-utils";

describe("formatResourceValue", () => {
  it("formats id render type using short id", () => {
    const value = "1234567890abcdef";
    expect(formatResourceValue(value, { renderType: "id" })).toBe(
      formatIdValue(value)
    );
  });

  it("formats uuid-like ids as readable references", () => {
    const value = "e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c";
    expect(formatResourceValue(value, { renderType: "id" })).toBe(
      formatReferenceValue(value)
    );
  });

  it("formats uuid render type using readable reference id", () => {
    const value = "1234567890abcdef";
    expect(formatResourceValue(value, { renderType: "uuid" })).toBe(
      formatReferenceValue(value)
    );
  });

  it("renders dash for missing id values", () => {
    expect(formatResourceValue(null, { renderType: "id" })).toBe("-");
  });

  it("humanizes lookup machine keys when registry labels are absent", () => {
    expect(formatResourceValue("sender_return", { renderType: "lookup" })).toBe(
      "Sender Return"
    );
    expect(
      formatResourceValue(["sender_return", "rto_handoff"], {
        renderType: "lookup",
      })
    ).toBe("Sender Return, RTO Handoff");
  });

  it("prefers registry lookup labels over machine-key fallback labels", () => {
    expect(
      formatResourceValue("sender_return", {
        renderType: "lookup",
        formatOptions: {
          lookup_labels: {
            sender_return: "Return to sender",
          },
        },
      })
    ).toBe("Return to sender");
  });

  it("does not expose raw UUIDs when lookup labels are missing", () => {
    expect(
      formatResourceValue("e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c", {
        renderType: "lookup",
      })
    ).toBe("REF-E5E9E25C");
  });
});

describe("formatMachineValueLabel", () => {
  it("humanizes only machine-style lookup values", () => {
    expect(isHumanizableMachineValue("sender_return")).toBe(true);
    expect(formatMachineValueLabel("sender_return")).toBe("Sender Return");
    expect(formatMachineValueLabel("Already friendly")).toBe("Already friendly");
  });
});

describe("formatReferenceValue", () => {
  it("keeps short identifiers unchanged", () => {
    expect(formatReferenceValue("SHIP-42")).toBe("SHIP-42");
  });

  it("formats uuid identifiers as readable references", () => {
    expect(
      formatReferenceValue("e5e9f2ab-303a-4e1d-9b4b-7326a4f3e25c")
    ).toBe("REF-E5E9E25C");
  });
});

describe("formatDisplayIdentifierValue", () => {
  it("keeps identifiers within the display threshold unchanged", () => {
    expect(formatDisplayIdentifierValue("TESTB-62836344")).toBe("TESTB-62836344");
    expect(formatDisplayIdentifierValue("1Z999AA10123456784")).toBe("1Z999AA10123456784");
  });

  it("compacts long identifiers for human scanning", () => {
    expect(formatDisplayIdentifierValue("LOAD-2-61-1770496616829")).toBe(
      "LOAD-2-61-...616829"
    );
  });
});

describe("resolveRecordDescriptor", () => {
  it("returns first non-empty descriptor from configured keys", () => {
    expect(
      resolveRecordDescriptor(
        {
          summary: "  ",
          description: "Fragile package - keep upright",
        },
        ["summary", "description"]
      )
    ).toBe("Fragile package - keep upright");
  });

  it("returns null when descriptor keys are absent", () => {
    expect(resolveRecordDescriptor({ id: "1" }, ["description"])).toBeNull();
  });
});
