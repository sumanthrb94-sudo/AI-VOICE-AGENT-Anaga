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
  // If the directions block is missing or malformed, an OUTBOUND opening is
  // what everyone gets — it is the stricter of the two, because it asks consent
  // that inbound merely implies. Failing toward the version that asks
  // permission is the only safe direction for a bug in a dialler to fail.
  direction: {
    label: 'unknown',
    consent: 'explicit',
    source: [],
    greet: {},
    rules: ['Ask consent before qualifying. Assume you interrupted them.'],
  },
};

/** The languages Anaga has REVIEWED wording for. Not a capability list — the
 *  vendor speaks eleven; these are the three a human has signed off. */
export const LANGS = ['en-IN', 'hi-IN', 'te-IN'];
export function normalizeFlowLang(lang) {
  const l = String(lang || '').trim();
  return LANGS.includes(l) ? l : 'en-IN';
}

function str(v) { return typeof v === 'string' && v.trim() ? v.trim() : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }

const BACKCHANNEL_MAX_CHARS = 32;
const BACKCHANNEL_MAX_LINES = 8;

/** { lang: [line, …] }, keeping only supported languages and short lines. */
function backchannelLines(raw) {
  const out = {};
  for (const lang of LANGS) {
    const lines = arr(obj(raw)[lang])
      .filter((s) => str(s) && s.trim().length <= BACKCHANNEL_MAX_CHARS)
      .map((s) => s.trim())
      .slice(0, BACKCHANNEL_MAX_LINES);
    if (lines.length) out[lang] = lines;
  }
  return out;
}

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
    // WHAT SHE SAYS WHILE SHE IS THINKING, per language. Normalized here rather
    // than read raw so a malformed flow degrades to no acknowledgement — she
    // simply stays quiet through the gap, which is where this started — instead
    // of putting `undefined` or a stray object through a speech engine.
    // Capped in length because these are meant to be a noise, not a sentence:
    // anything long enough to carry a claim does not belong in a line spoken
    // before the model has decided anything.
    backchannel: backchannelLines(obj(obj(f.globals).backchannel).lines),
    directions: loadDirections(f),
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

/**
 * The per-direction openings, with {project}/{city} filled in from the flow.
 *
 * The substitution is the point: a greeting with a development's name typed
 * into it stays behind when the flow is pointed at a different project, and
 * nobody notices until Anaga opens a call by naming a building that is not for
 * sale. Nothing else about the two directions is duplicated — the qualification
 * and the closing are shared, because they genuinely are the same.
 */
function loadDirections(f) {
  const out = {};
  for (const key of ['outbound', 'inbound']) {
    const d = obj(obj(f.directions)[key]);
    const greet = obj(d.greet);
    const filled = {};
    // Templates are kept RAW here and filled where they are rendered. Filling
    // them at load time baked the project name into the greeting, so a flow
    // pointed at a different development still opened by naming the old one —
    // the exact drift the flow-drives-the-prompt test exists to catch, and it
    // did catch it.
    for (const l of LANGS) if (str(greet[l])) filled[l] = greet[l];
    out[key] = {
      label: str(d.label) || FLOOR.direction.label,
      consent: d.consent === 'implicit' ? 'implicit' : 'explicit',
      source: arr(d.source).filter(str),
      greet: filled,
      rules: arr(d.rules).filter(str).length ? arr(d.rules).filter(str) : FLOOR.direction.rules,
    };
  }
  return out;
}

/** Fill {project}/{city} from the flow the line is being rendered WITH. */
export function fillTemplate(text, flow) {
  return String(text || '')
    .replaceAll('{project}', str(obj(flow?.project).name) || 'the project')
    .replaceAll('{city}', str(obj(flow?.project).city) || '');
}

/** One direction, normalized. An unknown name gets OUTBOUND — the stricter. */
export function loadDirection(name, flow = loadFlow()) {
  const key = String(name || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  return { id: key, ...(flow.directions?.[key] || FLOOR.direction) };
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
    // The male set, kept whole rather than inherited — Hindi marks the
    // speaker's gender on the verb, so a man reading the feminine line is
    // wrong and audibly so.
    disclosureMale: {
      'en-IN': str(obj(d.male)['en-IN']) || str(d['en-IN']) || FLOOR.disclosure,
      'hi-IN': str(obj(d.male)['hi-IN']) || null,
      'te-IN': str(obj(d.male)['te-IN']) || null,
    },
  };
}

export { FLOOR };
