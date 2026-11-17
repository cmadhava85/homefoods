"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/AuthProvider";
import { useLocale } from "@/components/LocaleProvider";
import { loginPath, requestOtp, verifyOtp, type AuthRole } from "@/lib/auth";
import { validateMobile, validateOtp } from "@localmeals/i18n";

function parseRole(raw: string | null): AuthRole {
  const v = (raw ?? "customer").toUpperCase();
  if (v === "COOK" || v === "ADMIN" || v === "CUSTOMER") return v;
  return "CUSTOMER";
}

/** Only follow ?next= when it matches the role that just signed in. */
function postLoginPath(
  user: { role: AuthRole; cookSlug?: string },
  next?: string,
) {
  const n = next?.trim();
  if (n?.startsWith("/") && !n.startsWith("//")) {
    if (user.role === "CUSTOMER" && !n.startsWith("/cook") && !n.startsWith("/admin")) {
      return n;
    }
    if (user.role === "COOK" && (n.startsWith("/cook") || n === "/wa")) {
      return n;
    }
    if (user.role === "ADMIN" && n.startsWith("/admin")) {
      return n;
    }
  }
  if (user.role === "COOK" && user.cookSlug) return `/cook/${user.cookSlug}`;
  if (user.role === "ADMIN") return "/admin";
  return "/discover";
}

function LoginForm() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, logout, setUser } = useAuth();
  const { t } = useLocale();
  const role = useMemo(() => parseRole(params.get("role")), [params]);
  const next = params.get("next") || undefined;
  const switchAccount = params.get("switch") === "1";

  useEffect(() => {
    if (switchAccount && user) {
      void logout();
    }
  }, [logout, switchAccount, user]);

  const demoMobile =
    role === "COOK" ? "+919876543210" : role === "ADMIN" ? "+919900000001" : "+919840111111";

  const [mobile, setMobile] = useState(demoMobile);
  const [code, setCode] = useState("123456");
  const [hint, setHint] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<{ mobile?: string; otp?: string }>({});
  const [busy, setBusy] = useState(false);

  function validateFields() {
    const mobileKey = validateMobile(mobile);
    const otpKey = validateOtp(code);
    setFieldErr({
      mobile: mobileKey ? t(mobileKey) : undefined,
      otp: otpKey ? t(otpKey) : undefined,
    });
    return !mobileKey && !otpKey;
  }

  async function sendOtp() {
    const mobileKey = validateMobile(mobile);
    if (mobileKey) {
      setFieldErr({ mobile: t(mobileKey) });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await requestOtp(mobile, role);
      setHint(
        res.mockCode
          ? `Dev OTP: ${res.mockCode}`
          : "OTP sent to your WhatsApp / SMS (mock logs on API).",
      );
      if (res.mockCode) setCode(res.mockCode);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!validateFields()) return;
    setBusy(true);
    setErr(null);
    try {
      const user = await verifyOtp(mobile, role, code);
      setUser(user);
      router.replace(postLoginPath(user, next));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const titleKey =
    role === "COOK" ? "login.cookTitle" : role === "ADMIN" ? "login.adminTitle" : "login.customerTitle";
  const blurbKey =
    role === "COOK" ? "login.cookBlurb" : role === "ADMIN" ? "login.adminBlurb" : "login.customerBlurb";

  return (
    <main className="card login-panel">
      <p className="chip">{role}</p>
      <h1 style={{ fontSize: "1.55rem" }}>{t(titleKey)}</h1>
      <p className="muted">{t(blurbKey)}</p>

      <div className="seg" style={{ marginTop: "0.85rem" }}>
        {(["CUSTOMER", "COOK", "ADMIN"] as AuthRole[]).map((r) => (
          <button
            key={r}
            type="button"
            className={role === r ? "on" : ""}
            onClick={() => {
              router.replace(loginPath(r, next, switchAccount));
              setMobile(
                r === "COOK" ? "+919876543210" : r === "ADMIN" ? "+919900000001" : "+919840111111",
              );
              setCode("123456");
              setHint(t("login.devHint"));
              setErr(null);
              setFieldErr({});
            }}
          >
            {r === "CUSTOMER" ? t("nav.customer") : r === "COOK" ? t("nav.cook") : t("nav.admin")}
          </button>
        ))}
      </div>

      {switchAccount ? <p className="muted" style={{ marginTop: "0.85rem" }}>{t("nav.switchAccount")} — signing out to continue.</p> : null}

      <div style={{ marginTop: "1rem" }}>
        <label className="muted" style={{ display: "block", marginBottom: 4 }}>
          {t("login.mobile")}
        </label>
        <input
          value={mobile}
          onChange={(e) => setMobile(e.target.value)}
          placeholder="+91…"
          style={{ width: "100%" }}
          disabled={busy}
          aria-invalid={Boolean(fieldErr.mobile)}
        />
        {fieldErr.mobile ? <p className="err" style={{ marginTop: 4 }}>{fieldErr.mobile}</p> : null}
      </div>

      <div style={{ marginTop: "0.75rem" }}>
        <label className="muted" style={{ display: "block", marginBottom: 4 }}>
          {t("login.otp")}
        </label>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="6-digit code"
          style={{ width: "100%" }}
          disabled={busy}
          aria-invalid={Boolean(fieldErr.otp)}
        />
        {fieldErr.otp ? <p className="err" style={{ marginTop: 4 }}>{fieldErr.otp}</p> : null}
      </div>

      {hint ? <p className="ok" style={{ marginTop: "0.75rem" }}>{hint}</p> : null}
      {err ? <p className="err" style={{ marginTop: "0.75rem" }}>{err}</p> : null}

      <div className="actions">
        <button
          className="btn"
          type="button"
          disabled={busy || !mobile.trim() || !code.trim()}
          onClick={confirm}
        >
          {busy ? t("login.checking") : t("login.signIn")}
        </button>
        <button
          className="btn secondary"
          type="button"
          disabled={busy || !mobile.trim()}
          onClick={sendOtp}
        >
          {t("login.sendOtp")}
        </button>
      </div>

      {role === "COOK" ? (
        <p className="muted" style={{ marginTop: "1rem" }}>
          <Link href="/cook/onboard">{t("login.enrollCook")}</Link>
        </p>
      ) : null}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<p className="muted">Loading login…</p>}>
      <LoginForm />
    </Suspense>
  );
}
