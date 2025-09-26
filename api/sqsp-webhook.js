// /api/sqsp-webhook.js (improved logging)
export default async function handler(req, res) {
  try {
    console.log('--- webhook invocation ---', { method: req.method, url: req.url });
    console.log('Headers:', JSON.stringify(req.headers));
    console.log('Body (truncated):', JSON.stringify(req.body).slice(0, 2000));

    if (req.method !== 'POST') {
      console.log('Method not allowed');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const order = req.body;
    const KL_KEY = process.env.KLAVIYO_API_KEY;
    if (!KL_KEY) {
      console.error('Missing KLAVIYO_API_KEY env var');
      return res.status(500).json({ error: 'Server misconfigured' });
    }

    // Build Klaviyo payload (Placed Order)
    const klPayload = {
      data: {
        type: "event",
        attributes: {
          properties: {
            order_id: order.id,
            total: order.grandTotal?.value ?? order.grandTotal,
            currency: order.grandTotal?.currency ?? 'USD',
            items: (order.lineItems || []).map(i => ({
              name: i.productName || i.name,
              sku: i.sku,
              qty: i.quantity,
              price: i.unitPricePaid?.value ?? i.price
            }))
          },
          time: order.createdOn || new Date().toISOString(),
          metric: { data: { type: "metric", attributes: { name: "Placed Order" } } },
          profile: { data: { type: "profile", attributes: { email: order.customerEmail } } }
        }
      }
    };

    console.log('Klaviyo payload (truncated):', JSON.stringify(klPayload).slice(0, 2000));

    const resp = await fetch('https://a.klaviyo.com/api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'revision': '2024-10-15',
        'Authorization': `Klaviyo-API-Key ${KL_KEY}`
      },
      body: JSON.stringify(klPayload)
    });

    const text = await resp.text();
    console.log('Klaviyo response status:', resp.status);
    console.log('Klaviyo response body (truncated):', text.slice(0, 2000));

    return res.status(200).json({ ok: true, klaviyoStatus: resp.status });
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
