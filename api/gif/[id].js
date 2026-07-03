module.exports = async (req, res) => {
  const { id } = req.query;

  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: 'Invalid exercise id' });
    return;
  }

  const key = process.env.WORKOUTX_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server missing WORKOUTX_KEY' });
    return;
  }

  try {
    const upstream = await fetch(`https://api.workoutxapp.com/v1/gifs/${id}.gif`, {
      headers: { 'X-WorkoutX-Key': key }
    });

    if (!upstream.ok) {
      res.status(upstream.status).json({ error: 'Upstream fetch failed', status: upstream.status });
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'image/gif');
    // GIFs never change once assigned to an exercise id — cache hard so repeat
    // views (any user, any session) don't re-hit WorkoutX's metered API.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.status(200).send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
