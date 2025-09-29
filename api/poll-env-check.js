
// api/poll-env-check.js  (temporary)
export default async function handler(req, res) {
  try {
    const vars = {
      SQUARESPACE_API_KEY: !!process.env.SQUARESPACE_API_KEY,
      KLAVIYO_API_KEY: !!process.env.KLAVIYO_API_KEY,
      GITHUB_TOKEN: !!process.env.GITHUB_TOKEN,
      GITHUB_REPO: !!process.env.GITHUB_REPO,
      NODE_VERSION: process.version || null
    };
    return res.status(200).json({ ok: true, env_present: vars });
  } catch (err) {
    // very defensive: return the error message (temporary)
    return res.status(500).json({ ok: false, error: String(err && err.stack ? err.stack : err) });
  }
}
