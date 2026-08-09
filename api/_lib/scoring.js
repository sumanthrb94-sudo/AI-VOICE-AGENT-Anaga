// api/_lib/scoring.js
//
// Lead potency: how good is this lead, and WHY.
//
// The score used to be a number the LLM invented in one field of a JSON blob.
// Two problems with that. It is not reproducible — the same call reviewed twice
// gives two numbers, and a sales team that notices this stops trusting all of
// them. And it is not explainable — a closer looking at "score: 68" has no way
// to ask what would have made it 80.
//
// So the split is: the model does the part only a model can do (read free-form,
// code-mixed speech and decide which bucket an answer falls in), and this module
// does the arithmetic. Same buckets in, same score out, always, with a breakdown
// that says where every point came from.
//
// The weights are NOT here. They live in the flow file next to the questions
// they belong to (caller-agent/flows/*.flow.json, `qualification`), because what
// a budget answer is worth is a sales decision, not an engineering one — and
// because a different vertical is a different flow, not a different deploy.

import { loadFlow } from './flow.js';

/** Every bucket name the reviewer is allowed to use, per field. */
export function bucketVocabulary(flow = loadFlow()) {
  const out = {};
  for (const f of flow.qualification.fields) out[f.id] = Object.keys(f.buckets);
  return out;
}

function band(score, bands) {
  for (const b of bands) if (score >= b.min) return b.label;
  return bands.length ? bands[bands.length - 1].label : 'unscored';
}

/**
 * Score a finished call.
 *
 * @param {object} input
 * @param {object} [input.qualification]  { fieldId: bucketName } from the reviewer
 * @param {string} [input.disposition]    how the call ended
 * @param {object} [flow]
 * @returns {{
 *   score: number, band: string, coverage: number,
 *   answered: number, of: number, cappedBy: string|null,
 *   fields: Array<{ id, label, bucket, worth, weight, points, answered }>
 * }}
 */
export function scoreLead({ qualification = {}, disposition = null } = {}, flow = loadFlow()) {
  const { fields, dispositionCeiling, bands } = flow.qualification;

  if (!fields.length) {
    return { score: 0, band: 'unscored', coverage: 0, answered: 0, of: 0, cappedBy: null, fields: [] };
  }

  const rows = fields.map((f) => {
    const raw = qualification && typeof qualification === 'object' ? qualification[f.id] : null;
    // An answer we do not recognise is treated as unanswered rather than
    // silently scored: a reviewer that invents a bucket name must not be able
    // to invent points along with it.
    const known = typeof raw === 'string' && Object.hasOwn(f.buckets, raw);
    const bucket = known ? raw : 'unclear';
    const worth = Number(f.buckets[bucket]) || 0;
    return {
      id: f.id,
      label: f.label,
      bucket,
      // "unclear" is a real bucket with a real (low) value — an unanswered
      // question is a fact about the lead, not a gap in the data.
      answered: known && bucket !== 'unclear',
      worth,
      weight: f.weight,
      points: Math.round((worth * f.weight) / 100),
    };
  });

  const totalWeight = rows.reduce((a, r) => a + r.weight, 0) || 1;
  const earned = rows.reduce((a, r) => a + r.worth * r.weight, 0);
  let score = Math.round(earned / totalWeight);

  // However well they answered, how the call ENDED caps it. Somebody who opted
  // out is not a warm lead because they happened to state their budget first.
  const ceilingRaw = dispositionCeiling && disposition != null
    ? dispositionCeiling[disposition]
    : undefined;
  const ceiling = Number.isFinite(Number(ceilingRaw)) ? Number(ceilingRaw) : null;
  let cappedBy = null;
  if (ceiling !== null && score > ceiling) {
    score = ceiling;
    cappedBy = disposition;
  }

  score = Math.max(0, Math.min(100, score));
  const answered = rows.filter((r) => r.answered).length;

  return {
    score,
    band: band(score, bands),
    // How much of the qualification actually got done. A 70 off four answers
    // and a 70 off one are not the same lead, and the closer should see which.
    coverage: Math.round((answered / rows.length) * 100),
    answered,
    of: rows.length,
    cappedBy,
    fields: rows,
  };
}

/**
 * One line a human can read without opening anything else. This is what lands
 * in the CRM note, so it has to survive being the only thing anybody reads.
 */
export function explainScore(s) {
  if (!s || !s.of) return 'Not scored — no qualification fields configured.';
  const parts = s.fields
    .map((f) => `${f.label}: ${f.answered ? f.bucket : 'not answered'} (+${f.points})`)
    .join('; ');
  const cap = s.cappedBy ? ` Capped at ${s.score} because the call ended "${s.cappedBy}".` : '';
  return `${s.score}/100 (${s.band}), ${s.answered} of ${s.of} questions answered. ${parts}.${cap}`;
}
