"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { useLocale } from "./LocaleProvider";
import { loginPath, type AuthRole } from "@/lib/auth";

export function RequireAuth({
  role,
  children,
}: {
  role: AuthRole | AuthRole[];
  children: React.ReactNode;
}) {
  const { user, ready } = useAuth();
  const { t } = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const roles = Array.isArray(role) ? role : [role];

  useEffect(() => {
    if (!ready) return;
    if (!user || !roles.includes(user.role)) {
      const primary = roles[0];
      router.replace(loginPath(primary, pathname));
    }
  }, [ready, user, roles, router, pathname]);

  if (!ready) return <p className="muted">{t("auth.checking")}</p>;
  if (!user || !roles.includes(user.role)) {
    return <p className="muted">{t("auth.redirecting")}</p>;
  }
  return <>{children}</>;
}
