// scripts/send-one.js (temporary one-off sender)
const fetch = global.fetch || require("node-fetch");
const orderId = process.env.ORDER_ID;
if (!orderId) throw new Error("Set ORDER_ID env var to the Squarespace order id to send.");

(async () => {
  const sqKey = process.env.SQUARESPACE_API_KEY;
  const klKey = process.env.KLAVIYO_API_KEY;
  if (!sqKey || !klKey) throw new Error("Missing SQUARESPACE_API_KEY or KLAVIYO_API_KEY in env.");

  // fetch order detail (Squarespace list endpoint returns all; we can just call list and find id)
  const res = await fetch("https://api.squarespace.com/1.0/commerce/orders", {
    headers: { Authorization: `Bearer ${sqKey}`, "Content-Type": "application/json" }
  });
  const data = await res.json();
  const order = (data.result || []).find(o => o.id === orderId || o.orderNumber === orderId);
  if (!order) throw new Error("Order not found: " + orderId);

  const hasCourse = (order.lineItems || []).some(li => li.lineItemType === "PAYWALL_PRODUCT");
  const eventName = hasCourse ? "Course Purchased" : "Product Purchased";

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
          source: "Squarespace-poll",
        },
        metric: { data: { type: "metric", attributes: { name: eventName } } },
        profile: { data: { type: "profile", attributes: { email: order.customerEmail } } }
      }
    }
  };

  const kl = await fetch("https://a.klaviyo.com/api/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "revision": "2024-10-15",
      "Authorization": `Klaviyo-API-Key ${klKey}`
    },
    body: JSON.stringify(payload)
  });
  const text = await kl.text();
  console.log("Klaviyo status:", kl.status, "body:", text.slice(0,400));
  if (!kl.ok) process.exit(2);
  process.exit(0);
})();
