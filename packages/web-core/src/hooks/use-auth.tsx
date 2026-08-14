import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { login as apiLogin, getMe, logoutApi, type Reviewer } from "@gatewerk/web-core/api/auth";
import { setToken, clearToken, isAuthenticated } from "@gatewerk/web-core/api/client/http";
import { clearAllCachedTokenLinks } from "@gatewerk/web-core/lib/token-link-cache";

interface LoginResult {
  must_change_password?: boolean;
  requires_2fa?: boolean;
  login_ticket?: string;
}

export interface AuthContextValue {
  user: Reviewer | null;
  isLoading: boolean;
  isLoggedIn: boolean;
  login: (
    email: string,
    password: string,
    rememberMe?: boolean,
    returnTo?: string,
  ) => Promise<LoginResult>;
  logout: () => void;
  updateUser: (user: Reviewer) => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Reviewer | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated()) {
      setIsLoading(false);
      return;
    }
    getMe()
      .then(setUser)
      .catch(() => clearToken())
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(
    async (
      email: string,
      password: string,
      rememberMe = false,
      returnTo?: string,
    ): Promise<LoginResult> => {
      // Threading return_to into the API call lets the server-side
      // validateReturnTo allowlist (OWASP A01:2021) reject hostile
      // redirect targets at the chokepoint instead of relying solely on
      // client-side `isValidReturnTo`. Server returns 400 invalid_return_to
      // which surfaces as the form error.
      const res = await apiLogin(email, password, rememberMe, returnTo);
      if (res.requires_2fa) {
        return { requires_2fa: true, login_ticket: res.login_ticket };
      }
      setToken(res.token!, rememberMe);
      setUser({ ...res.reviewer!, must_change_password: res.must_change_password });
      return { must_change_password: res.must_change_password };
    },
    [],
  );

  const logout = useCallback(async () => {
    try {
      await logoutApi();
    } catch {
      // If logout API fails (network error, already expired), proceed with local cleanup
    }
    clearToken();
    clearAllCachedTokenLinks();
    setUser(null);
  }, []);

  const updateUser = useCallback((updated: Reviewer) => {
    setUser(updated);
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, isLoggedIn: !!user, login, logout, updateUser }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
