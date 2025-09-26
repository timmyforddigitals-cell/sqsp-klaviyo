// api/poll-orders-debug.js  (temporary - remove when done)
export default async function handler(req, res) {
  try {
    console.log("DEBUG: poll-orders-debug invoked", new Date().toISOString());

    // Check presence of required env vars (do NOT print values)
    const vars = {
      SQUARESPACE_API_KEY: !!process.env.SQUARESPACE_API_KEY,
      KLAVIYO_API_KEY: !!process.env.KLAVIYO_API_KEY,
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      GITHUB_REPO: !!process.env.GITHUB_REPO
    };
    console.log("DEBUG: env present:", vars);

    // quick test: try fetching Squarespace orders (safe, read-only)
    const sqspRes = await fetch("https://api.squarespace.com/1.0/commerce/orders", {
      headers: { Authorization: `Bearer ${process.env.SQUARESPACE_API_KEY}` || "" }
    });

    const sqspText = await sqspRes.text();
    console.log("DEBUG: Squarespace status:", sqspRes.status);
    console.log("DEBUG: Squarespace body (truncated):", sqspText.slice(0, 200));

    // quick test: check Klaviyo auth by calling GET on events endpoint (may return 404 but shows auth)
    let klRes;
    try {
      klRes = await fetch("https://a.klaviyo.com/api/events", {
        method: "GET",
        headers: { Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}` || "" }
      });
    } catch (e) {
      klRes = { ok: false, status: "fetch-failed", error: String(e) };
    }

    console.log("DEBUG: Klaviyo GET status:", klRes.status || klRes);

    // Return a useful JSON summary to Thunder Client
    return res.status(200).json({
      ok: true,
      env_present: vars,
      squarespace_status: sqspRes.status,
      squarespace_body_sample: sqspText.slice(0, 100),
      klaviyo_status: klRes.status || klRes
    });
  } catch (err) {
    console.error("DEBUG: Uncaught error in poll-orders-debug:", err && err.stack ? err.stack : String(err));
    return res.status(500).json({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
}
