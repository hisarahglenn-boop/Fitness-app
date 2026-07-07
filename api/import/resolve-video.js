module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { url } = body || {};
  if (!url || !/^https:\/\/(www\.)?instagram\.com\/(reel|p)\/[^/]+\/?/.test(url)) {
    res.status(400).json({ error: 'Provide a valid instagram.com reel/post URL' });
    return;
  }

  try {
    const match = url.match(/instagram\.com\/(reel|p)\/([^/?]+)/);
    const shortcode = match[2];
    const embedUrl = `https://www.instagram.com/reel/${shortcode}/embed/captioned/`;

    const upstream = await fetch(embedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });

    if (!upstream.ok) {
      res.status(422).json({ error: 'Could not reach Instagram embed page', status: upstream.status });
      return;
    }

    const html = await upstream.text();

    // The embed page's data is JSON-encoded twice before being inlined into the
    // script (verified byte-by-byte against a live response): a literal quote
    // shows up as a single backslash+quote (\"), while a literal slash shows up
    // as three backslashes+slash (\\\/) -- consistent with the inner JSON's own
    // "\/"-escaped slashes being re-escaped when that string is embedded as a
    // value in the outer structure. Match against that exact escaped form rather
    // than trying to fully unescape the surrounding page first.
    const videoMatch = html.match(/\\"video_url\\"\s*:\s*\\"((?:[^"\\]|\\\\|\\\/|\\.)*?)\\"/);

    if (!videoMatch) {
      res.status(422).json({ error: 'No video found for this post (may be an image post, or Instagram changed their page structure)' });
      return;
    }

    const videoUrl = videoMatch[1].replace(/\\\\\\\//g, '/');

    res.status(200).json({ videoUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
