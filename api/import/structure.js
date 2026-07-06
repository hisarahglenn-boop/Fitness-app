const exerciseLibrary = require('../../exercise-library.json');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { caption, title } = body || {};

  if (!caption || !caption.trim()) {
    res.status(400).json({ error: 'No caption text to work with' });
    return;
  }

  const key = process.env.ANTHROPIC_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server missing ANTHROPIC_KEY' });
    return;
  }

  const libraryForPrompt = exerciseLibrary.map(e => ({
    name: e.name, type: e.type, equipment: e.equipment, gifPath: e.gifPath
  }));

  const prompt = `You are structuring a workout from a social media post caption into a list of exercises for a fitness app.

Post title: ${title || '(none)'}
Post caption: ${caption}

Here is our library of vetted exercises with real, confirmed demo GIFs (only match to these if it is genuinely the same movement):
${JSON.stringify(libraryForPrompt)}

Extract every distinct exercise mentioned or implied in the caption, in the order they appear. For each one, output:
- name: a clean, human-readable exercise name
- dose: a sensible "sets x reps" suggestion (e.g. "3 x 10-12"), or a time-based hold (e.g. "3 x 30 sec") if it's a static/isometric exercise, based on typical programming for that movement
- weight: a short suggested starting-weight range or "Bodyweight" if none is implied
- cue: one short, clear coaching cue for form (under 20 words)
- type: a short lowercase category tag (e.g. squat, hinge, press, curl, plank, armraise, legraise, row, calf, bridge, legcurl)
- matchedName: the exact "name" field from our library above if this is genuinely the same exercise, otherwise null
- gifPath: the gifPath from the matched library entry if matchedName is set, otherwise null

Respond with ONLY a JSON object of the exact shape: {"exercises": [...]}  No other text.`;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      res.status(upstream.status).json({ error: 'Anthropic API error', detail: errText });
      return;
    }

    const data = await upstream.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const text = (textBlock && textBlock.text) || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { exercises: [] };

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
