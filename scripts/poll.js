// scripts/poll.js (PRODUCTION - CommonJS)
const fs = require("fs");
const { execSync } = require("child_process");

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const POLL_WINDOW_MINUTES = parseInt(process.env.POLL_WINDOW_MINUTES || "1440", 10);
const PROCESSED_FILE = "data/processed.json";

// New, clear env flag:
const SEND_TO_KLAVIYO = (process.env.SEND_TO_KLAVIYO || "true").toLowerCase() === "true";
// Optional inclusion flags:
const INCLUDE_FULFILLED = (process.env.INCLUDE_FULFILLED || "true").toLowerCase() === "true";
const INCLUDE_REFUNDED = (process.env.INCLUDE_REFUNDED || "true").toLowerCase() === "true";

if (!SQUARESPACE_API_KEY || !KLAVIYO_API_KEY) {
  console.error("Missing required secrets.");
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text), text };
  } catch (e) {
    return { ok: res.ok, status: res.status, json: null, text };
  }
}

/**
 * Processed file format:
 * - old format: [ "orderId1", "orderId2", ... ]  (legacy)
 * - new format: { "<orderId>": ["Product Purchased","Order Fulfilled"], ... }
 *
 * When loading, we auto-migrate legacy arrays into the new object map.
 */
function loadProcessed() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) return {};
    const raw = fs.readFileSync(PROCESSED_FILE, "utf8") || "";
    if (!raw) return {};
    const parsed = JSON.parse(raw);

    // If legacy array format, migrate to map
    if (Array.isArray(parsed)) {
      const migrated = {};
      for (const id of parsed) {
        migrated[id] = ["Product Purchased"]; // assume purchased was recorded
      }
      log("🔁 Migrated processed.json from legacy array -> event-map");
      return migrated;
    }

    // Already in correct shape
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    log("⚠️ Failed to load processed file:", e.message);
    return {};
  }
}

function saveProcessed(map) {
  try {
    fs.mkdirSync(require("path").dirname(PROCESSED_FILE), { recursive: true });
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch (e) {
    log("⚠️ Failed to save processed file:", e.message);
  }
}

function gitCommitAndPush(message) {
  try {
    execSync("git config user.name 'sqsp-poller-bot'", { stdio: "ignore" });
    execSync("git config user.email 'sqsp-poller-bot@example.com'", { stdio: "ignore" });
    execSync(`git add ${PROCESSED_FILE}`, { stdio: "ignore" });
    execSync(`git commit -m "${message}"`, { stdio: "ignore" });
    execSync("git push", { stdio: "ignore" });
  } catch (err) {
    // ignore push errors (rare org/policy cases)
  }
}

function isRecent(iso) {
  if (!iso) return false;
  const created = new Date(iso).getTime();
  return Date.now() - created <= POLL_WINDOW_MINUTES * 60 * 1000;
}

function buildKlaviyoPayload(order, eventName) {
  return {
    data: {
      type: "event",
      attributes: {
        time: order.createdOn || new Date().toISOString(),
        properties: {
          order_id: order.id,
          order_number: order.orderNumber,
          total: order.grandTotal?.value || null,
          currency: order.grandTotal?.currency || null,
          items: (order.lineItems || []).map((i) => ({
            name: i.productName || i.name,
            sku: i.sku,
            qty: i.quantity,
            price: i.unitPricePaid?.value || i.price,
            type: i.lineItemType,
          })),
          source: "Squarespace-poll",
        },
        metric: {
          data: { type: "metric", attributes: { name: eventName } },
        },
        profile: {
          data: { type: "profile", attributes: { email: order.customerEmail } },
        },
      },
    },
  };
}

/**
 * Determine current lifecycle events that should be considered for this order.
 * Returns array of event names in priority order.
 */
function detectEventsForOrder(order) {
  const statusText = `${order.financialStatus || ""} ${order.fulfillmentStatus || ""}`.toLowerCase();
  const isCourse = (order.lineItems || []).some((li) => li.lineItemType === "PAYWALL_PRODUCT");

  // Always include purchase event if appropriate (so migration or initial send covers it)
  const events = [];
  events.push(isCourse ? "Course Purchased" : "Product Purchased");

  if (INCLUDE_FULFILLED && (statusText.includes("fulfilled") || statusText.includes("completed") || statusText.includes("shipped"))) {
    events.push("Order Fulfilled");
  }

  if (INCLUDE_REFUNDED && (statusText.includes("refund") || statusText.includes("refunded") || statusText.includes("chargeback"))) {
    events.push("Order Refunded");
  }

  if (statusText.includes("cancel") || statusText.includes("cancelled") || statusText.includes("canceled")) {
    events.push("Order Cancelled");
  }

  // dedupe while preserving order
  return [...new Set(events)];
}

async function sendToKlaviyo(payload) {
  try {
    const res = await fetch("https://a.klaviyo.com/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        revision: "2024-10-15",
        Authorization: `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: e.message };
  }
}

async function run() {
  const processed = loadProcessed(); // object map: { orderId: [eventsSent...] }
  const sqsp = await fetchJson("https://api.squarespace.com/1.0/commerce/orders", {
    headers: {
      Authorization: `Bearer ${SQUARESPACE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!sqsp.ok) {
    log("Squarespace fetch failed:", sqsp.status);
    return;
  }

  const orders = Array.isArray(sqsp.json.result) ? sqsp.json.result : [];
  // keep previous behaviour: only consider orders created recently — BUT also allow updates for older orders
  const recentOrUpdated = orders
    .filter((o) => {
      if (!o) return false;
      // always include if createdOn recent
      if (o.createdOn && isRecent(o.createdOn)) return true;
      // also include if it's likely to be updated (contains refunds/fulfillment) and INCLUDE flags enabled
      const statusText = `${o.financialStatus || ""} ${o.fulfillmentStatus || ""}`.toLowerCase();
      if (INCLUDE_REFUNDED && (statusText.includes("refund") || statusText.includes("refunded") || statusText.includes("chargeback"))) return true;
      if (INCLUDE_FULFILLED && (statusText.includes("fulfilled") || statusText.includes("completed") || statusText.includes("shipped"))) return true;
      return false;
    })
    .sort((a, b) => new Date(a.createdOn || 0) - new Date(b.createdOn || 0));

  const processedThisRun = [];
  let eventsSentCount = 0;

  for (const order of recentOrUpdated) {
    try {
      if (!order || !order.id) continue;

      // Skip test orders
      if (order.testmode === true || order.testmode === "true") {
        log(`🧪 Skipping test order ${order.id}`);
        // keep legacy behavior of marking test orders as processed to avoid repeated logs
        if (!processed[order.id]) processed[order.id] = [];
        continue;
      }

      const desiredEvents = detectEventsForOrder(order); // e.g. ["Product Purchased","Order Refunded"]
      if (!processed[order.id]) processed[order.id] = [];

      // determine which events still need sending
      const toSend = desiredEvents.filter((ev) => !processed[order.id].includes(ev));

      if (toSend.length === 0) {
        // nothing new for this order
        continue;
      }

      for (const ev of toSend) {
        const payload = buildKlaviyoPayload(order, ev);

        // event-specific extra props
        if (ev === "Order Refunded") {
          payload.data.attributes.properties.refund_amount =
            order.refunds?.[0]?.amount?.value || order.grandTotal?.value || null;
          payload.data.attributes.properties.refund_reason =
            order.refunds?.[0]?.reason || order.cancellationReason || "N/A";
          payload.data.attributes.properties.status = "refunded";
        } else if (ev === "Order Fulfilled") {
          payload.data.attributes.properties.status = "fulfilled";
        } else if (ev === "Order Cancelled") {
          payload.data.attributes.properties.status = "cancelled";
        }

        if (SEND_TO_KLAVIYO) {
          const kl = await sendToKlaviyo(payload);
          if (kl.ok) {
            // mark this event as sent for this order
            processed[order.id].push(ev);
            processedThisRun.push(`${order.id}::${ev}`);
            eventsSentCount++;
            log(`✅ Sent ${ev} for order ${order.id} (order_number=${order.orderNumber || "n/a"})`);
          } else {
            log(`❌ Failed to send ${ev} for order ${order.id}:`, kl.status, kl.text);
            // do not mark as processed so it will retry next run
          }
        } else {
          // dry run: mark as processed but don't send
          processed[order.id].push(ev);
          processedThisRun.push(`${order.id}::${ev}`);
          log(`🧪 Dry run - marked ${ev} for order ${order.id} as processed`);
        }
      }
    } catch (e) {
      log(`⚠️ Error processing order ${order && order.id ? order.id : "(unknown)"}:`, e.message || e);
      continue;
    }
  }

  // prune processed map to keep size reasonable (keep last 1000 orders)
  const keys = Object.keys(processed);
  if (keys.length > 1000) {
    const keep = keys.slice(-1000);
    const newMap = {};
    for (const k of keep) newMap[k] = processed[k];
    saveProcessed(newMap);
  } else {
    saveProcessed(processed);
  }

  if (processedThisRun.length) {
    gitCommitAndPush(`Update processed orders (${eventsSentCount} events) @ ${new Date().toISOString()}`);
  } else {
    log("No new events to process this run.");
  }
}

run().catch((err) => {
  log("Fatal error:", err && err.message ? err.message : err);
  process.exit(1);
});
