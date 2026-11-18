import { fetchCommandRegistry } from "../../packages/ui/src/command-registry";

describe("fetchCommandRegistry", () => {
  it("caches successful command registry reads by explicit scope key", async () => {
    const client = {
      commandRegistry: jest.fn().mockResolvedValue({
        commands: [{ key: "shipments.update", label: "Update" }],
      }),
    };

    const first = await fetchCommandRegistry(client, {
      cacheKey: "console:tenant:tenant-1",
      ttlMs: 60_000,
    });
    const second = await fetchCommandRegistry(client, {
      cacheKey: "console:tenant:tenant-1",
      ttlMs: 60_000,
    });

    expect(client.commandRegistry).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.commands).toHaveLength(1);
  });

  it("does not share cached command registries across scope keys", async () => {
    const client = {
      commandRegistry: jest
        .fn()
        .mockResolvedValueOnce({ commands: [{ key: "tenant.command" }] })
        .mockResolvedValueOnce({ commands: [{ key: "sender.command" }] }),
    };

    const tenant = await fetchCommandRegistry(client, {
      cacheKey: "console:tenant:tenant-2",
      ttlMs: 60_000,
    });
    const sender = await fetchCommandRegistry(client, {
      cacheKey: "portal:sender:sender-1",
      ttlMs: 60_000,
    });

    expect(client.commandRegistry).toHaveBeenCalledTimes(2);
    expect(tenant.commands[0]?.key).toBe("tenant.command");
    expect(sender.commands[0]?.key).toBe("sender.command");
  });

  it("does not share a scope key across client instances", async () => {
    const firstClient = { commandRegistry: jest.fn().mockResolvedValue({ commands: [{ key: "first.command" }] }) };
    const secondClient = { commandRegistry: jest.fn().mockResolvedValue({ commands: [{ key: "second.command" }] }) };
    const options = { cacheKey: "example-scope", ttlMs: 60_000 };

    expect((await fetchCommandRegistry(firstClient, options)).commands[0]?.key).toBe("first.command");
    expect((await fetchCommandRegistry(secondClient, options)).commands[0]?.key).toBe("second.command");
  });
});
