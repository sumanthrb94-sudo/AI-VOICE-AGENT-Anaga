// api/_lib/followup-templates.js
//
// WhatsApp follow-up message templates for Anaga's nurture sequences.
//
// Three-touch sequence:
//   Day 1  — same-day / next-day recap + push for site visit
//   Day 3  — social proof + gentle nudge
//   Day 7  — last-touch + open-ended offer
//
// Messages are short (WhatsApp UX), warm, and Modcon-specific.
// Language detection: if the lead's language is te-IN we pick a Telugu variant;
// otherwise English (Hindi coming later).
//
// Usage:
//   import { getFollowupMessage } from './_lib/followup-templates.js';
//   const msg = getFollowupMessage({ day:1, name:'Ravi', disposition:'callback', language:'te-IN' });

const EN = {
  1: (name, disposition, summary) => {
    if (disposition === 'booked') {
      return [
        `Hi ${name}! 👋 Looking forward to your site visit at *Modcon SYL Residences*!`,
        `📍 Thukkuguda · Near ORR Exit-14, Shamshabad`,
        `If you need to reschedule: +91 95348 69999 or reply here.`,
        `See you soon! 🏡`,
      ].join('\n');
    }
    return [
      `Hi ${name}! 👋 Thanks for speaking with Anaga (Modcon's AI) earlier.`,
      summary ? `Quick recap: ${summary}` : '',
      ``,
      `*Modcon SYL Residences* — biophilic villaments at Thukkuguda, near ORR Exit-14 & RGI Airport.`,
      `Ready for a quick site visit? Just say "Yes" and we'll fix a time. 🏡`,
    ].filter((l) => l !== null && l !== undefined).join('\n');
  },

  3: (name) => [
    `Hi ${name}! 👋 Still thinking about *Modcon SYL*?`,
    ``,
    `Our villaments are going fast — low-density, big private balconies, forest & sunrise views,`,
    `a 22,000 sft wellness clubhouse with a chemical-free bio-pool. ✨`,
    ``,
    `Weekend visit? Takes just 30 minutes and you'll see exactly what you're investing in. 🏡`,
    `Reply "Visit" to book or call +91 95348 69999.`,
  ].join('\n'),

  7: (name) => [
    `Hi ${name}, this is our last note from Anaga / Modcon Builders. 😊`,
    ``,
    `If you're still curious about *SYL Residences* or even our Bali-style eco-farmhouse project *Agartha*,`,
    `we'd love to show you around — no pressure.`,
    ``,
    `Call us: *+91 95348 69999* or visit *modcon.in* anytime. 🙏`,
  ].join('\n'),
};

const TE = {
  1: (name, disposition) => {
    if (disposition === 'booked') {
      return [
        `నమస్కారం ${name} గారూ! 👋 *Modcon SYL Residences* సైట్ విజిట్‌కి స్వాగతం!`,
        `📍 థుక్కుగూడ · ORR Exit-14 దగ్గర`,
        `ఏదైనా మార్పులు అవసరమైతే: +91 95348 69999`,
        `మీ కోసం ఎదురుచూస్తున్నాం! 🏡`,
      ].join('\n');
    }
    return [
      `నమస్కారం ${name} గారూ! 👋 Anaga (Modcon AI)తో మాట్లాడినందుకు ధన్యవాదాలు.`,
      ``,
      `*Modcon SYL Residences* — థుక్కుగూడలో విల్లమెంట్లు, ORR Exit-14 దగ్గర.`,
      `ఒక్కసారి సైట్ చూస్తారా? "అవును" అంటే టైం ఫిక్స్ చేస్తాం. 🏡`,
    ].join('\n');
  },

  3: (name) => [
    `నమస్కారం ${name} గారూ! 👋 *Modcon SYL* గురించి ఇంకా ఆలోచిస్తున్నారా?`,
    ``,
    `మా విల్లమెంట్లు — పెద్ద బాల్కనీలు, అడవి & సూర్యోదయ వ్యూ, నేచురల్ బయో-పూల్ క్లబ్‌హౌస్. ✨`,
    ``,
    `వీకెండ్ విజిట్‌కి రండి — అరగంటలో అన్నీ చూపిస్తాం. 🏡`,
    `"విజిట్" అని రిప్లై చేయండి లేదా +91 95348 69999 కి కాల్ చేయండి.`,
  ].join('\n'),

  7: (name) => [
    `నమస్కారం ${name} గారూ, ఇది Anaga / Modcon Builders నుండి చివరి సందేశం. 😊`,
    ``,
    `SYL Residences లేదా Agartha (Bali-style ఫార్మ్‌హౌస్) గురించి ఆసక్తి ఉంటే,`,
    `మేము ఎప్పుడైనా సహాయం చేయడానికి సిద్ధంగా ఉన్నాం.`,
    ``,
    `కాల్ చేయండి: *+91 95348 69999* లేదా *modcon.in* సందర్శించండి. 🙏`,
  ].join('\n'),
};

/**
 * Get a follow-up WhatsApp message.
 * @param {{ day:1|3|7, name:string, disposition?:string, summary?:string, language?:string }} opts
 * @returns {string}
 */
export function getFollowupMessage({ day, name, disposition = '', summary = '', language = '' }) {
  const isTE = language === 'te-IN' || language === 'te';
  const templates = isTE ? TE : EN;
  const fn = templates[day] || templates[1];
  return fn(name || 'there', disposition, summary);
}

/**
 * Build the full sequence queue for a lead (day 1, 3, 7 from now).
 * Returns [{ sendAt:Date, day:number }]
 */
export function buildSequenceQueue(daysFromNow = [1, 3, 7]) {
  const now = new Date();
  return daysFromNow.map((d) => ({
    day: d,
    sendAt: new Date(now.getTime() + d * 24 * 3600 * 1000),
  }));
}
