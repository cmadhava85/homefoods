import { expect, test } from "@playwright/test";
import {
  CSK,
  completeMockPay,
  loginCustomer,
  saveCheckoutAddress,
  uniqueMobile,
} from "./helpers";

test.describe("week cart checkout", () => {
  test("add two days → Pay for week → mock pay → confirmed", async ({ page }) => {
    const mobile = uniqueMobile();
    await loginCustomer(page, mobile);
    await expect(page).toHaveURL(new RegExp(`/kitchen/${CSK}`), { timeout: 20_000 });
    await saveCheckoutAddress(page);

    const addWeek = page.getByRole("button", { name: "Add to week" }).first();
    await expect(addWeek).toBeVisible({ timeout: 15_000 });
    await addWeek.click();
    await expect(page.getByText(/Week cart ·/i).first()).toBeVisible({ timeout: 10_000 });

    // Pick another day that still has menu items (skip Today / empty chips).
    const otherDay = page
      .locator("button.day-chip")
      .filter({ hasNotText: /Today/i })
      .filter({ hasText: /\d+\s+items?/i })
      .first();
    await expect(otherDay).toBeVisible({ timeout: 10_000 });
    await otherDay.click();

    const addWeek2 = page.getByRole("button", { name: "Add to week" }).first();
    await expect(addWeek2).toBeVisible({ timeout: 15_000 });
    await addWeek2.click();
    await expect(page.getByText(/Week cart · 2 days/i).first()).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Review & pay" }).click();
    const payWeek = page.getByRole("button", { name: "Pay for week" });
    await expect(payWeek).toBeVisible({ timeout: 10_000 });

    const batchOk = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().includes("/orders/batch") &&
        r.status() === 200,
      { timeout: 25_000 },
    );
    await Promise.all([batchOk, payWeek.click()]);
    await expect(page).toHaveURL(/\/pay\//, { timeout: 25_000 });
    await completeMockPay(page);

    await expect(page).toHaveURL(/\/order\/confirmed\//, { timeout: 25_000 });
    await expect(
      page.getByText(/Week order|Order confirmed|Checkout/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
