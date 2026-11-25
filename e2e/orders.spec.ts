import { expect, test } from "@playwright/test";
import { customerPaidDayOrder } from "./helpers";

test.describe("My orders", () => {
  test("paid day order appears under Open filter", async ({ page }) => {
    await customerPaidDayOrder(page);

    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "My orders" })).toBeVisible({ timeout: 15_000 });

    const openFilter = page.getByRole("button", { name: "Open" });
    if (await openFilter.isVisible().catch(() => false)) {
      await openFilter.click();
    }

    await expect(
      page.getByText(/In kitchen queue|Order confirmed|Paid|Homemade|CSK/i).first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/No orders yet/i)).toHaveCount(0);
  });
});
