/**
 * Regression for the Nov 6 2026 blank board.
 * Parlay `why` may be a string (current pipeline) or an array of lines (older publishes).
 * Run: node tests/render-regression.mjs
 * Requires Google Chrome and serves this repo on a local port.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = process.env.SHOT_DIR || "/tmp/dp-render-shots";
fs.mkdirSync(shots, { recursive: true });

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log("  ok", msg);
}

function textLinesFrom(file) {
  const src = fs.readFileSync(path.join(root, file), "utf8");
  const m = src.match(/function textLines\(w\)\{[\s\S]*?return out;\}/);
  if (!m) throw new Error("textLines missing in " + file);
  return new Function("return " + m[0])();
}

function unit() {
  console.log("unit textLines");
  for (const file of ["index.html", "full.html"]) {
    const textLines = textLinesFrom(file);
    assert(JSON.stringify(textLines(null)) === "[]", file + " null");
    assert(JSON.stringify(textLines("")) === "[]", file + " empty");
    assert(JSON.stringify(textLines("R17 flag")) === JSON.stringify(["R17 flag"]), file + " string");
    assert(JSON.stringify(textLines("a\n\n b ")) === JSON.stringify(["a", "b"]), file + " multiline");
    assert(JSON.stringify(textLines(["x", "", null, " y "])) === JSON.stringify(["x", "y"]), file + " array");
    assert(!srcHasWhyMap(file), file + " does not call pl.why.map");
  }
}

function srcHasWhyMap(file) {
  return fs.readFileSync(path.join(root, file), "utf8").includes("pl.why.map");
}

function whyFixture(which) {
  let html = fs.readFileSync(path.join(root, which), "utf8");
  const needle = '"parlays":[]';
  if (!html.includes(needle)) throw new Error("expected empty parlays in " + which);
  const injected = '"parlays":[{"name":"+300","am":210,"legs":[["Synth","PTS",10]],"why":["array line one","array line two"]},{"name":"+200","am":100,"legs":[["Synth","PTS",10]],"why":null}]';
  return html.replace(needle, injected);
}

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/fixture/why-array.html" || url.pathname === "/fixture/why-array-full.html") {
        const which = url.pathname.includes("full") ? "full.html" : "index.html";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(whyFixture(which));
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === "/") rel = "/index.html";
      const file = path.join(root, rel);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end("no"); return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function req(method, url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method }, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    r.on("error", reject);
    r.end();
  });
}

async function chrome() {
  const chromeBin = process.env.CHROME || "google-chrome";
  const port = 9333;
  const proc = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/dp-regression-chrome", "about:blank"
  ], { stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    try {
      await req("GET", `http://127.0.0.1:${port}/json/version`);
      return { proc, port };
    } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  proc.kill();
  throw new Error("Chrome did not start");
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const e = msg.params.exceptionDetails;
      errors.push((e.exception && e.exception.description) || e.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "assert")) {
      errors.push(msg.params.args.map((a) => a.description || a.value || "").join(" "));
    }
  };
  const ready = new Promise((r) => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
  return { ws, ready, send, errors };
}

async function openPage(port, url, width = 1280, height = 1400) {
  const created = await req("PUT", `http://127.0.0.1:${port}/json/new?about:blank`);
  const cdp = connect(created.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  await cdp.send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, 1400));
  return { cdp, id: created.id, port };
}

async function closePage(page) {
  try { page.cdp.ws.close(); } catch {}
  try { await req("GET", `http://127.0.0.1:${page.port}/json/close/${page.id}`); } catch {}
}

async function evalJson(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + " " + (res.exceptionDetails.exception && res.exceptionDetails.exception.description));
  return res.result.value;
}

async function shot(cdp, name) {
  const img = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = path.join(shots, name);
  fs.writeFileSync(file, Buffer.from(img.data, "base64"));
  return file;
}

async function checkPage(port, page) {
  console.log("browser", page);
  const opened = await openPage(port, page);
  const cdp = opened.cdp;
  const boot = await evalJson(cdp, `JSON.stringify({
    title: document.title,
    blank: (document.body.innerText||"").length < 80,
    fail: document.body.innerText.includes("could not be drawn"),
    parlays: document.querySelectorAll("#s-parlays article.pl").length,
    slip: document.querySelectorAll("#s-parlays [data-load]").length,
    board: document.querySelector("#s-parlays").innerText,
    nov6hist: DATA.hist.filter(e => e.date==="2026-11-06").length,
    parlayN: (DATA.cfg.parlays||[]).length,
    live: document.querySelector("#s-live").innerText,
    props: document.querySelector("#s-props").innerText.length,
    inj: document.querySelector("#s-inj").innerText.length,
    ranks: document.querySelector("#s-ranks").innerText.length,
    recCards: document.querySelectorAll("#s-rec details.rp").length,
    recPage: (document.querySelector("#s-rec .recpgi")||{}).textContent || "",
    liveId: (DATA.live[DATA.live.length-1]||{}).id,
    livePrice: (DATA.live[DATA.live.length-1]||{}).price,
    hist: DATA.hist.length,
    pending: DATA.hist.filter(e => e.result==="pending").length,
    won: DATA.hist.filter(e => e.result==="won").length,
    lost: DATA.hist.filter(e => e.result==="lost").length
  })`);
  const s = JSON.parse(boot);
  assert(!s.blank, page + " is not blank");
  assert(!s.fail, page + " has no section failure");
  assert(cdp.errors.length === 0, page + " has no console exceptions (" + cdp.errors.length + ")");
  assert(s.parlays === 0 && s.slip === 0 && s.parlayN === 0 && s.nov6hist === 0, page + " has no Nov 6 pregame cards");
  assert(s.board.includes("No pregame parlays posted tonight"), page + " says no pregame posted");
  assert(s.board.includes("FLAG +300") && s.board.includes("+210") && s.board.includes("NOT posted"), page + " shows +300 flag");
  assert(s.board.includes("FLAG +200") && s.board.includes("327") && s.board.includes("NOT posted"), page + " shows +200 flag");
  assert(s.board.includes("NO compliant") && s.board.includes("2-Leg"), page + " shows Straight and 2-Leg left out");
  assert(!s.board.includes("2026-11-06"), page + " parlays board has no Nov 6 history row");
  assert(s.live.includes("MIN") && s.live.includes("Under 232.5") && s.live.includes("+169") && s.live.includes("9:04 PM"), page + " shows MIN live ticket");
  assert(s.liveId === "L1106-210446-MIN-NO" && s.livePrice === 169, page + " live payload unchanged");
  assert(s.hist === 21 && s.pending === 0 && s.won === 8 && s.lost === 13, page + " history is 21 graded, no pending pregame");
  assert(s.props > 100 && s.inj > 20 && s.ranks > 20, page + " props, injuries, and ranks render");
  assert(s.recCards === 4 && s.recPage.includes("Page 1 of 6"), page + " record is 4 per page");

  await evalJson(cdp, `document.querySelector('#tabs [data-t="parlays"]').click(); document.querySelector('#s-parlays').scrollIntoView()`);
  await shot(cdp, page.includes("full") ? "full-parlays.png" : "index-parlays.png");

  const grades = await evalJson(cdp, `(() => {
    document.querySelector('#tabs [data-t="rec"]').click();
    window.REC_PG = 0; renderRec();
    const got = [];
    const dates = [];
    const pages = Math.ceil(DATA.hist.length / 4);
    for (let i = 0; i < pages; i++) {
      window.REC_PG = i; renderRec();
      document.querySelectorAll("#s-rec details.rp").forEach(d => { got.push(d.querySelector(".res").textContent); dates.push(d.innerText.slice(0, 10)); });
    }
    window.REC_PG = 0; renderRec();
    const expect = {};
    DATA.hist.forEach(e => { expect[e.result] = (expect[e.result] || 0) + 1; });
    const seen = {};
    got.forEach(r => { const k = r.toLowerCase(); seen[k] = (seen[k] || 0) + 1; });
    return JSON.stringify({ n: got.length, expect, seen, dates, page: document.querySelector("#s-rec .recpgi").textContent, cards: document.querySelectorAll("#s-rec details.rp").length });
  })()`);
  const g = JSON.parse(grades);
  assert(g.n === 21 && g.cards === 4 && g.page === "Page 1 of 6", page + " record pager resets to 4 cards");
  assert(!g.seen.pending, page + " record counts no pending pregame");
  assert(!g.dates.includes("2026-11-06"), page + " record has no Nov 6 pregame row");
  for (const key of Object.keys(g.expect)) {
    assert(g.seen[key] === g.expect[key], page + " grade " + key + " " + g.seen[key] + " vs " + g.expect[key]);
  }

  // tabs
  for (const tab of ["rec", "live", "props", "ranks", "inj", "parlays"]) {
    const shown = await evalJson(cdp, `(() => {
      document.querySelector('#tabs [data-t="${tab}"]').click();
      const on = document.body.dataset.tab;
      const section = document.getElementById("s-" + on);
      return on + ":" + (section && section.innerText.length > 30);
    })()`);
    assert(shown === tab + ":true", page + " tab " + tab);
  }

  // record pagination walks every card; grades stay the published results
  const walked = await evalJson(cdp, `(() => {
    document.querySelector('#tabs [data-t="rec"]').click();
    const seen = [];
    for (let i = 0; i < 8; i++) {
      const label = document.querySelector("#s-rec .recpgi").textContent;
      const cards = [...document.querySelectorAll("#s-rec details.rp")].map(d => d.innerText.split("\\n").slice(0, 3).join(" | "));
      seen.push(label + "#" + cards.length);
      const next = document.querySelector("#s-rec [data-recnext]");
      if (next && !next.disabled) next.click();
      else break;
    }
    const results = [...document.querySelectorAll("#s-rec .res")].map(n => n.textContent);
    return JSON.stringify({ seen, page1: seen[0], last: seen[seen.length-1], resOnLast: results });
  })()`);
  const w = JSON.parse(walked);
  assert(w.seen.length === 6, page + " record has 6 pages");
  assert(w.seen.every((row, i) => row.startsWith("Page " + (i + 1) + " of 6#") && (i < 5 ? row.endsWith("#4") : row.endsWith("#1"))), page + " pages are 4,4,4,4,4,1");
  await evalJson(cdp, `window.REC_PG=0; renderRec();`);
  await shot(cdp, page.includes("full") ? "full-record-p1.png" : "index-record-p1.png");
  await evalJson(cdp, `window.REC_PG=1; renderRec();`);
  await shot(cdp, page.includes("full") ? "full-record-p2.png" : "index-record-p2.png");

  await evalJson(cdp, `document.querySelector('#tabs [data-t="live"]').click(); document.querySelector('#s-live').scrollIntoView();`);
  await shot(cdp, page.includes("full") ? "full-live.png" : "index-live.png");

  if (!page.includes("full")) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await evalJson(cdp, `document.querySelector('#tabs [data-t="parlays"]').click()`);
    await new Promise((r) => setTimeout(r, 200));
    const mobile = await evalJson(cdp, `document.querySelectorAll("#s-parlays article.pl").length + ":" + document.body.dataset.tab + ":" + document.querySelector("#s-parlays").innerText.includes("NOT posted")`);
    assert(mobile === "0:parlays:true", "index mobile shows the no-post flags, not tickets");
    await shot(cdp, "index-mobile-parlays.png");
  }
  await closePage(opened);
}

async function checkWhyFixture(port, url, label) {
  console.log("browser", label);
  const opened = await openPage(port, url);
  const info = await evalJson(opened.cdp, `JSON.stringify({
    parlays: document.querySelectorAll("#s-parlays article.pl").length,
    first: [...document.querySelectorAll("#s-parlays article.pl")][0].innerText,
    second: [...document.querySelectorAll("#s-parlays article.pl")][1].innerText,
    paras: document.querySelector("#s-parlays article.pl").querySelectorAll(":scope > .ins p").length
  })`);
  const s = JSON.parse(info);
  assert(opened.cdp.errors.length === 0, label + " no exceptions");
  assert(s.parlays === 2 && s.paras === 2 && s.first.includes("array line one") && s.first.includes("array line two"), label + " array why renders as paragraphs");
  assert(!s.second.includes("best achievable -327"), label + " null why is omitted");
  await closePage(opened);
}

async function main() {
  unit();
  const server = await serve();
  const addr = server.address();
  const base = `http://127.0.0.1:${addr.port}`;
  const browser = await chrome();
  try {
    await checkPage(browser.port, base + "/index.html");
    await checkPage(browser.port, base + "/full.html");
    await checkWhyFixture(browser.port, base + "/fixture/why-array.html", "index array why");
    await checkWhyFixture(browser.port, base + "/fixture/why-array-full.html", "full array why");
  } finally {
    browser.proc.kill();
    server.close();
  }
  if (failures.length) {
    console.error("FAILED");
    failures.forEach((f) => console.error(" -", f));
    process.exit(1);
  }
  console.log("ALL PASSED");
}

main().catch((err) => { console.error(err); process.exit(1); });
