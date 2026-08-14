// api/_lib/approved-script.js
//
// Deterministic browser-demo script mode. The canonical flow already contains
// reviewed English qualification lines; sending those through a generative model
// adds a paid round trip and gives the model permission to paraphrase them.
//
// Only English is enabled until reviewed Hindi and Telugu step lines are added to
// the flow. The direction-specific greetings remain in flow.js and are served by
// GET /api/anaga/turn, so the script starts with the first qualification question.

import { loadFlow, fillTemplate, normalizeFlowLang } from './flow.js';

const CORE_STEPS = ['purpose', 'budget', 'config', 'timeline', 'offer'];

function text(value) { return String(value || '').trim(); }
function words(value) { return text(value).toLowerCase(); }

function hasAny(value, terms) {
  const source = words(value);
  return terms.some((term) => source.includes(term));
}

function isPositive(value) {
  return hasAny(value, [
    'yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'please', 'book', 'visit',
    'saturday', 'sunday', 'weekend', 'works for me', 'sounds good',
  ]);
}

function isBusy(value) {
  return hasAny(value, [
    'no', 'not now', 'busy', 'later', 'call back', 'callback', 'another time',
    'cannot talk', "can't talk", 'dont have time', "don't have time",
  ]);
}

function selectedDay(value) {
  const source = words(value);
  if (source.includes('saturday')) return 'Saturday';
  if (source.includes('sunday')) return 'Sunday';
  if (source.includes('weekday')) return 'a weekday';
  return 'your preferred day';
}

function dispositionFor(step) {
  if (step?.id === 'optout') return 'opt-out';
  if (step?.id === 'busy') return 'busy';
  if (step?.id === 'callback') return 'callback';
  if (step?.id === 'confirm') return 'booked';
  return 'qualifying';
}

function renderedStep(step, flow, vars = {}) {
  if (!step) return null;
  const say = fillTemplate(step.say, flow).replaceAll('{day}', vars.day || 'your preferred day');
  if (!say) return null;
  return { id: step.id, say, end: step.end === true, disposition: dispositionFor(step) };
}

/**
 * Return the next exact reviewed line for an English browser-script session.
 * `null` deliberately means the caller should use the normal model path.
 */
export function approvedScriptTurn(history, { lang } = {}) {
  if (normalizeFlowLang(lang) !== 'en-IN' || !Array.isArray(history)) return null;

  const flow = loadFlow();
  const byId = new Map(flow.steps.map((step) => [step.id, step]));
  const latestUser = [...history].reverse().find((turn) => turn?.role === 'user');
  const heard = text(latestUser?.text);
  if (!heard) return null;

  if (hasAny(heard, flow.optOutTriggers || [])) {
    return renderedStep(byId.get('optout'), flow);
  }

  const agentTurns = history.filter((turn) => turn?.role === 'agent').length;
  // The greeting is agent turn one, provided separately from the direction flow.
  const afterGreeting = Math.max(0, agentTurns - 1);
  if (afterGreeting === 0 && isBusy(heard)) {
    return renderedStep(byId.get('busy'), flow);
  }

  if (afterGreeting < CORE_STEPS.length) {
    return renderedStep(byId.get(CORE_STEPS[afterGreeting]), flow);
  }

  // The reviewed flow branches only after the site-visit offer. A positive answer
  // gets the reviewed day question; any other answer gets the reviewed callback.
  if (afterGreeting === CORE_STEPS.length) {
    return isPositive(heard)
      ? renderedStep(byId.get('book'), flow)
      : renderedStep(byId.get('callback'), flow);
  }

  // The latest reply answered the date question. The {day} placeholder is the
  // only approved variable in the confirmation line and is filled from the
  // prospect's actual words rather than invented by a model.
  if (afterGreeting === CORE_STEPS.length + 1) {
    return renderedStep(byId.get('confirm'), flow, { day: selectedDay(heard) });
  }

  return null;
}

/** The linear, reviewed qualification path that can be pre-rendered safely. */
export function approvedScriptLines(lang) {
  if (!approvedScriptAvailable(lang)) return [];
  const flow = loadFlow();
  const byId = new Map(flow.steps.map((step) => [step.id, step]));
  return CORE_STEPS.map((id) => renderedStep(byId.get(id), flow)).filter(Boolean);
}

/** Whether exact reviewed step wording is available for this language. */
export function approvedScriptAvailable(lang) {
  return normalizeFlowLang(lang) === 'en-IN';
}
