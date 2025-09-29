// scripts/poll.js (CommonJS, safe for GitHub Actions)
// Polls Squarespace orders and posts events to Klaviyo.
// Keeps processed IDs in data/processed.json and commits updates back to repo.

const fs = require("fs");
const { execSync } = require("child_process");

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const POLL_WINDOW_MINUTES = parseInt(process.env.POLL_WINDOW_MINUTES || "1440", 10);
const PROCESSED_FILE = "data/processed.json";
const TEST_FORWARD = (process.env.TEST_FORWARD || "false").toLowerCase() === "true";

if (!SQUARESPACE_API_KEY) throw new Error("Missing SQUARESPACE_API_KEY (set as repository secret)");
if (!KLAVIYO_API_KEY) throw new Error("Missing KLAVIYO_API_KEY (set as repository secret)");

function log(...args) { console.log(new Date().toISOString(), ...args); }

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, json: JSON.parse(text), text }; }
  catch (e) { return { ok: res.ok, status: res.status, json: null, text }; }
}

function loadProcessed() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) return [];
    const raw = fs.readFileSync(PROCESSED_FILE, "utf8");
    return JSON.parse(raw || "[]");
  } catch (e) {
    log("Error reading processed file, starting fresh:", e.message);
    return [];
  }
}
function saveProcessed(arr) {
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr.slice(-1000), null, 2), "utf8");
}

function gitCommitAndPush(message) {
  try {
    execSync("git config user.name 'sqsp-poller-bot'", { stdio: "ignore" });
    execSync("git config user.email 'sqsp-poller-bot@example.com'", { stdio: "ignore" });
    execSync(`git add ${PROCESSED_FILE}`, { stdio: "inherit" });
    try {
      execSync(`git commit -m "${message}"`, { stdio: "inherit" });
    } catch (e) {
      // commit exits non-zero if no changes; ignore
      log("No changes to commit.");
      return;
    }
    execSync("git push", { stdio: "inherit" });
    log("Committed processed file changes.");
  } catch (err) {
    log("Git push failed:", err.message);
    throw err;
  }
}

function isRecent(iso) {
  if (!iso) return false;
  const created = new Date(iso).getTime();
  return (Date.now() - created) <= POLL_WINDOW_MINUTES * 60 * 1000;
}

function buildKlaviyoPayload(order, isCourse, eventName) {
  return {
    data: {
      type: "event",
      attributes: {
        time: order.createdOn || new Date().toISOString(),
        properties: {
          order_id: order.id,
          order_number: order.orderNumber,
          total: order.grandTotal && order.grandTotal.value ? order.grandTotal.value : null,
          currency: order.grandTotal && order.grandTotal.currency ? order.grandTotal.currency : null,
          items: (order.lineItems || []).map(i => ({
            name: i.productName || i.name,
            sku: i.sku,
            qty: i.quantity,
            price: (i.unitPricePaid && i.unitPricePaid.value) ? i.unitPricePaid.value : i.price,
            type: i.lineItemType
          })),
          source: "Squarespace-poll"
        },
        metric: { data: { type: "metric", attributes: { name: eventName } } },
        profile: { data: { type: "profile", attributes: { email: order.customerEmail } } }
      }
    }
  };
}

async function sendToKlaviyo(payload) {
  const url = "https://a.klaviyo.com/api/events";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "revision": "2024-10-15",
      "Authorization": `Klaviyo-API-Key ${KLAVIYO_API_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}

async function run() {
  log("Poll started.");

  const processed = loadProcessed();
  log("Loaded processed count:", processed.length);

  const sqsp = await fetchJson("https://api.squarespace.com/1.0/commerce/orders", {
    headers: { Authorization: `Bearer ${SQUARESPACE_API_KEY}`, "Content-Type": "application/json" }
  });
  if (!sqsp.ok) {
    log("Squarespace fetch failed:", sqsp.status, sqsp.text.slice(0, 300));
    throw new Error("Squarespace fetch failed: " + sqsp.status);
  }

  const orders = Array.isArray(sqsp.json.result) ? sqsp.json.result : [];
  log("Orders returned:", orders.length);

  const recentOrders = orders.filter(o => o.createdOn && isRecent(o.createdOn)).sort((a,b)=> new Date(a.createdOn)-new Date(b.createdOn));
  log("Recent orders to consider:", recentOrders.length);

  const newProcessed = [];
  for (const order of recentOrders) {
    try {
      if (processed.includes(order.id)) {
        log("Skip already processed:", order.id);
        continue;
      }
      if (order.testmode === true || order.testmode === "true") {
        log("Skipping test order:", order.id);
        processed.push(order.id);
        newProcessed.push({ id: order.id, skipped: true });
        continue;
      }

      const hasCourse = (order.lineItems || []).some(li=> li.lineItemType === "PAYWALL_PRODUCT");
      const eventName = hasCourse ? "Course Purchased" : "Product Purchased";
      const payload = buildKlaviyoPayload(order, hasCourse, eventName);

      if (!TEST_FORWARD) {
        log(`[DRY-RUN] Would forward order ${order.id} as "${eventName}" (set TEST_FORWARD=true to actually send)`);
        processed.push(order.id);
        newProcessed.push({ id: order.id, action: "dry" });
        continue;
      }

      log("Sending order to Klaviyo:", order.id, "event:", eventName);
      const kl = await sendToKlaviyo(payload);
      if (!kl.ok) {
        log("Klaviyo rejected:", kl.status, kl.text.slice(0,250));
        newProcessed.push({ id: order.id, klaviyoStatus: kl.status, klaviyoBody: kl.text.slice(0,200) });
      } else {
        log("Klaviyo accepted order:", order.id, "status:", kl.status);
        processed.push(order.id);
        newProcessed.push({ id: order.id, klaviyoStatus: kl.status });
      }
    } catch (err) {
      log("Error processing order", order.id, err && err.message ? err.message : err);
    }
  }

  saveProcessed(processed);
  log("Saved processed.json, total entries now:", processed.length);

  try {
    gitCommitAndPush(`Update processed orders @ ${new Date().toISOString()}`);
  } catch (e) {
    log("Failed to git commit/push processed.json:", e.message);
  }

  log("Poll complete. Summary:", newProcessed.length, "changed.");
  if (newProcessed.length) console.log(JSON.stringify(newProcessed, null, 2));
}

run().catch(err => {
  console.error("Poll script failed:", err && err.stack ? err.stack : err);
  process.exit(1);
});
