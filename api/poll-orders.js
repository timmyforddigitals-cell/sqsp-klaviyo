// api/poll-orders.js (DEBUGGING / TEMPORARY - remove verbose logging after fix)
export default async function handler(req, res) {
  const now = new Date().toISOString();
  console.log(`poll-orders invoked at ${now}`);

  // Safe check for required env vars (we do NOT log values)
  const required = [
    "SQUARESPACE_API_KEY",
    "KLAVIYO_API_KEY",
    "GITHUB_TOKEN",
    "GITHUB_REPO"
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.error("Missing environment variables:", missing);
    return res.status(500).json({
      ok: false,
      error: "missing_env",
      missing
    });
  }

  const SQUARESPACE_API_KEY = process.env.SQUARESPACE_API_KEY;
  const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const PROCESSED_FILE_PATH = process.env.PROCESSED_FILE_PATH || "data/processed.json";
  const POLL_WINDOW_MINUTES = parseInt(process.env.POLL_WINDOW_MINUTES || "1440", 10);

  // Helpers
  const githubGetFile = async (path) => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const resp = await fetch(url, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" }
    });
    const text = await resp.text();
    return { status: resp.status, text, ok: resp.ok, json: resp.ok ? JSON.parse(text) : null };
  };

  const githubPutFile = async (path, contentStr, sha=null, message="Update processed orders") => {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;
    const body = {
      message,
      content: Buffer.from(contentStr).toString("base64"),
      committer: { name: "sqsp-klaviyo-bot", email: "noreply@example.com" }
    };
    if (sha) body.sha = sha;
    const resp = await fetch(url, {
      method: "PUT",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await resp.text();
    return { status: resp.status, text, ok: resp.ok, json: resp.ok ? JSON.parse(text) : null };
  };

  const fetchSquarespaceOrders = async () => {
    const resp = await fetch("https://api.squarespace.com/1.0/commerce/orders", {
      headers: { Authorization: `Bearer ${SQUARESPACE_API_KEY}`, "Content-Type": "application/json" }
    });
    const text = await resp.text();
    return { status: resp.status, text, ok: resp.ok, json: resp.ok ? JSON.parse(text) : null };
  };

  const sendKlaviyoEvent = async (order, isCourse) => {
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
          metric: { data: { type: "metric", attributes: { name: eventName } } },
          profile: { data: { type: "profile", attributes: { email: order.customerEmail } } }
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
      body: JSON.stringify(payload)
    });
    const text = await resp.text();
    return { status: resp.status, ok: resp.ok, text };
  };

  // Main flow - wrapped in try/catch for better error messages
  try {
    console.log("Step: load processed file from GitHub");
    const getFile = await githubGetFile(PROCESSED_FILE_PATH);
    if (!getFile.ok && getFile.status !== 404) {
      console.error("GitHub GET file error:", getFile.status, getFile.text.slice(0,500));
      return res.status(500).json({ ok: false, stage: "github_get", status: getFile.status, bodySample: getFile.text.slice(0,500) });
    }

    let processed = [];
    let sha = null;
    if (getFile.ok) {
      sha = getFile.json.sha;
      try {
        processed = JSON.parse(Buffer.from(getFile.json.content, "base64").toString("utf8"));
      } catch(e) {
        console.error("Failed to parse processed.json:", e && e.message);
        // continue with empty processed list
        processed = [];
      }
    } else {
      console.log("Processed file not found on GitHub - will create new one after processing");
    }

    console.log("Step: fetch Squarespace orders");
    const sqsp = await fetchSquarespaceOrders();
    if (!sqsp.ok) {
      console.error("Squarespace fetch failed:", sqsp.status, sqsp.text.slice(0,500));
      return res.status(500).json({ ok: false, stage: "squarespace_fetch", status: sqsp.status, bodySample: sqsp.text.slice(0,500) });
    }

    const orders = Array.isArray(sqsp.json.result) ? sqsp.json.result : [];
    if (orders.length === 0) {
      console.log("No orders returned by Squarespace");
      // Save processed file if it didn't exist before to avoid repeat runs creating it every time
      if (!getFile.ok) {
        try {
          const putResult = await githubPutFile(PROCESSED_FILE_PATH, JSON.stringify(processed, null, 2), null, "Create processed.json (init)");
          console.log("Created processed.json on GitHub:", putResult.ok ? putResult.json.content.path : putResult.text.slice(0,300));
        } catch(e) {
          console.error("Failed to create processed.json:", e && e.message);
        }
      }
      return res.status(200).json({ ok: true, message: "No orders", processedCount: processed.length });
    }

    // Filter to recent orders
    const isRecent = (iso) => {
      const created = new Date(iso).getTime();
      return (Date.now() - created) <= POLL_WINDOW_MINUTES * 60 * 1000;
    };
    const recentOrders = orders.filter(o => o.createdOn && isRecent(o.createdOn)).sort((a,b)=> new Date(a.createdOn) - new Date(b.createdOn));

    const newlyProcessed = [];
    for (const order of recentOrders) {
      try {
        if (processed.includes(order.id)) {
          console.log("Skipping already processed:", order.id);
          continue;
        }
        if (order.testmode === true || order.testmode === "true") {
          console.log("Skipping Squarespace test order:", order.id);
          processed.push(order.id);
          newlyProcessed.push({ id: order.id, skipped: true, reason: "testmode" });
          continue;
        }

        const hasCourse = (order.lineItems || []).some(li => li.lineItemType === "PAYWALL_PRODUCT");
        console.log("Forwarding order to Klaviyo:", order.id, "isCourse:", hasCourse);

        const klRes = await sendKlaviyoEvent(order, hasCourse);
        if (!klRes.ok) {
          console.error("Klaviyo rejected event:", klRes.status, klRes.text.slice(0,500));
          // Do not mark as processed so it will retry next run
          newlyProcessed.push({ id: order.id, klaviyoStatus: klRes.status, klaviyoBodySample: klRes.text.slice(0,300) });
        } else {
          console.log("Klaviyo accepted event for order:", order.id, "status:", klRes.status);
          processed.push(order.id);
          newlyProcessed.push({ id: order.id, klaviyoStatus: klRes.status });
        }
      } catch (err) {
        console.error("Error processing order", order.id, err && err.stack ? err.stack : String(err));
        // don't mark as processed
      }
    }

    // Save processed list back to GitHub (only last 500)
    try {
      const toSave = JSON.stringify(processed.slice(-500), null, 2);
      const put = await githubPutFile(PROCESSED_FILE_PATH, toSave, getFile.ok ? getFile.json.sha : null, `Update processed orders @ ${new Date().toISOString()}`);
      console.log("GitHub PUT result status:", put.status);
      if (!put.ok) {
        console.error("GitHub PUT failed:", put.status, put.text.slice(0,500));
      } else {
        console.log("Updated processed.json at:", put.json.content.path);
      }
    } catch (e) {
      console.error("Failed to update processed.json on GitHub:", e && e.message);
    }

    return res.status(200).json({ ok: true, newlyProcessed, processedCount: processed.length });
  } catch (err) {
    console.error("Unhandled error in poll-orders:", err && err.stack ? err.stack : String(err));
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
