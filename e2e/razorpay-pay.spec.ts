import { expect, test } from "@playwright/test";
import {
  CSK,
  loginCustomer,
  placeDayOrder,
  saveCheckoutAddress,
  uniqueMobile,
} from "./helpers";
import {
  clickRazorpayMockBankButton,
  fillRazorpayTestCard,
  razorpayE2eEnabled,
} from "./razorpay";

/**
 * Starts on LocalMeals kitchen (order page), places a day order, pays on Razorpay
 * hosted checkout with the official test Visa, clicks mock-bank **Success**, then
 * asserts `/order/confirmed`.
 *
 *   MOCK_PAYMENTS=false npm run test:e2e -- e2e/razorpay-pay.spec.ts
 */
test.describe("Razorpay test card from LocalMeals order", () => {
  test.skip(!razorpayE2eEnabled(), "Set MOCK_PAYMENTS=false with rzp_test_ keys");

  test.describe.configure({ timeout: 180_000 });

  test("kitchen order → Razorpay test card → Success → confirmed", async ({ page }) => {
    const mobile = uniqueMobile();
    await loginCustomer(page, mobile);
    await expect(page).toHaveURL(new RegExp(`/kitchen/${CSK}`), { timeout: 20_000 });
    await saveCheckoutAddress(page);

    // LocalMeals order page → create order (live API redirects to hosted plink).
    await placeDayOrder(page, { expectUrl: /\/pay\/|razorpay\.com|rzp\.io/ });

    // If we landed on our /pay first, open the Razorpay CTA.
    if (/\/pay\//.test(page.url())) {
      const payCta = page.getByRole("link", { name: /Pay ₹.*with UPI/i });
      await expect(payCta).toBeVisible({ timeout: 30_000 });
      await Promise.all([
        page.waitForURL(/razorpay\.com|rzp\.io/, { timeout: 45_000 }),
        payCta.click(),
      ]);
    }

    await expect(page).toHaveURL(/razorpay\.com|rzp\.io/, { timeout: 30_000 });

    await fillRazorpayTestCard(page);
    // Critical: mocksharp popup Success (green) — not Failure.
    await clickRazorpayMockBankButton(page, "Success");

    await page.waitForURL(
      (url) =>
        /127\.0\.0\.1:3000|localhost:3000/.test(url.href) &&
        (/\/pay\//.test(url.pathname) || /\/order\/confirmed\//.test(url.pathname)),
      { timeout: 120_000 },
    );
    await expect(page).toHaveURL(/\/order\/confirmed\//, { timeout: 120_000 });
    // Headline depends on status after capture (PAID → "Order confirmed", COOKING → "Kitchen is cooking").
    await expect(
      page.getByRole("heading", {
        name: /Order confirmed|Kitchen is cooking|Week order|In kitchen queue/i,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/From CSK|Sambar|LM-/i).first()).toBeVisible();
  });
});
