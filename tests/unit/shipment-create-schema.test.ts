import { shipmentCreateSchema } from "../../packages/config/schemas/shipment-create";

describe("shipmentCreateSchema", () => {
  test("accepts the minimal manual-create payload without sender or recipient", () => {
    const parsed = shipmentCreateSchema.safeParse({
      clientId: "client-1",
      senderId: "",
      serviceType: "delivery",
      trackingNumber: "",
      clientReferenceNumber: "",
      carrierReferenceNumber: "",
      status: "pending",
      recipient: {
        name: "",
        phoneNumber: "",
        email: "",
        preferredLanguage: "",
      },
      destinationAddress: {
        rawInput: "",
        city: "",
        province: "",
        country: "",
        postalCode: "",
        buildingNumber: "",
        additionalDirections: "",
      },
      originAddress: {
        rawInput: "",
        city: "",
        province: "",
        country: "",
        postalCode: "",
        buildingNumber: "",
        additionalDirections: "",
      },
      boxes: [
        {
          key: "box-1",
          boxNumber: "",
          weightKg: "",
          lengthCm: "",
          widthCm: "",
          heightCm: "",
          contentsDescription: "",
          fragile: false,
        },
      ],
      references: [],
    });

    expect(parsed.success).toBe(true);
  });
});
