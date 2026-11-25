import { execFileSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

export const CSK = "csk-homemade-delights";
export const DEMO_OTP = "123456";
export const COOK_MOBILE = "+919876543210";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://localmeals:localmeals@127.0.0.1:5432/localmeals";

export function uniqueMobile() {
  const n = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-10);
  return `+91${n}`;
}

async function clearSession(page: Page) {
  await page.context().clearCookies();
}

/** Drop today’s LUNCH cutoff lock so new pays stay PAID (not auto COOKING). */
function clearTodayLunchCutoffLock() {
  execFileSync(
    "psql",
    [
      DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `delete from cutoff_locks cl
       using cook_profiles cp
       where cl.cook_id = cp.id
         and cp.slug_handle = '${CSK}'
         and cl.meal_type = 'LUNCH'
         and cl.service_date = (timezone('Asia/Kolkata', now()))::date;`,
    ],
    { stdio: "pipe" },
  );
}

/** Push LUNCH cut-off to 23:59 and clear today’s lock so PAID stays cancellable. */
let cutoffBumped = false;
export async function ensureLunchCutoffOpen(page: Page) {
  if (cutoffBumped) {
    clearTodayLunchCutoffLock();
    return;
  }
  await loginCook(page);
  const res = await page.request.patch(`${API}/cooks/${CSK}/meal-settings/LUNCH`, {
    data: { cutoffHour: 23, cutoffMinute: 59 },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  clearTodayLunchCutoffLock();
  await clearSession(page);
  cutoffBumped = true;
}

/** Mock-auth customer login; lands on kitchen or `next`. */
export async function loginCustomer(page: Page, mobile: string, next = `/kitchen/${CSK}`) {
  await clearSession(page);
  await page.goto(`/login?role=customer&next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("+91…").fill(mobile);
  await page.getByPlaceholder("6-digit code").fill(DEMO_OTP);
  await page.locator("main").getByRole("button", { name: "Sign in" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 20_000 });
}

/** Seed cook (+919876543210) → cook desk. */
export async function loginCook(page: Page, next = `/cook/${CSK}`) {
  await clearSession(page);
  await page.goto(`/login?role=cook&next=${encodeURIComponent(next)}`);
  await page.getByPlaceholder("+91…").fill(COOK_MOBILE);
  await page.getByPlaceholder("6-digit code").fill(DEMO_OTP);
  await page.locator("main").getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(new RegExp(`/cook/${CSK}`), { timeout: 20_000 });
}

/**
 * Click the cook desk status CTA for a specific LM-… line
 * (desk has many stops — never use the first matching label globally).
 */
export async function clickCookStatus(
  page: Page,
  label: string,
  pathSuffix: "cooking" | "pack" | "dispatch" | "delivered",
  publicId?: string | null,
) {
  // publicId sits in <p class="muted">; parent line card holds the CTA.
  const btn = publicId
    ? page
        .getByText(publicId, { exact: true })
        .locator("xpath=ancestor::div[contains(@class,'actions') or .//button[contains(@class,'btn')]][1]")
        .getByRole("button", { name: label, exact: true })
    : page.getByRole("button", { name: label, exact: true }).first();
  await expect(btn).toBeVisible({ timeout: 25_000 });
  const ok = page.waitForResponse(
    (r) => {
      if (r.request().method() !== "POST" || r.status() !== 200) return false;
      if (publicId) return r.url().includes(`/orders/${encodeURIComponent(publicId)}/${pathSuffix}`)
        || r.url().includes(`/orders/${publicId}/${pathSuffix}`);
      return new RegExp(`/orders/[^/]+/${pathSuffix}`).test(r.url());
    },
    { timeout: 20_000 },
  );
  await Promise.all([ok, btn.click()]);
}

/** Save a HOME address on the kitchen checkout picker (kitchen page must be open). */
export async function saveCheckoutAddress(page: Page, line1?: string) {
  const label = line1 ?? `PW E2E ${Date.now().toString().slice(-6)}`;
  await expect(page.getByText(/Deliver to/i).first()).toBeVisible({ timeout: 20_000 });

  const saveAddr = page.getByRole("button", { name: /Save address/i }).first();
  if (!(await saveAddr.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: /Add address/i }).first().click();
  }
  const addForm = page.locator(".checkout-address-add");
  await expect(addForm).toBeVisible({ timeout: 10_000 });
  await addForm.locator("#checkout-line1").fill(label);
  await addForm.locator("#checkout-pin").fill("600119");
  await saveAddr.click();
  await expect(page.locator(".checkout-address select").first()).toContainText(label, {
    timeout: 10_000,
  });
  return label;
}

/**
 * Day-only order (address already saved on kitchen).
 * Mock pay → `/pay/…`; live Razorpay often redirects straight to the hosted link.
 */
export async function placeDayOrder(page: Page, opts: { expectUrl?: RegExp } = {}) {
  const orderDay = page.getByRole("button", { name: "Order this day only" }).first();
  await expect(orderDay).toBeVisible({ timeout: 15_000 });
  const orderOk = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/orders(\/|$|\?)/.test(r.url()) &&
      !r.url().includes("/orders/batch") &&
      r.status() === 200,
    { timeout: 20_000 },
  );
  await Promise.all([orderOk, orderDay.click()]);
  await expect(page).toHaveURL(opts.expectUrl ?? /\/pay\/|razorpay\.com|rzp\.io/, {
    timeout: 25_000,
  });
}

/** Click mock UPI CTA and wait for confirmed page. */
export async function completeMockPay(page: Page) {
  const payBtn = page.getByRole("button", { name: /Pay ₹.*\(mock UPI\)/i });
  await expect(payBtn).toBeVisible({ timeout: 15_000 });
  await payBtn.click();
  await expect(page).toHaveURL(/\/order\/confirmed\//, { timeout: 25_000 });
}

/** Login + address + day order + mock pay. Returns address line + publicId. */
export async function customerPaidDayOrder(page: Page, mobile = uniqueMobile()) {
  await ensureLunchCutoffOpen(page);
  await loginCustomer(page, mobile);
  await expect(page).toHaveURL(new RegExp(`/kitchen/${CSK}`), { timeout: 20_000 });
  const line1 = await saveCheckoutAddress(page);
  await placeDayOrder(page, { expectUrl: /\/pay\// });
  await completeMockPay(page);
  const publicId = page.url().match(/\/order\/confirmed\/([^/?#]+)/)?.[1] ?? null;
  return { mobile, line1, publicId };
}
