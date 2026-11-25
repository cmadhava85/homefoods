import { expect, type Page } from "@playwright/test";

/** Official Razorpay India test Visa (docs: Test Cards). */
export const RAZORPAY_TEST_CARD = {
  number: "4100280000001007",
  expiry: "1230", // MMYY
  cvv: "123",
};

function checkoutFrame(page: Page) {
  return page.frameLocator('iframe[src*="checkout"]').first();
}

async function dismissRbiSaveModal(page: Page) {
  const later = checkoutFrame(page).locator('button[name="pay_without_saving_card"]');
  if (await later.isVisible({ timeout: 1_200 }).catch(() => false)) {
    await later.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(300);
  }
}

async function dismissCancelSheet(page: Page) {
  const wait = checkoutFrame(page).getByRole("button", { name: /No, wait/i });
  if (await wait.isVisible({ timeout: 500 }).catch(() => false)) {
    await wait.click({ force: true }).catch(() => undefined);
  }
}

async function clickContinue(page: Page) {
  const cta = checkoutFrame(page).getByTestId("bottom-cta-button");
  await dismissRbiSaveModal(page);
  await dismissCancelSheet(page);
  await cta.click({ force: true, timeout: 8_000 });
  await page.waitForTimeout(400);
  await dismissRbiSaveModal(page);
}

/**
 * Success / Failure live on the mocksharp **popup window**
 * (`api.razorpay.com/v1/gateway/mocksharp/payment`), not in the checkout iframe.
 */
export async function clickRazorpayMockBankButton(
  page: Page,
  outcome: "Success" | "Failure" = "Success",
) {
  const ctx = page.context();
  const deadline = Date.now() + 90_000;

  const findButton = async () => {
    for (const p of ctx.pages()) {
      const btn =
        outcome === "Success"
          ? p.locator("button.success").or(p.getByRole("button", { name: /^Success$/i }))
          : p.locator("button.danger").or(p.getByRole("button", { name: /^Failure$/i }));
      if (await btn.first().isVisible({ timeout: 200 }).catch(() => false)) {
        return { page: p, btn: btn.first() };
      }
      for (const fr of p.frames()) {
        try {
          const frBtn =
            outcome === "Success"
              ? fr.locator("button.success").or(fr.getByRole("button", { name: /^Success$/i }))
              : fr.locator("button.danger").or(fr.getByRole("button", { name: /^Failure$/i }));
          if (await frBtn.first().isVisible({ timeout: 100 }).catch(() => false)) {
            return { page: p, btn: frBtn.first() };
          }
        } catch {
          /* detached */
        }
      }
    }
    return null;
  };

  while (Date.now() < deadline) {
    const hit = await findButton();
    if (hit) {
      await hit.btn.click({ force: true });
      return hit.page;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Razorpay mock bank "${outcome}" button not found/clicked`);
}

/** Fill card on hosted Payment Link checkout (already on razorpay.com / rzp.io). */
export async function fillRazorpayTestCard(page: Page, mobileLocal = "9840111111") {
  const rzp = checkoutFrame(page);

  const contact = rzp.getByTestId("contactNumber");
  await contact.waitFor({ timeout: 45_000 });
  const existing = await contact.inputValue().catch(() => "");
  if (!existing || existing.replace(/\D/g, "").length < 10) {
    await contact.fill(mobileLocal);
    await page.frames().find((f) => f.url().includes("checkout"))?.evaluate((num) => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="contactNumber"]');
      if (!el) return;
      el.value = num;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }, mobileLocal);
  }
  await clickContinue(page);

  await rzp.getByText("Cards", { exact: true }).waitFor({ timeout: 30_000 });
  await rzp.getByText("Cards", { exact: true }).click();

  await rzp.locator('input[name="card.number"]').waitFor({ timeout: 15_000 });
  await rzp.locator('input[name="card.number"]').pressSequentially(RAZORPAY_TEST_CARD.number, {
    delay: 20,
  });
  await rzp.locator('input[name="card.expiry"]').pressSequentially(RAZORPAY_TEST_CARD.expiry, {
    delay: 20,
  });
  await rzp.locator('input[name="card.cvv"]').pressSequentially(RAZORPAY_TEST_CARD.cvv, {
    delay: 20,
  });
  const save = rzp.locator('[data-testid="save-card-checkbox"]');
  if (await save.isChecked().catch(() => false)) await save.uncheck();

  // Continue → RBI sheet → pay without saving → Continue again starts 3DS popup.
  const popupPromise = page.context().waitForEvent("page", { timeout: 90_000 }).catch(() => null);

  await clickContinue(page);
  await dismissRbiSaveModal(page);

  const cta = rzp.getByTestId("bottom-cta-button");
  if (await cta.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const text = ((await cta.innerText().catch(() => "")) || "").toLowerCase();
    if (!text.includes("sending")) {
      await cta.click({ force: true }).catch(() => undefined);
      await dismissRbiSaveModal(page);
    }
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => undefined);
    await popup.waitForURL(/mocksharp|authenticate/i, { timeout: 60_000 }).catch(() => undefined);
  }
}

/**
 * Full hosted-checkout: card details → mocksharp Success/Failure.
 * Call when the browser is already on the Razorpay payment-link page.
 */
export async function payRazorpayTestCard(
  page: Page,
  opts: { mobileLocal?: string; outcome?: "Success" | "Failure" } = {},
) {
  await fillRazorpayTestCard(page, opts.mobileLocal);
  await clickRazorpayMockBankButton(page, opts.outcome ?? "Success");
}

/**
 * From LocalMeals `/pay/:id` — open Razorpay CTA, pay with test card + Success,
 * land on `/order/confirmed/…`.
 */
export async function completeRazorpayPayFromLocalMeals(page: Page) {
  const payCta = page.getByRole("link", { name: /Pay ₹.*with UPI/i });
  await expect(payCta).toBeVisible({ timeout: 30_000 });

  await Promise.all([
    page.waitForURL(/razorpay\.com|rzp\.io/, { timeout: 45_000 }),
    payCta.click(),
  ]);

  await payRazorpayTestCard(page, { outcome: "Success" });

  // After Success, Razorpay redirects back to WEB_ORIGIN /pay/…?razorpay_payment_link_status=paid
  await page.waitForURL(
    (url) =>
      /127\.0\.0\.1:3000|localhost:3000/.test(url.href) &&
      (/\/pay\//.test(url.pathname) || /\/order\/confirmed\//.test(url.pathname)),
    { timeout: 120_000 },
  );
  await expect(page).toHaveURL(/\/order\/confirmed\//, { timeout: 120_000 });
  await expect(page.getByRole("heading", { name: /Order confirmed|Week order/i })).toBeVisible({
    timeout: 30_000,
  });
}

export function razorpayE2eEnabled() {
  return (
    process.env.MOCK_PAYMENTS === "false" &&
    Boolean(process.env.RAZORPAY_KEY_ID?.startsWith("rzp_test"))
  );
}
