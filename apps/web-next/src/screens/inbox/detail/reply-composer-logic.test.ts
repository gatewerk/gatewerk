import { describe, it, expect } from "vitest";
import { classifyReplyKeydown } from "./reply-composer-logic";

function key(overrides: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) {
  return { key: "Enter", metaKey: false, ctrlKey: false, shiftKey: false, ...overrides };
}

describe("classifyReplyKeydown", () => {
  it("plain Enter submits", () => {
    expect(classifyReplyKeydown(key({}))).toBe("submit");
  });

  it("Shift+Enter inserts a newline", () => {
    expect(classifyReplyKeydown(key({ shiftKey: true }))).toBe("newline");
  });

  it("Cmd+Enter submits and advances", () => {
    expect(classifyReplyKeydown(key({ metaKey: true }))).toBe("submit-and-advance");
  });

  it("Ctrl+Enter submits and advances too", () => {
    expect(classifyReplyKeydown(key({ ctrlKey: true }))).toBe("submit-and-advance");
  });

  it("Cmd takes priority over Shift when both are held", () => {
    expect(classifyReplyKeydown(key({ metaKey: true, shiftKey: true }))).toBe("submit-and-advance");
  });

  it("any other key is a no-op", () => {
    expect(classifyReplyKeydown(key({ key: "a" }))).toBe("none");
    expect(classifyReplyKeydown(key({ key: "Escape" }))).toBe("none");
  });
});
