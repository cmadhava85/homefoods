import { expect, test } from "@playwright/test";
import {
  CSK,
  completeMockPay,
  loginCustomer,
  placeDayOrder,
  saveCheckoutAddress,
  uniqueMobile,
} from "./helpers";

test.describe("mock pay → confirmed", () => {
  test("day order pays with mock UPI and lands on confirmed", async ({ page }) => {
    const mobile = uniqueMobile();
    await loginCustomer(page, mobile);
    await expect(page).toHaveURL(new RegExp(`/kitchen/${CSK}`), { timeout: 20_000 });
    await saveCheckoutAddress(page);
    await placeDayOrder(page);

    await expect(page.getByRole("heading", { name: "Pay", exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await completeMockPay(page);

    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/From /i).first()).toBeVisible();
  });
});
