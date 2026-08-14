import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthContext, type AuthContextValue } from "@gatewerk/web-core/hooks/use-auth";
import { PasswordModal } from "./PasswordModal";

afterEach(cleanup);

// PasswordModal reads `user`/`updateUser` from useAuth (only used inside the
// mutation's onSuccess, not during initial render), so a minimal stub value
// satisfies the render without pulling in a real login flow.
const AUTH_STUB: AuthContextValue = {
  user: null,
  isLoading: false,
  isLoggedIn: false,
  login: vi.fn(),
  logout: vi.fn(),
  updateUser: vi.fn(),
};

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthContext.Provider value={AUTH_STUB}>
        <PasswordModal onClose={vi.fn()} />
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PasswordModal on shared Modal", () => {
  it("is a dialog named by its h2 title with the subtitle preserved", () => {
    renderModal();
    expect(screen.getByRole("dialog", { name: "Change password" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Change password" })).toBeTruthy();
    expect(screen.getByText("Choose a new password for your account.")).toBeTruthy();
    // Named via aria-labelledby now, not a raw aria-label; this line is what
    // actually discriminates the pre-migration markup from the post-migration one.
    expect(screen.getByRole("dialog", { name: "Change password" }).getAttribute("aria-label")).toBeNull();
  });
});
