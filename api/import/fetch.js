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

  if (!url || !/^https:\/\/(www\.)?instagram\.com\//.test(url)) {
    res.status(400).json({ error: 'Provide a valid instagram.com URL' });
    return;
  }

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GleamoImportBot/1.0)' }
    });

    if (!upstream.ok) {
      const message = upstream.status === 429
        ? 'Instagram is temporarily rate-limiting requests right now — wait a minute or two and try again.'
        : 'Could not reach that post — double check the link is public and correct.';
      res.status(upstream.status).json({ error: message, status: upstream.status });
      return;
    }

    const html = await upstream.text();

    const decodeEntities = (s) => s
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));

    const metaValue = (property) => {
      const re = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i');
      const match = html.match(re);
      return match ? decodeEntities(match[1]) : null;
    };

    const thumbnailUrl = metaValue('og:image');
    let caption = metaValue('og:description') || '';
    // og:description on Instagram posts is usually "N likes, N comments - username on date: "caption text""
    const captionMatch = caption.match(/:\s*"(.*)"\s*$/);
    if (captionMatch) caption = captionMatch[1];

    const rawTitle = metaValue('og:title') || '';
    // og:title is "Username on Instagram: "full caption..."" — only take the short username part for display.
    const usernameMatch = rawTitle.match(/^(.*?)\s+on Instagram:/);
    const title = usernameMatch ? usernameMatch[1].trim() : (rawTitle.slice(0, 60) || 'Imported workout');

    res.status(200).json({ thumbnailUrl, caption, title, sourceUrl: url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
