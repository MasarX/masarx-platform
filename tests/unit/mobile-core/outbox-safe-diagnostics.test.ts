import { randomUUID } from "node:crypto";
import { redactOutboxErrorText } from "@masarx/mobile-core";

test.each([
  "AssertionError",
  "Assertion failed",
  "Unexpected token < in JSON",
])("keeps the complete fixed outbox diagnostic %s", (message) => {
  expect(redactOutboxErrorText(message)).toBe(message);
});

test("continues to redact variable text after a fixed outbox diagnostic", () => {
  const marker = randomUUID();
  const field = ["access", "token"].join("_");
  expect(redactOutboxErrorText("Unexpected token < in JSON\n" + field + "=" + marker))
    .not.toContain(marker);
});
