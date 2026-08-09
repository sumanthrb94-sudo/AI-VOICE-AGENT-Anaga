// api/_lib/flow.js
//
// Loads the versioned conversation flow and persona so the API can BUILD its
// prompts from them.
//
// This exists because the rule "flows and prompts are versioned data in
// caller-agent/flows/, never code" (MULTI_AGENT_SPEC §1.5) was not actually
// true. The flow file was referenced in comments and read by nothing; the real
// script lived hardcoded in a prose string in prompts.js. Two consequences:
// editing the flow changed nothing, and the flow and the prompt had already
// drifted apart. Everything the model is told about the conversation now comes
// through here.
//
// JSON is imported rather than read with fs on purpose: Vercel's bundler traces
// imports, so the flow ships with the function. A readFileSync of a path outside
// api/ is the kind of thing that works locally and 404s in production.

import flowJson from '../../caller-agent/flows/real-estate-qualify.flow.json' with { type: 'json' };
import personaJson from '../../caller-agent/flows/anaga.persona.json' with { type: 'json' };

// The compliance floor. If the flow file is ever malformed, empty, or missing a
// section, these are what the model is told instead — never nothing. A prompt
// that has lost its disclosure rule because someone mistyped a JSON key is the
// failure this guards against, and it fails toward saying MORE, not less.
const FLOOR = {
  disclosure: "Disclose at the very open that you are an AI voice agent from Vaak, say what the call "
    + "is about, and ask consent before anything else.",
  optOutTriggers: ['not interested', 'do not call', "don't call", 'stop calling', 'remove me', 'unsubscribe', 'opt out', 'dnd'],
  goal: 'Disclose AI, get consent, qualify the lead, book a site visit, handle opt-out.',
};

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

/**
 * The flow, normalized and guaranteed well-shaped. Never throws, never returns
 * a hole — a caller can use every field without checking it first.
 */
export function loadFlow() {
  const f = obj(flowJson);
  const steps = arr(f.steps).filter((s) => obj(s).id && str(s.say));
  const q = obj(f.qualification);

  const fields = arr(q.fields)
    .filter((x) => str(obj(x).id) && obj(obj(x).buckets).unclear != null)
    .map((x) => ({
      id: String(x.id),
      label: str(x.label) || String(x.id),
      weight: Number.isFinite(Number(x.weight)) && Number(x.weight) > 0 ? Number(x.weight) : 1,
      buckets: obj(x.buckets),
      // The line the agent actually asks, taken from the step that captures
      // this field — so the prompt and the flow cannot describe different
      // questions.
      ask: str(steps.find((s) => s.capture === x.id)?.say) || null,
    }));

  return {
    id: str(f.id) || 'unknown',
    version: str(f.version) || '0.0.0',
    vertical: str(f.vertical) || null,
    project: obj(f.project),
    goal: str(f.goal) || FLOOR.goal,
    steps,
    optOutTriggers: arr(obj(obj(f.globals).optout).triggers).filter(str).length
      ? arr(f.globals.optout.triggers).filter(str)
      : FLOOR.optOutTriggers,
    disclosureStep: steps.find((s) => s.disclosure === true) || null,
    qualification: {
      fields,
      dispositionCeiling: obj(q.dispositionCeiling),
      bands: arr(q.bands)
        .filter((b) => Number.isFinite(Number(obj(b).min)) && str(obj(b).label))
        .map((b) => ({ min: Number(b.min), label: String(b.label) }))
        .sort((a, b) => b.min - a.min),
    },
  };
}

/** The persona, normalized the same way. */
export function loadPersona() {
  const p = obj(personaJson);
  const d = obj(p.disclosure);
  return {
    id: str(p.id) || 'anaga',
    version: str(p.version) || '0.0.0',
    displayName: str(p.displayName) || 'Anaga',
    gender: str(obj(p.persona).gender),
    tone: arr(obj(p.persona).tone).filter(str),
    register: str(obj(p.persona).register) || '',
    languages: arr(obj(p.voice).languages).filter(str),
    // The reviewed, versioned sentence that makes the call legal. Never
    // generated, never machine-translated — see the note in the persona file.
    disclosure: {
      'en-IN': str(d['en-IN']) || FLOOR.disclosure,
      'hi-IN': str(d['hi-IN']) || null,
      'te-IN': str(d['te-IN']) || null,
    },
  };
}

export { FLOOR };
