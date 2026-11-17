import { API_BASE } from "./api";
import { localeHeaders } from "./locale";

export type AuthRole = "CUSTOMER" | "COOK" | "ADMIN";

export type AuthUser = {
  mobile: string;
  role: AuthRole;
  fullName: string;
  pinCode?: string;
  cookSlug?: string;
  cookId?: string;
};

/** Profile cache only — session token lives in HttpOnly `lm_session` cookie. */
const USER_KEY = "lm_user";
/** Legacy Bearer token (migrated away; still sent if present). */
const TOKEN_KEY = "lm_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function setSession(_token: string | null, user: AuthUser) {
  // Prefer cookie session; drop any legacy Bearer token from localStorage.
  localStorage.removeItem(TOKEN_KEY);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export async function authFetch(path: string, init: RequestInit = {}) {
  const token = getToken();
  const headers = new Headers(localeHeaders());
  new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (
    init.body &&
    typeof init.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}

export async function requestOtp(mobile: string, role: AuthRole) {
  const res = await fetch(`${API_BASE}/auth/otp/request`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...localeHeaders() },
    body: JSON.stringify({ mobile, role }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Could not send OTP");
  return json as { mobile: string; mockCode?: string };
}

export async function verifyOtp(mobile: string, role: AuthRole, code: string) {
  const res = await fetch(`${API_BASE}/auth/otp/verify`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...localeHeaders() },
    body: JSON.stringify({ mobile, role, code }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Invalid OTP");
  setSession(null, json.user);
  return json.user as AuthUser;
}

export async function fetchMe() {
  const res = await authFetch("/auth/me");
  if (!res.ok) {
    clearSession();
    return null;
  }
  const json = await res.json();
  setSession(null, json.user);
  return json.user as AuthUser;
}

export async function logout() {
  try {
    await authFetch("/auth/logout", { method: "POST" });
  } finally {
    clearSession();
  }
}

export function loginPath(role: AuthRole, next?: string, switchAccount = false) {
  const q = new URLSearchParams({ role: role.toLowerCase() });
  if (next) q.set("next", next);
  if (switchAccount) q.set("switch", "1");
  return `/login?${q}`;
}
