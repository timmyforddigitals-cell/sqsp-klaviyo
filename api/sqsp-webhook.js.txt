// File: /api/sqsp-webhook.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const order = req.body; 
    const customerEmail = order.customerEmail;
    const orderId = order.id;
    const total = order.grandTotal?.value;

    let eventName = "Placed Order";
    if (order.isCart) eventName = "Added to Cart";
    if (order.isCheckout) eventName = "Checkout Started";

    await fetch('https://a.klaviyo.com/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: process.env.KLAVIYO_PRIVATE_API_KEY,
        event: eventName,
        customer_properties: { email: customerEmail },
        properties: { 
          OrderId: orderId, 
          Revenue: total,
          Products: order.lineItems?.map(item => ({
            name: item.productName,
            type: item.productType
          }))
        }
      })
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
}
