import http from "node:http";
import { chromium } from "playwright";

/**
 * jalgpt browser worker.
 *  POST /scrape { urls: string[] }                          -> { text }
 *  POST /fill   { url, mapping, values, submitSelector? }   -> { ok, status }
 *  GET  /health                                             -> { ok }
 * Auth: Authorization: Bearer <WORKER_TOKEN> (if WORKER_TOKEN is set).
 * Browser is launched per-request (low idle memory — friendly to free tiers).
 */

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.WORKER_TOKEN || "";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Memory-frugal flags so Chromium fits a 512MB free instance.
const LAUNCH = {
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process", "--no-zygote"],
};

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(b || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

async function scrape(urls) {
  const browser = await chromium.launch(LAUNCH);
  try {
    const ctx = await browser.newContext({ userAgent: UA });
    let text = "";
    for (const url of (urls || []).slice(0, 8)) {
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(800);
        const links = await page
          .$$eval('a[href^="mailto:"], a[href^="tel:"]', (els) => els.map((e) => e.getAttribute("href")).join(" "))
          .catch(() => "");
        const body = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
        text += `\n[${url}]\n${links}\n${body}`;
      } catch {
        /* skip bad page */
      } finally {
        await page.close().catch(() => {});
      }
    }
    return text.slice(0, 30000);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fill({ url, mapping, values, submitSelector }) {
  const browser = await chromium.launch(LAUNCH);
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    for (const [field, selector] of Object.entries(mapping || {})) {
      const v = values?.[field];
      if (!v || !selector) continue;
      try {
        await page.fill(selector, String(v), { timeout: 5000 });
      } catch {
        /* best-effort per field */
      }
    }
    let status = "filled";
    if (submitSelector) {
      try {
        await page.click(submitSelector, { timeout: 5000 });
        await page.waitForTimeout(1500);
      } catch {
        status = "submit_failed";
      }
    }
    return { ok: status === "filled", status };
  } catch (e) {
    return { ok: false, status: "error", error: String(e).slice(0, 200) };
  } finally {
    await browser.close().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (TOKEN) {
    if ((req.headers.authorization || "") !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
  }
  if (req.method !== "POST") return send(res, 404, { error: "not found" });
  const body = await readBody(req);
  try {
    if (req.url === "/scrape") return send(res, 200, { text: await scrape(body.urls) });
    if (req.url === "/fill") return send(res, 200, await fill(body));
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String(e).slice(0, 200) });
  }
});

server.listen(PORT, () => console.log(`jalgpt worker listening on :${PORT}`));
