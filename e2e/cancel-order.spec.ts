import { expect, test } from "@playwright/test";
import { customerPaidDayOrder } from "./helpers";

test.describe("cancel before cut-off", () => {
  test("paid day order cancels from My orders", async ({ page }) => {
    await customerPaidDayOrder(page);

    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "My orders" })).toBeVisible({
      timeout: 15_000,
    });

    const cancel = page.getByRole("button", { name: "Cancel" }).first();
    await expect(cancel).toBeVisible({ timeout: 15_000 });
    await cancel.click();

    const confirm = page.getByRole("button", { name: "Yes, cancel" });
    await expect(confirm).toBeVisible({ timeout: 10_000 });

    const cancelOk = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/orders\/[^/]+\/cancel/.test(r.url()) &&
        r.status() === 200,
      { timeout: 20_000 },
    );
    await Promise.all([cancelOk, confirm.click()]);

    await expect(
      page.getByText(/Cancelled LM-|Refund|refund/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });
});
