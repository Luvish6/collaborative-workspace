import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { createWorkspace } from "../src/server.js";
import { openStore } from "../src/store.js";

const directory = await mkdtemp(join(tmpdir(), "workspace-browser-"));
const file = join(directory, "workspace.sqlite");
let app;
let browser;
let port;

async function start() {
  app = await createWorkspace({ store: await openStore({ file }) });
  app.server.listen(port || 0, "127.0.0.1");
  await once(app.server, "listening");
  port = app.server.address().port;
  return "http://127.0.0.1:" + port;
}

async function waitForText(page, selector, value) {
  await page.waitForFunction(([selector, value]) => {
    const control = document.querySelector(selector);
    return (control.value ?? control.textContent).includes(value);
  }, [selector, value]);
}

try {
  const base = await start();
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXE || undefined });
  const first = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const second = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const a = await first.newPage();
  const b = await second.newPage();
  const errors = [];
  for (const page of [a, b]) page.on("pageerror", error => errors.push(error.message));
  const responses = new Map();
  a.on("response", response => responses.set(new URL(response.url()).pathname, response));

  await a.route("**/health", route => route.fulfill({ status: 503, json: { status: "unavailable" } }));
  await a.goto(base);
  await waitForText(a, "#service-message", "Server unavailable");
  assert.equal(await a.getByRole("button", { name: "Create workspace" }).isDisabled(), true);
  await a.unroute("**/health");
  await a.getByRole("button", { name: "Retry" }).click();
  await waitForText(a, "#service-message", "Server online");
  for (const [asset, mime] of [["/style.css", "text/css"], ["/app.js", "text/javascript"]]) {
    assert.equal(responses.get(asset).status(), 200);
    assert.match(responses.get(asset).headers()["content-type"], new RegExp(mime));
  }
  assert.equal(await a.locator(".hero").evaluate(element => getComputedStyle(element).display), "grid");

  await a.getByRole("button", { name: "Open documents" }).click();
  assert.equal(await a.getByText("No recent documents yet", { exact: false }).isVisible(), true);
  await a.getByRole("button", { name: "New document" }).click();
  await a.getByLabel("Document title").fill("Release notes");
  await a.getByLabel("Document text").fill("First draft");
  await waitForText(a, "#status", "Saved");
  await a.getByRole("button", { name: "Share invite" }).click();
  const invite = await a.evaluate(() => navigator.clipboard.readText());
  assert.equal(invite, a.url());
  const exported = a.waitForEvent("download");
  await a.getByRole("button", { name: "Export .txt" }).click();
  assert.equal((await exported).suggestedFilename(), "shared-document.txt");

  await b.goto(base + "/#documents");
  await b.getByLabel("Open an invite link").fill(invite);
  await b.getByRole("button", { name: "Open", exact: true }).click();
  await waitForText(b, "#document", "First draft");
  await waitForText(b, "#document-title", "Release notes");
  await b.getByLabel("Your display name").fill("Taylor");
  await b.getByLabel("Your display name").press("Tab");
  await waitForText(a, "#people", "Taylor");
  assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await Promise.all([
    a.getByLabel("Document text").press("Home").then(() => a.getByLabel("Document text").pressSequentially("Alpha ")),
    b.getByLabel("Document text").press("End").then(() => b.getByLabel("Document text").pressSequentially(" Beta"))
  ]);
  for (const page of [a, b]) {
    await waitForText(page, "#document", "Alpha");
    await waitForText(page, "#document", "Beta");
  }
  assert.equal(await a.locator("#document").inputValue(), await b.locator("#document").inputValue());
  await waitForText(a, "#status", "Saved");
  await waitForText(b, "#status", "Saved");
  await b.reload();
  await waitForText(b, "#document-title", "Release notes");

  await app.close();
  app = undefined;
  await waitForText(a, "#status", "Offline");
  await a.getByLabel("Document text").press("End");
  await a.getByLabel("Document text").pressSequentially(" Offline edit");
  await start();
  await waitForText(b, "#document", "Offline edit");
  await waitForText(a, "#status", "Saved");

  const third = await browser.newContext();
  const c = await third.newPage();
  await c.goto(invite);
  await waitForText(c, "#document", "Offline edit");
  await waitForText(c, "#document-title", "Release notes");
  await a.getByRole("button", { name: "← Documents" }).click();
  await a.getByRole("link", { name: /Release notes/ }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Browser regression passed: assets, outage, dashboard, invite, two sessions, presence, mobile, refresh, offline recovery and database restart.");
} finally {
  if (browser) await browser.close();
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
