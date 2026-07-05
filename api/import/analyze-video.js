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
  const { frames, caption, title } = body || {};

  if (!Array.isArray(frames) || frames.length === 0) {
    res.status(400).json({ error: 'No frames provided' });
    return;
  }
  if (frames.length > 8) {
    res.status(400).json({ error: 'Too many frames (max 8)' });
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

  const introText = `These are ${frames.length} still frames captured at even intervals from a workout video${title ? ` titled "${title}"` : ''}${caption ? `. Caption context: ${caption.slice(0, 500)}` : ''}.

Look at the frames in order and identify each distinct exercise being demonstrated (a video may show one exercise the whole time, or several in sequence — go by what's actually visible: body position, equipment held, movement implied between frames).

Here is our library of vetted exercises with real, confirmed demo GIFs (only match to these if it is genuinely the same movement):
${JSON.stringify(libraryForPrompt)}

For each distinct exercise you can identify, output:
- name: a clean, human-readable exercise name
- dose: a sensible "sets x reps" suggestion, or a time-based hold if it's static/isometric
- weight: a short suggested starting-weight range or "Bodyweight" if none is visible
- cue: one short, clear coaching cue for form (under 20 words), based on what you actually observe in the frames
- type: a short lowercase category tag (e.g. squat, hinge, press, curl, plank, armraise, legraise, row, calf, bridge, legcurl)
- matchedName: the exact "name" field from our library above if this is genuinely the same exercise, otherwise null
- gifPath: the gifPath from the matched library entry if matchedName is set, otherwise null
- confidence: "high", "medium", or "low" — be honest if the frames are ambiguous

If the frames don't clearly show any identifiable exercise, return an empty exercises array rather than guessing.

Respond with ONLY a JSON object of the exact shape: {"exercises": [...]}  No other text.`;

  const content = [
    { type: 'text', text: introText },
    ...frames.map((f) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: f.replace(/^data:image\/jpeg;base64,/, '') }
    }))
  ];

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
        messages: [{ role: 'user', content }]
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
