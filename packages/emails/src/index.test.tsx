import { describe, it, expect } from "vitest";
import type React from "react";
import { Html, Body, Text } from "@react-email/components";
import { renderEmail, EmailRenderEmptyError, type EmailTemplate } from "./index";

interface FixtureProps { name: string }
const Fixture: EmailTemplate<FixtureProps> = ({ name }) => (
  <Html><Body><Text>Hello {name}, welcome.</Text></Body></Html>
);
Fixture.subject = ({ name }) => `Hi ${name}`;

describe("renderEmail toolchain", () => {
  it("produces non-empty subject, html, and text", async () => {
    const out = await renderEmail(Fixture, { name: "Ada" });
    expect(out.subject).toBe("Hi Ada");
    expect(out.html).toContain("Hello");
    expect(out.html.length).toBeGreaterThan(0);
    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.text).toContain("Ada");
  });
  it("html contains no <style> blocks (inline styles only)", async () => {
    const out = await renderEmail(Fixture, { name: "Ada" });
    expect(out.html).not.toMatch(/<style[\s>]/i);
  });
  it("throws EmailRenderEmptyError (not bare Error) when template produces empty body", async () => {
    // A template that returns nothing renderable — html + text both empty.
    const EmptyFixture: EmailTemplate<{ x: number }> = () => null as unknown as React.ReactElement;
    EmptyFixture.subject = () => "subject";
    EmptyFixture.displayName = "EmptyFixture";
    await expect(renderEmail(EmptyFixture, { x: 1 })).rejects.toThrow(EmailRenderEmptyError);
    await expect(renderEmail(EmptyFixture, { x: 1 })).rejects.toThrow(/EmptyFixture/);
  });
});
