import { expect, test } from "@playwright/test";
import {
  CSK,
  clickCookStatus,
  customerPaidDayOrder,
  loginCook,
  loginCustomer,
} from "./helpers";

function lineCard(page: import("@playwright/test").Page, publicId: string) {
  return page
    .getByText(publicId, { exact: true })
    .locator("xpath=ancestor::div[contains(@class,'actions') or .//button[contains(@class,'btn')]][1]");
}

test.describe("cook desk", () => {
  test("Start cooking on a freshly paid order", async ({ page }) => {
    const { publicId } = await customerPaidDayOrder(page);
    expect(publicId).toBeTruthy();

    await loginCook(page);
    await expect(page.getByRole("tab", { name: /Today’s run|Today's run/i })).toBeVisible({
      timeout: 15_000,
    });

    await clickCookStatus(page, "Start cooking", "cooking", publicId);
    await expect(lineCard(page, publicId!).getByRole("button", { name: "Mark packed", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page).toHaveURL(new RegExp(`/cook/${CSK}`));
  });

  test("PAID → cooking → packed → dispatch → delivered; customer can review", async ({
    page,
  }) => {
    const { mobile, publicId } = await customerPaidDayOrder(page);
    expect(publicId).toBeTruthy();
    await loginCook(page);

    await clickCookStatus(page, "Start cooking", "cooking", publicId);
    await clickCookStatus(page, "Mark packed", "pack", publicId);
    await clickCookStatus(page, "Dispatch", "dispatch", publicId);
    await clickCookStatus(page, "Mark delivered", "delivered", publicId);

    await loginCustomer(page, mobile, `/order/confirmed/${publicId}`);
    await expect(page).toHaveURL(new RegExp(`/order/confirmed/${publicId}`), { timeout: 20_000 });
    await expect(page.getByRole("heading", { name: "Delivered" })).toBeVisible({
      timeout: 15_000,
    });

    const reviewSubmit = page.getByRole("button", { name: "Submit review" });
    await expect(reviewSubmit).toBeVisible({ timeout: 20_000 });
    await page.locator(".star-btn").nth(4).click();
    await reviewSubmit.click();
    // onDone swaps form for rated summary (not review.thanks flash).
    await expect(page.getByText(/Thanks for rating|Your rating/i).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Menu & settings tab shows saved plates", async ({ page }) => {
    await loginCook(page);
    await page.getByRole("tab", { name: /Menu & settings/i }).click();
    await expect(page.getByText("Saved plates").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("tab", { name: "Weekly" })).toBeVisible();
  });
});
