import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { InviteForm } from "./InviteForm";

afterEach(cleanup);

describe("InviteForm", () => {
  it("links the Email label to the input and hints autocomplete", () => {
    render(
      <InviteForm
        email=""
        role="reviewer"
        onEmailChange={() => {}}
        onRoleChange={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
        isSubmitting={false}
      />,
    );
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("type")).toBe("email");
    expect(input.getAttribute("autocomplete")).toBe("email");
  });
});
