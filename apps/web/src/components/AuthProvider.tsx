"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearSession,
  fetchMe,
  getStoredUser,
  getToken,
  logout as apiLogout,
  type AuthUser,
} from "@/lib/auth";

type AuthCtx = {
  user: AuthUser | null;
  ready: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const gen = useRef(0);

  const setUser = useCallback((next: AuthUser | null) => {
    gen.current += 1;
    setUserState(next);
  }, []);

  const refresh = useCallback(async () => {
    const myGen = ++gen.current;
    const stored = getStoredUser();
    const legacyToken = getToken();
    // No profile cache and no legacy token → still try cookie session via /auth/me
    if (stored) setUserState(stored);
    else if (!legacyToken) {
      /* cookie-only path */
    }

    const me = await fetchMe();
    if (myGen !== gen.current) return;
    if (!me) {
      clearSession();
      setUserState(null);
    } else {
      setUserState(me);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    gen.current += 1;
    await apiLogout();
    clearSession();
    setUserState(null);
  }, []);

  const value = useMemo(
    () => ({ user, ready, refresh, logout, setUser }),
    [user, ready, refresh, logout, setUser],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth requires AuthProvider");
  return ctx;
}
