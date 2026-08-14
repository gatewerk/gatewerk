import { describe, it, expect, afterEach, vi } from "vitest";
import express from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BootError } from "@gatewerk/shared";
import { readMode } from "../config";
import { mountEeIfCloud } from "../app";

// The commercial tree is a private submodule; a public clone leaves ./ee
// empty, and that is a supported state.
const EE_PRESENT = existsSync(join(__dirname, "..", "..", "..", "..", "ee", "api", "bootstrap.ts"));

// M21 scaffolding: GATEWERK_MODE env flag + ee/ dynamic import wiring.
// These tests pin the fail-closed contract (unknown values throw at boot)
// and the one-way import rule (src/ never statically references ee/ — the
// dynamic import only fires when mode=cloud).

describe("readMode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to "standalone" when env is unset', () => {
    vi.stubEnv("GATEWERK_MODE", "");
    expect(readMode()).toBe("standalone");
  });

  it('returns "standalone" when env is set to "standalone"', () => {
    vi.stubEnv("GATEWERK_MODE", "standalone");
    expect(readMode()).toBe("standalone");
  });

  it('returns "cloud" when env is set to "cloud"', () => {
    vi.stubEnv("GATEWERK_MODE", "cloud");
    expect(readMode()).toBe("cloud");
  });

  it("throws BootError with stable code when env is an unknown value", () => {
    vi.stubEnv("GATEWERK_MODE", "enterprise");
    expect(() => readMode()).toThrow(BootError);
    expect(() => readMode()).toThrow(/GATEWERK_MODE/);
    try {
      readMode();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BootError);
      expect((err as BootError).code).toBe("invalid_env_gatewerk_mode");
    }
  });

  it("rejects case variants (fail-closed strict match)", () => {
    vi.stubEnv("GATEWERK_MODE", "Cloud");
    expect(() => readMode()).toThrow(BootError);
  });
});

describe("mountEeIfCloud", () => {
  // The half that matters most to a self-hoster, and the only half that can
  // run everywhere: standalone must never reach for the Cloud tree. This
  // assertion is deliberately NOT gated on the submodule — if it were, the
  // public repo would have nothing checking its own boot path.
  it("does not load ee/ when mode is standalone", async () => {
    const app = express();
    await mountEeIfCloud(app, "standalone");
    const marked = app as unknown as { __gatewerkCloudBootCount?: number };
    expect(marked.__gatewerkCloudBootCount).toBeUndefined();
  });

  // The cloud half genuinely needs the Cloud tree on disk: it asserts the
  // dynamic import resolves and registerEE runs. On a public clone ./ee is
  // empty, so there is no bootstrap to load and this can only be skipped —
  // not weakened into asserting that the import fails, which would pass for
  // the wrong reason the day the specifier breaks.
  it.skipIf(!EE_PRESENT)(
    "loads ee/ and calls registerEE exactly once when mode is cloud",
    async () => {
      const app = express();
      (app as any).db = {};
      await mountEeIfCloud(app, "cloud");
      const marked = app as unknown as { __gatewerkCloudBootCount?: number };
      expect(marked.__gatewerkCloudBootCount).toBe(1);
    },
  );
});
