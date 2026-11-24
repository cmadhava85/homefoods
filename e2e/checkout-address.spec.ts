import { expect, test } from "@playwright/test";

function uniqueMobile() {
  return `+91${String(Date.now()).slice(-10)}`.slice(0, 13);
}

test.describe("customer address → checkout", () => {
  test("login, save HOME, place day order with address", async ({ page }) => {
    const mobile = uniqueMobile();
    const line1 = `PW E2E Tower ${Date.now().toString().slice(-4)}`;

    await page.goto(`/login?role=customer&next=/kitchen/csk-homemade-delights`);
    await page.getByPlaceholder("+91…").fill(mobile);
    await page.getByPlaceholder("6-digit code").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/kitchen\/csk-homemade-delights/, { timeout: 20_000 });
    await expect(page.getByText(/Deliver to/i).first()).toBeVisible({ timeout: 20_000 });

    const saveAddr = page.getByRole("button", { name: /Save address/i }).first();
    if (!(await saveAddr.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: /Add address/i }).first().click();
    }
    const addForm = page.locator(".checkout-address-add");
    await expect(addForm).toBeVisible({ timeout: 10_000 });
    // Form uses labelled inputs (no placeholders on line1/PIN).
    await addForm.locator("#checkout-line1").fill(line1);
    await addForm.locator("#checkout-pin").fill("600119");
    await saveAddr.click();
    await expect(page.locator(".checkout-address select").first()).toContainText(line1, {
      timeout: 10_000,
    });

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
    // Click + wait together. Body may be unavailable after client navigates to /pay —
    // X-Trace-Id header is enough to prove durable correlation on the create call.
    const [orderRes] = await Promise.all([orderOk, orderDay.click()]);
    const traceHeader = orderRes.headers()["x-trace-id"];
    expect(traceHeader, "X-Trace-Id on create order").toMatch(/^trc_/);

    // Leaves kitchen for mock /pay or live Razorpay (either proves address checkout worked)
    await expect(page).not.toHaveURL(/\/kitchen\/csk-homemade-delights/, { timeout: 20_000 });

    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    await expect(page.getByText(line1)).toBeVisible({ timeout: 10_000 });
  });

  test("blocks day order until address chosen", async ({ page }) => {
    const mobile = uniqueMobile();
    await page.goto(`/login?role=customer&next=/kitchen/csk-homemade-delights`);
    await page.getByPlaceholder("+91…").fill(mobile);
    await page.getByPlaceholder("6-digit code").fill("123456");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/kitchen\/csk-homemade-delights/, { timeout: 20_000 });

    const orderDay = page.getByRole("button", { name: "Order this day only" }).first();
    await expect(orderDay).toBeVisible({ timeout: 15_000 });
    await orderDay.click();
    await expect(page.getByText(/Choose a delivery address/i).first()).toBeVisible();
    await expect(page).not.toHaveURL(/\/pay\//);
  });
});
