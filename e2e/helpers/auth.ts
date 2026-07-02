import type { Page } from '@playwright/test';

export const ADMIN = {
  practiceName: 'Lone Star Pediatrics',
  email: 'admin@lonestarkidz.com',
  password: 'Admin@12345',
};

export const API_BASE = 'http://localhost:4000';

/** Log in as staff admin via the UI. Returns when the staff nav is visible. */
export async function loginAsAdmin(page: Page) {
  await page.goto('/staff/login');
  await page.locator('#admin-practice').fill(ADMIN.practiceName);
  await page.locator('#admin-email').fill(ADMIN.email);
  await page.locator('#admin-password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Wait for any staff page — the exact path depends on session state
  await page.waitForFunction(
    () => window.location.pathname.startsWith('/staff/') && !window.location.pathname.includes('login'),
    { timeout: 15_000 },
  );
}

/** Log in as a patient via the patient portal login form. */
export async function loginAsPatient(
  page: Page,
  firstName: string,
  lastName: string,
  dob: string,
) {
  await page.goto('/parent/login');
  await page.locator('#signin-first').fill(firstName);
  await page.locator('#signin-last').fill(lastName);
  await page.locator('#signin-dob').fill(dob);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/parent/dashboard', { timeout: 15_000 });
}

/**
 * Verify identity on the portal page (/fill/portal/:token).
 * Returns when the "Still to do" or "No forms" section is visible.
 */
export async function verifyPortalIdentity(
  page: Page,
  firstName: string,
  lastName: string,
  dob: string,
) {
  await page.locator('#portal-first-name').fill(firstName);
  await page.locator('#portal-last-name').fill(lastName);
  await page.locator('#portal-dob').fill(dob);
  await page.getByRole('button', { name: /view my forms/i }).click();
}

/**
 * Generic form-step filler: fills visible text/date inputs, ticks first
 * radio in each group, selects first non-placeholder option in selects,
 * then clicks the primary action button ("Next" or "Save & Continue").
 */
export async function fillFormStep(page: Page) {
  // Text / email / tel inputs
  const textInputs = page.locator(
    'input[type="text"]:visible, input[type="email"]:visible, input[type="tel"]:visible',
  );
  for (const input of await textInputs.all()) {
    const type = await input.getAttribute('type');
    const value = await input.inputValue();
    if (value) continue;
    if (type === 'email') await input.fill('test@example.com');
    else if (type === 'tel') await input.fill('5555550100');
    else await input.fill('Test');
  }

  // Date inputs
  const dateInputs = page.locator('input[type="date"]:visible');
  for (const input of await dateInputs.all()) {
    const value = await input.inputValue();
    if (!value) await input.fill('2020-01-15');
  }

  // Number inputs
  const numberInputs = page.locator('input[type="number"]:visible');
  for (const input of await numberInputs.all()) {
    const value = await input.inputValue();
    if (!value) await input.fill('0');
  }

  // Radio groups — click the first visible option in each named group
  const radioNames = await page.locator('input[type="radio"]:visible').evaluateAll(
    (els) => [...new Set(els.map((el) => (el as HTMLInputElement).name))],
  );
  for (const name of radioNames) {
    const radios = page.locator(`input[type="radio"][name="${name}"]:visible`);
    const checked = await radios.filter({ has: page.locator(':checked') }).count();
    if (!checked) await radios.first().check();
  }

  // Selects — pick first non-empty option
  const selects = page.locator('select:visible');
  for (const select of await selects.all()) {
    const value = await select.inputValue();
    if (!value) {
      const firstOption = select.locator('option:not([value=""]):not([disabled])').first();
      const optionValue = await firstOption.getAttribute('value');
      if (optionValue) await select.selectOption(optionValue);
    }
  }

  // Advance the step
  const nextBtn = page
    .getByRole('button', { name: /next|continue|save & continue|save and continue/i })
    .first();
  if (await nextBtn.isVisible()) {
    await nextBtn.click();
  }
}
