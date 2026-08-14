import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOnboardingComplete,
  markOnboardingComplete,
  clearOnboardingComplete,
  replayOnboarding,
} from "./onboarding-store";

function createLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createLocalStorage());
  // The store keeps an in-memory "completed this tab" flag alongside storage,
  // and module state outlives a test. Clearing resets both, so these cases do
  // not depend on the order they run in.
  clearOnboardingComplete();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onboarding-store", () => {
  it("starts uncompleted, mark flips it, clear flips back", () => {
    expect(isOnboardingComplete()).toBe(false);
    markOnboardingComplete();
    expect(isOnboardingComplete()).toBe(true);
    clearOnboardingComplete();
    expect(isOnboardingComplete()).toBe(false);
  });

  it("replayOnboarding returns ok when removeItem succeeds", () => {
    markOnboardingComplete();
    expect(replayOnboarding()).toEqual({ ok: true });
    expect(isOnboardingComplete()).toBe(false);
  });

  it("replayOnboarding returns storage-blocked when removeItem throws", () => {
    vi.stubGlobal("localStorage", {
      ...createLocalStorage(),
      removeItem: () => { throw new Error("SecurityError"); },
    });
    expect(replayOnboarding()).toEqual({ ok: false, reason: "storage-blocked" });
  });

  // RequireAuth reads this during RENDER on every authenticated route, and
  // web-next prerenders. A throw here is a white screen at runtime and a failed
  // build at the CI gate, so the guard is load bearing, not defensive noise.
  it("isOnboardingComplete reports false rather than throwing when storage is denied", () => {
    vi.stubGlobal("localStorage", {
      ...createLocalStorage(),
      getItem: () => { throw new Error("SecurityError"); },
    });
    expect(() => isOnboardingComplete()).not.toThrow();
    expect(isOnboardingComplete()).toBe(false);
  });

  it("isOnboardingComplete reports false rather than throwing with no storage at all", () => {
    // Safari private browsing and some embedded webviews present no
    // localStorage object whatsoever, not a throwing one.
    vi.stubGlobal("localStorage", undefined);
    expect(() => isOnboardingComplete()).not.toThrow();
    expect(isOnboardingComplete()).toBe(false);
  });

  it("markOnboardingComplete swallows a denied write so finish() can still navigate", () => {
    vi.stubGlobal("localStorage", {
      ...createLocalStorage(),
      setItem: () => { throw new Error("QuotaExceededError"); },
    });
    expect(() => markOnboardingComplete()).not.toThrow();
  });

  // The lockout this prevents: RequireAuth redirects a cloud admin to
  // /onboarding on every authenticated route while this reads false. With a
  // denied write and no in-memory fallback, Skip navigates to the inbox and is
  // redirected straight back, forever — a wizard with no exit.
  it("reports complete for the rest of the tab even when the write is denied", () => {
    vi.stubGlobal("localStorage", {
      ...createLocalStorage(),
      setItem: () => { throw new Error("SecurityError"); },
    });
    expect(isOnboardingComplete()).toBe(false);
    markOnboardingComplete();
    expect(isOnboardingComplete()).toBe(true);
  });

  it("replay clears the in-memory flag too, or it could never re-run", () => {
    markOnboardingComplete();
    expect(isOnboardingComplete()).toBe(true);
    expect(replayOnboarding()).toEqual({ ok: true });
    expect(isOnboardingComplete()).toBe(false);
  });
});
