describe("mobile-app-integrity", () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("gracefully reports unavailable module in Expo Go runtimes", async () => {
    jest.doMock(
      "@expo/app-integrity",
      () => {
        throw new Error("Cannot find native module 'ExpoAppIntegrity'");
      },
      { virtual: true }
    );

    const integrity = await import("../../apps/fieldops/src/mobile-app-integrity");

    expect(integrity.isExpoAppIntegrityAvailable()).toBe(false);
    await expect(integrity.generateIosAttestationKeyAsync()).rejects.toThrow(
      "native module is unavailable"
    );
  });

  it("delegates calls when Expo app-integrity module is available", async () => {
    const mockGenerateKey = jest.fn<Promise<string>, []>().mockResolvedValue("key-1");
    const mockAttest = jest.fn<Promise<string>, [string, string]>().mockResolvedValue("attest");
    const mockAssertion = jest
      .fn<Promise<string>, [string, string]>()
      .mockResolvedValue("assertion");
    const mockPrepare = jest.fn<Promise<void>, [string]>().mockResolvedValue();
    const mockRequest = jest.fn<Promise<string>, [string]>().mockResolvedValue("token");

    jest.doMock(
      "@expo/app-integrity",
      () => ({
        __esModule: true,
        isSupported: true,
        generateKeyAsync: mockGenerateKey,
        attestKeyAsync: mockAttest,
        generateAssertionAsync: mockAssertion,
        prepareIntegrityTokenProviderAsync: mockPrepare,
        requestIntegrityCheckAsync: mockRequest,
      }),
      { virtual: true }
    );

    const integrity = await import("../../apps/fieldops/src/mobile-app-integrity");

    expect(integrity.isExpoAppIntegrityAvailable()).toBe(true);
    expect(integrity.isIosAppIntegritySupported()).toBe(true);

    await expect(integrity.generateIosAttestationKeyAsync()).resolves.toBe("key-1");
    await expect(integrity.attestIosKeyAsync("kid", "challenge")).resolves.toBe("attest");
    await expect(integrity.generateIosAssertionAsync("kid", "challenge")).resolves.toBe("assertion");
    await expect(integrity.requestAndroidIntegrityCheckAsync("abc")).resolves.toBe("token");
    await expect(integrity.prepareAndroidIntegrityTokenProviderAsync("123456")).resolves.toBeUndefined();

    expect(mockGenerateKey).toHaveBeenCalledTimes(1);
    expect(mockAttest).toHaveBeenCalledWith("kid", "challenge");
    expect(mockAssertion).toHaveBeenCalledWith("kid", "challenge");
    expect(mockPrepare).toHaveBeenCalledWith("123456");
    expect(mockRequest).toHaveBeenCalledWith("abc");
  });
});
