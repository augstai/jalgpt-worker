import http from "node:http";
import { chromium } from "playwright";

/**
 * jalgpt browser worker.
 *  POST /scrape { urls }                       -> { text }
 *  POST /fill   { url, values, submit }        -> { ok, status, filled }
 *  GET  /health                                -> { ok }
 * Auth: Authorization: Bearer <WORKER_TOKEN> (if set).
 * Form-field detection is deterministic and runs IN the browser, so it works on
 * JS-rendered forms. No LLM. `values` keys: name, email, company, phone, subject, message.
 */

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.WORKER_TOKEN || "";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
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
        /* skip */
      } finally {
        await page.close().catch(() => {});
      }
    }
    return text.slice(0, 30000);
  } finally {
    await browser.close().catch(() => {});
  }
}

// Deterministic field matcher (multilingual: EN + ES for LatAm buyers).
const FIELD_SPECS = {
  email: { type: ["email"], kw: ["email", "e-mail", "correo", "mail"] },
  message: { tag: ["textarea"], kw: ["message", "mensaje", "comment", "enquiry", "inquiry", "consulta", "details", "query", "msg"] },
  name: { kw: ["name", "nombre", "fullname"], neg: ["company", "empresa", "user", "file", "last", "first", "subject"] },
  company: { kw: ["company", "empresa", "organization", "organisation", "business", "compania", "compañia"] },
  phone: { type: ["tel"], kw: ["phone", "tel", "mobile", "whatsapp", "telefono", "teléfono", "celular"] },
  subject: { kw: ["subject", "asunto", "topic"] },
};
// Runs in the browser: tags each fillable field with data-jf and returns its mapping.
function detectFields(specs) {
  function labelText(el) {
    if (el.id) {
      const l = document.querySelector('label[for="' + el.id + '"]');
      if (l) return l.innerText || "";
    }
    const p = el.closest("label");
    return p ? p.innerText || "" : "";
  }
  const all = Array.from(document.querySelectorAll("form input, form textarea, input, textarea"));
  const fields = [];
  all.forEach((el, i) => {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (["submit", "button", "checkbox", "radio", "file", "hidden", "image", "reset", "search", "password"].includes(type)) return;
    if (el.type === "hidden" || el.offsetParent === null) return;
    el.setAttribute("data-jf", String(i));
    fields.push({
      i,
      tag: el.tagName.toLowerCase(),
      type,
      hay: [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), labelText(el)]
        .join(" ")
        .toLowerCase(),
    });
  });
  const score = (f, spec) => {
    let s = 0;
    if (spec.type && spec.type.includes(f.type)) s += 5;
    if (spec.tag && spec.tag.includes(f.tag)) s += 4;
    for (const k of spec.kw) if (f.hay.includes(k)) s += 3;
    if (spec.neg) for (const k of spec.neg) if (f.hay.includes(k)) s -= 4;
    return s;
  };
  const map = {};
  const used = new Set();
  for (const field of ["email", "message", "name", "company", "phone", "subject"]) {
    let best = -1, bestScore = 0;
    for (const f of fields) {
      if (used.has(f.i)) continue;
      const sc = score(f, specs[field]);
      if (sc > bestScore) {
        bestScore = sc;
        best = f.i;
      }
    }
    if (best >= 0) {
      map[field] = best;
      used.add(best);
    }
  }
  if (map.message == null) {
    const ta = fields.find((f) => f.tag === "textarea" && !used.has(f.i));
    if (ta) (map.message = ta.i), used.add(ta.i);
  }
  if (map.name == null) {
    const t = fields.find((f) => f.tag === "input" && (f.type === "" || f.type === "text") && !used.has(f.i));
    if (t) (map.name = t.i), used.add(t.i);
  }
  return map;
}

async function clickSubmit(page) {
  try {
    const b = await page.$('button[type="submit"], input[type="submit"]');
    if (b) {
      await b.click({ timeout: 3000 });
      return true;
    }
  } catch {}
  try {
    const btns = await page.$$("form button, form input[type='button'], button");
    for (const b of btns) {
      const txt = (((await b.innerText().catch(() => "")) || (await b.getAttribute("value").catch(() => "")) || "")).toLowerCase();
      if (/send|submit|enviar|contact|message|enquir/.test(txt)) {
        await b.click({ timeout: 3000 });
        return true;
      }
    }
  } catch {}
  return false;
}

async function fill({ url, values, submit }) {
  const browser = await chromium.launch(LAUNCH);
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(800);
    const map = await page.evaluate(`(${detectFields.toString()})(${JSON.stringify(FIELD_SPECS)})`);
    const filled = [];
    for (const [field, idx] of Object.entries(map || {})) {
      const v = values?.[field];
      if (v == null || v === "" || idx == null) continue;
      try {
        await page.fill(`[data-jf="${idx}"]`, String(v), { timeout: 4000 });
        filled.push(field);
      } catch {
        /* per-field best effort */
      }
    }
    if (filled.length === 0) return { ok: false, status: "no_form_fields", filled };
    let status = "filled";
    if (submit) status = (await clickSubmit(page)) ? "submitted" : "filled_no_submit";
    if (status === "submitted") await page.waitForTimeout(1500);
    return { ok: filled.length > 0, status, filled };
  } catch (e) {
    return { ok: false, status: "error", error: String(e).slice(0, 200), filled: [] };
  } finally {
    await browser.close().catch(() => {});
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") return send(res, 200, { ok: true });
  if (TOKEN && (req.headers.authorization || "") !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
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
