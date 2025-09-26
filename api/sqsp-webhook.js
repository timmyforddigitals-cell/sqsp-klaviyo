// File: /api/sqsp-webhook.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const order = req.body; // Squarespace order payload

    // Replace with your Klaviyo API key
    const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

    // 1️⃣ Send Placed Order event
    await fetch("https://a.klaviyo.com/api/events/", {
      method: "POST",
      headers: {
        "Authorization": `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        data: {
          type: "event",
          attributes: {
            metric: { name: "Placed Order" },
            properties: {
              order_id: order.id,
              total: order.grandTotal.value,
              currency: order.grandTotal.currency,
              items: order.lineItems.map(item => ({
                productName: item.productName,
                sku: item.sku,
                quantity: item.quantity,
                price: item.unitPricePaid.value
              }))
            },
            profile: {
              email: order.customerEmail,
              first_name: order.billingAddress?.firstName,
              last_name: order.billingAddress?.lastName
            },
            time: new Date(order.createdOn).toISOString()
          }
        }
      })
    });

    // 2️⃣ Send Ordered Product event for each item
    for (const item of order.lineItems) {
      await fetch("https://a.klaviyo.com/api/events/", {
        method: "POST",
        headers: {
          "Authorization": `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          data: {
            type: "event",
            attributes: {
              metric: { name: "Ordered Product" },
              properties: {
                productName: item.productName,
                sku: item.sku,
                quantity: item.quantity,
                price: item.unitPricePaid.value,
                order_id: order.id
              },
              profile: {
                email: order.customerEmail,
                first_name: order.billingAddress?.firstName,
                last_name: order.billingAddress?.lastName
              },
              time: new Date(order.createdOn).toISOString()
            }
          }
        })
      });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
