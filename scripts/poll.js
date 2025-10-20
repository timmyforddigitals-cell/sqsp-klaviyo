// scripts/poll.js (PRODUCTION - CommonJS)
const fs = require("fs");
const { execSync } = require("child_process");

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const POLL_WINDOW_MINUTES = parseInt(process.env.POLL_WINDOW_MINUTES || "1440", 10);
const PROCESSED_FILE = "data/processed.json";
const TEST_FORWARD = (process.env.TEST_FORWARD || "false").toLowerCase() === "true";

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

function loadProcessed() {
  try {
    if (!fs.existsSync(PROCESSED_FILE)) return [];
    return JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8") || "[]");
  } catch (e) {
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

// 🧩 Maps Squarespace statuses to Klaviyo events
function getEventName(order) {
  const statusText = `${order.financialStatus || ""} ${order.fulfillmentStatus || ""}`.toLowerCase();
  const isCourse = (order.lineItems || []).some((li) => li.lineItemType === "PAYWALL_PRODUCT");

  if (statusText.includes("refund") || statusText.includes("refunded") || statusText.includes("chargeback")) {
    return "Order Refunded";
  } else if (statusText.includes("cancel") || statusText.includes("cancelled") || statusText.includes("canceled")) {
    return "Order Cancelled";
  } else if (statusText.includes("fulfilled") || statusText.includes("completed") || statusText.includes("shipped")) {
    return "Order Fulfilled";
  } else {
    return isCourse ? "Course Purchased" : "Product Purchased";
  }
}

async function sendToKlaviyo(payload) {
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
}

async function run() {
  const processed = loadProcessed();
  const sqsp = await fetchJson("https://api.squarespace.com/1.0/commerce/orders", {
    headers: {
      Authorization: `Bearer ${SQUARESPACE_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!sqsp.ok) return log("Squarespace fetch failed:", sqsp.status);

  const orders = Array.isArray(sqsp.json.result) ? sqsp.json.result : [];
  const recent = orders
    .filter((o) => o.createdOn && isRecent(o.createdOn))
    .sort((a, b) => new Date(a.createdOn) - new Date(b.createdOn));

  const processedThisRun = [];

  for (const order of recent) {
    try {
      if (processed.includes(order.id)) continue;
      if (order.testmode === true || order.testmode === "true") {
        processed.push(order.id);
        continue;
      }

      const eventName = getEventName(order);
      const payload = buildKlaviyoPayload(order, eventName);

      // Add additional event-specific details
      if (eventName === "Order Refunded") {
        payload.data.attributes.properties.refund_amount =
          order.refunds?.[0]?.amount?.value || order.grandTotal?.value || null;
        payload.data.attributes.properties.refund_reason =
          order.refunds?.[0]?.reason || order.cancellationReason || "N/A";
        payload.data.attributes.properties.status = "refunded";
      }

      if (eventName === "Order Fulfilled") {
        payload.data.attributes.properties.status = "fulfilled";
      }

      if (eventName === "Order Cancelled") {
        payload.data.attributes.properties.status = "cancelled";
      }

      if (TEST_FORWARD) {
        const kl = await sendToKlaviyo(payload);
        if (kl.ok) {
          processed.push(order.id);
          processedThisRun.push(order.id);
          log(`✅ Sent ${eventName} for order ${order.id}`);
        } else {
          log(`⚠️ Failed to send ${eventName} for order ${order.id}:`, kl.status, kl.text);
        }
      } else {
        processed.push(order.id);
        processedThisRun.push(order.id);
      }
    } catch (e) {
      log(`⚠️ Error processing order ${order.id}:`, e.message);
      continue;
    }
  }

  saveProcessed(processed);
  if (processedThisRun.length) {
    gitCommitAndPush(`Update processed orders @ ${new Date().toISOString()}`);
  }
}

run().catch(() => process.exit(1));
