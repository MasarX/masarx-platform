import "@testing-library/jest-dom";
import { toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

// UI component tests should be hermetic and not depend on real cloud credentials.
// Some UI components initialize a Supabase client during render; provide safe defaults.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  // objectives:allow NEXT_PUBLIC_SUPABASE_URL Justification: test-only placeholder to keep UI component tests hermetic
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
}
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
}

if (!("TextEncoder" in globalThis)) {
  const { TextEncoder, TextDecoder } = require("util") as typeof import("util");
  (globalThis as typeof globalThis & {
    TextEncoder?: typeof TextEncoder;
    TextDecoder?: typeof TextDecoder;
  }).TextEncoder = TextEncoder;
  (globalThis as typeof globalThis & {
    TextEncoder?: typeof TextEncoder;
    TextDecoder?: typeof TextDecoder;
  }).TextDecoder = TextDecoder;
}

if (!("MessageChannel" in globalThis)) {
  const { MessageChannel: NodeMessageChannel } =
    require("node:worker_threads") as typeof import("node:worker_threads");
  const messageChannels = new Set<InstanceType<typeof NodeMessageChannel>>();

  class TestMessageChannel extends NodeMessageChannel {
    constructor() {
      super();
      messageChannels.add(this);
    }
  }

  (globalThis as typeof globalThis & {
    MessageChannel?: typeof TestMessageChannel;
  }).MessageChannel = TestMessageChannel;
  afterAll(() => {
    messageChannels.forEach(({ port1, port2 }) => {
      port1.close();
      port2.close();
    });
    messageChannels.clear();
  });
}

if (!("ResizeObserver" in globalThis)) {
  class ResizeObserver {
    private callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }

    observe() {
      this.callback([], this);
    }

    unobserve() {}

    disconnect() {}
  }

  (globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver =
    ResizeObserver;
}

if (!("matchMedia" in globalThis)) {
  (globalThis as typeof globalThis & {
    matchMedia?: (query: string) => MediaQueryList;
  }).matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) satisfies MediaQueryList;
}
