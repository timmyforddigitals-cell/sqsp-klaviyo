// /api/poll-orders.js
import fetch from "node-fetch";

const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY;
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;
const PROCESSED_FILE_PATH = process.env.PROCESSED_FILE_PATH || "data/processed.json";
const POLL_WINDOW_MINUTES = parseInt(process.env.POLL_WINDOW_MINUTES || "1440", 10);

async function githubGetFile(path) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET file failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function githubPutFile(path, contentStr, sha = null, message = "Update processed orders") {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(contentStr).toString("base64"),
    committer: { name: "sqsp-klaviyo-bot", email: "noreply@example.com" }
  };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`GitHub PUT file failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function fetchSquarespaceOrders() {
  const res = await fetch("https://api.squarespace.com/1.0/commerce/orders", {
    headers: { Authorization: `Bearer ${SQUARESPACE_API_KEY}`, "Content-Type": "application/json" }
  });
  if (!res.ok) throw new Error(`Squarespace orders fetch failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

function isRecent(orderCreatedOnIso) {
  const created = new Date(orderCreatedOnIso).getTime();
  const now = Date.now();
  return (now - created) <= POLL_WINDOW_MINUTES * 60 * 1000;
}

async function sendKlaviyoEvent(order, isCourse) {
  const eventName = isCourse ? "Course Purchased" : "Product Purchased";
  const payload = {
    data: {
      type: "event",
      attributes: {
        time: order.createdOn || new Date().toISOString(),
        properties: {
          order_id: order.id,
          order_number: order.orderNumber,
          total: order.grandTotal?.value ?? null,
          currency: order.grandTotal?.currency ?? null,
          items: (order.lineItems || []).map(i => ({
            name: i.productName || i.name,
            sku: i.sku,
            qty: i.quantity,
            price: i.unitPricePaid?.value ?? i.price,
            type: i.lineItemType
          })),
          source: "Squarespace-poll"
        },
        metric: {
          data: { type: "metric", attributes: { name: eventName } }
        },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: order.customerEmail,
              first_name: order.billingAddress?.firstName,
              last_name: order.billingAddress?.lastName
            }
          }
        }
      }
    }
  };

  const resp = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "revision": "2024-10-15",
      "Authorization": `Klaviyo-API-Key ${KLAVIYO_API_KEY}`
    },
    body: JSON.stringify(payload),
    timeout: 20000
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Klaviyo event failed: ${resp.status} ${text}`);
  }
  return { status: resp.status, body: text };
}

export default async function handler(req, res) {
  try {
    console.log("Poll-orders invoked at", new Date().toISOString());

    const file = await githubGetFile(PROCESSED_FILE_PATH);
    let processed = [];
    let sha = null;
    if (file) {
      sha = file.sha;
      const raw = Buffer.from(file.content, "base64").toString("utf8");
      try { processed = JSON.parse(raw); } catch (e) { processed = []; }
    }

    const sqsp = await fetchSquarespaceOrders();
    const orders = Array.isArray(sqsp.result) ? sqsp.result : [];
    if (orders.length === 0) {
      return res.status(200).json({ message: "No orders", processedCount: processed.length });
    }

    const recentOrders = orders.filter(o => isRecent(o.createdOn)).sort((a,b)=> new Date(a.createdOn) - new Date(b.createdOn));

    const newlyProcessed = [];
    for (const order of recentOrders) {
      if (processed.includes(order.id)) {
        console.log("Skipping already processed order:", order.id);
        continue;
      }

      if (order.testmode === true || order.testmode === "true") {
        console.log("Skipping test order:", order.id);
        processed.push(order.id);
        newlyProcessed.push({ id: order.id, skipped: true, reason: "testmode" });
        continue;
      }

      const hasCourse = (order.lineItems || []).some(li => li.lineItemType === "PAYWALL_PRODUCT");
      try {
        const klResult = await sendKlaviyoEvent(order, hasCourse);
        console.log("Sent to Klaviyo:", order.id, klResult.status);
        processed.push(order.id);
        newlyProcessed.push({ id: order.id, klaviyoStatus: klResult.status });
      } catch (err) {
        console.error("Failed to forward order", order.id, err.message || err);
      }
    }

    processed = processed.slice(-500);
    const contentStr = JSON.stringify(processed, null, 2);
    try {
      const put = await githubPutFile(PROCESSED_FILE_PATH, contentStr, sha, `Update processed orders @ ${new Date().toISOString()}`);
      console.log("Updated processed file:", put.content?.path);
    } catch (err) {
      console.error("Failed to update processed file on GitHub:", err.message || err);
    }

    return res.status(200).json({ message: "Done", newlyProcessed, processedCount: processed.length });
  } catch (err) {
    console.error("Poll error:", err);
    return res.status(500).json({ error: err.message });
  }
}
