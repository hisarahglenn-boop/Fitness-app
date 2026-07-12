const exerciseLibrary = require('../../exercise-library.json');

const EQUIPMENT_GUIDANCE = {
  'home-limited': 'They have a home gym with limited equipment: dumbbell, bodyweight, and kettlebell exercises only.',
  'full-gym': 'They have full access to a commercial gym. Any equipment type is fine.',
  'bodyweight': 'They only have their bodyweight to work with. Bodyweight exercises only.',
  'other': 'They described their equipment as: '
};

// Equipment types the model is allowed to draw from for each questionnaire
// answer, enforced server-side (not just via prompt wording) since the model
// has proven unreliable at self-filtering equipment from the full library.
// null = no restriction.
const ALLOWED_EQUIPMENT = {
  'home-limited': new Set(['bodyweight', 'dumbbell', 'kettlebell']),
  'bodyweight': new Set(['bodyweight']),
  'full-gym': null,
  'other': null
};

function equipmentGuidance(equipment, equipmentOther){
  if(equipment === 'other') return EQUIPMENT_GUIDANCE.other + (equipmentOther || 'unspecified') + '. Use your best judgment about which library exercises fit.';
  return EQUIPMENT_GUIDANCE[equipment] || 'No specific equipment constraint given.';
}

function libraryForEquipment(equipment){
  const allowed = ALLOWED_EQUIPMENT[equipment];
  if(!allowed) return exerciseLibrary;
  return exerciseLibrary.filter(e => allowed.has(e.equipment));
}

// Fills a day up to a minimum exercise count using library exercises matching
// the day's own already-picked target areas, in case the model returns too
// few valid names (e.g. some it picked didn't match the library exactly).
function topUpDay(dayExercises, usedNames, minCount, pool){
  if(dayExercises.length >= minCount) return dayExercises;
  const areasInDay = new Set();
  dayExercises.forEach(ex => (ex.targetAreas || []).forEach(a => areasInDay.add(a)));
  const candidates = pool.filter(e => !usedNames.has(e.name) && e.targetAreas.some(a => areasInDay.has(a)));
  for(const c of candidates){
    if(dayExercises.length >= minCount) break;
    dayExercises.push(c);
    usedNames.add(c.name);
  }
  return dayExercises;
}

const SUPABASE_URL = 'https://sqplklzjpougwdlinrhz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_PVZYXtvvLl0wkORvTMx5CA_WhzaYAJf';

// Plan generation costs a real model call, so it requires a signed-in user:
// the caller passes their Supabase access token and we verify it against
// GoTrue before doing anything expensive. Both clients (web questionnaire,
// native onboarding) send the header; anonymous requests get a 401.
async function verifyUser(req) {
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const upstream = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth }
    });
    if (!upstream.ok) return null;
    const user = await upstream.json();
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const user = await verifyUser(req);
  if (!user) {
    res.status(401).json({ error: 'Sign in required' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { questionnaire } = body || {};
  if (!questionnaire || !Array.isArray(questionnaire.targetAreas) || !questionnaire.targetAreas.length) {
    res.status(400).json({ error: 'Missing or invalid questionnaire data' });
    return;
  }

  const key = process.env.ANTHROPIC_KEY;
  if (!key) {
    res.status(500).json({ error: 'Server missing ANTHROPIC_KEY' });
    return;
  }

  const { targetAreas, equipment, equipmentOther, daysPerWeek, experience, injuries } = questionnaire;
  const days = Number(daysPerWeek) || 4;

  const pool = libraryForEquipment(equipment);
  const libraryForPrompt = pool.map(e => ({
    name: e.name, targetAreas: e.targetAreas, equipment: e.equipment, difficulty: e.difficulty
  }));

  const prompt = `You are a fitness program designer building a personalized weekly workout plan.

User's questionnaire answers:
- Target areas: ${targetAreas.join(', ')}
- Equipment access: ${equipment}
- Days per week: ${days}
- Experience level: ${experience}
- Injuries or pain points: ${injuries || 'none mentioned'}

Equipment guidance: ${equipmentGuidance(equipment, equipmentOther)}

Here is the ONLY library of exercises you may use, each with its exact name, target areas, equipment type, and difficulty:
${JSON.stringify(libraryForPrompt)}

Build a ${days}-day weekly workout plan using ONLY exercises from this library, referenced by their EXACT "name" field (case-sensitive, must match exactly — do not invent exercises or rephrase names). Rules:
- If experience is "new", avoid difficulty "advanced" and prefer "beginner".
- If injuries/pain points are mentioned, avoid exercises likely to aggravate them (e.g. knee pain -> avoid heavy barbell squats/lunges, prefer hip thrusts, glute bridges, and RDLs instead of squats/lunges).
- Distribute the chosen target areas sensibly across the week (e.g. a push/pull/legs split, an upper/lower split, or a focus-area rotation) based on daysPerWeek and which target areas were chosen — every chosen target area should get meaningful coverage across the week.
- Each day should have 5-7 exercises.
- Give each day a short title ("Day 1", "Day 2", etc.) and a subtitle describing its focus (e.g. "Heavy Glutes + Deadlift").

Respond with ONLY a JSON object of this exact shape, no other text:
{"days": [{"title": "Day 1", "subtitle": "...", "exerciseNames": ["Exact Name From Library", "..."]}]}`;

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
        max_tokens: 8000,
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
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { days: [] };

    const libraryByName = new Map(pool.map(e => [e.name, e]));
    const usedNames = new Set();

    const plan = (parsed.days || []).map((day, i) => {
      let dayExercises = (day.exerciseNames || [])
        .map(name => libraryByName.get(name))
        .filter(Boolean)
        .filter(e => { if (usedNames.has(e.name)) return false; usedNames.add(e.name); return true; });

      dayExercises = topUpDay(dayExercises, usedNames, 5, pool);

      return {
        title: day.title || `Day ${i + 1}`,
        subtitle: day.subtitle || 'Workout',
        exercises: dayExercises.map(e => [e.name, e.dose, e.weight, e.cue, e.type, e.gifPath])
      };
    }).filter(day => day.exercises.length > 0);

    if (!plan.length) {
      res.status(422).json({ error: 'Could not generate a valid plan from the model response' });
      return;
    }

    res.status(200).json({ plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
