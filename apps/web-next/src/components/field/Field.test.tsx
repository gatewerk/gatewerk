import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Field } from "./Field";
import { TextInput } from "./inputs";

afterEach(cleanup);

describe("Field", () => {
  it("links label to input via htmlFor/id", () => {
    render(
      <Field label="Email">
        <TextInput type="email" />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBeNull();
  });

  it("wires error text via aria-describedby and aria-invalid", () => {
    render(
      <Field label="Email" error="Enter a valid email">
        <TextInput type="email" />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const errorEl = screen.getByText("Enter a valid email");
    expect(input.getAttribute("aria-describedby")).toBe(errorEl.id);
  });

  it("hideLabel keeps the label for screen readers only", () => {
    render(
      <Field label="Password" hideLabel>
        <TextInput type="password" />
      </Field>,
    );
    expect(screen.getByLabelText("Password")).toBeTruthy();
    expect(screen.getByText("Password").className).toContain("sr-only");
  });
});

describe("caller-supplied aria-describedby", () => {
  it("survives inside an error-free Field", () => {
    render(
      <Field label="URL">
        <TextInput aria-describedby="url-hint" />
      </Field>,
    );
    const input = screen.getByLabelText("URL");
    expect(input.getAttribute("aria-describedby")).toBe("url-hint");
  });

  it("still loses to the Field's errorId when the Field has an error", () => {
    render(
      <Field label="URL" error="Enter a valid URL">
        <TextInput aria-describedby="url-hint" />
      </Field>,
    );
    const input = screen.getByLabelText("URL");
    const errorEl = screen.getByText("Enter a valid URL");
    expect(input.getAttribute("aria-describedby")).toBe(errorEl.id);
  });
});

describe("caller-supplied id", () => {
  it("is ignored inside a Field so the label stays linked, with a dev error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Field label="Email">
        <TextInput id="my-id" />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input.id).not.toBe("my-id");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("works unchanged outside a Field", () => {
    render(<TextInput id="standalone" aria-label="Search" />);
    expect(screen.getByLabelText("Search").id).toBe("standalone");
  });
});
