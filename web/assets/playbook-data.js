/* ===================================================================
   THE VAAK PLAYBOOK — data
   The complete operating manual: scratch → production → investors →
   marketing. Sourced from BUSINESS_PLAN, MULTI_AGENT_SPEC, COMPLIANCE,
   and FINANCIAL_MODEL_NOTES. Edit content here; app.js renders it.
   =================================================================== */

window.PLAYBOOK = [
  /* ------------------------------------------------------------ */
  {
    id: "scratch",
    tab: "From Scratch",
    sub: "M0 — foundations",
    goal: "Make the repo legal-to-dial and pick the engine.",
    why: "You cannot make a single compliant call in India without the regulatory plumbing, and you cannot build the conversation engine until you've decided what it runs on. These two unblock everything else — do them first, in parallel.",
    meta: [
      ["Owner", "Founder + compliance owner"],
      ["Spec", "WP-0, WP-1"],
      ["Exit criteria", "Repo builds green · ADR merged · DLT registration filed"]
    ],
    steps: [
      {
        h: "Bootstrap the repo skeleton (WP-0)",
        p: "Stand up the multi-agent monorepo exactly as the build spec defines it, so every later work package has a home and CI is green from commit one.",
        list: [
          "Create the service folders: orchestrator/, caller-agent/ (+ providers/, flows/), compliance-agent/, eval-agent/, backend-dotnet/, dashboard/, infra/, shared/.",
          "Add a CI skeleton, .env.sample, CONTRIBUTING, and the agent task template in .github/.",
          "Drop the docs into docs/ and engineering/ so the plan is the contract the code is built to."
        ],
        tags: [["WP-0", ""], ["Repo green", "proof"]]
      },
      {
        h: "File the compliance foundation (WP-0 / COMPLIANCE.md)",
        p: "Compliance is the moat, not paperwork. Start the registrations now — they have lead time and nothing dials without them.",
        list: [
          "DLT registration as Principal Entity + get an approved header.",
          "Acquire 160-series outbound number(s) via a SIP provider; register as telemarketer via the TSP.",
          "Pick a provider that bundles DLT + DND + consent (Plivo India / Exotel / FreJun / Ozonetel) — integrate, don't hand-roll.",
          "Fill the owner + status against every row of the compliance tracker."
        ],
        tags: [["Fails closed", ""], ["The moat", "proof"]]
      },
      {
        h: "Run the framework decision spike (WP-1)",
        p: "Choose Pipecat vs self-hosted Bolna for the caller pipeline by actually running one real call on each — not by reading docs.",
        list: [
          "Wire ONE real Sarvam (STT+TTS) + LLM + Plivo call on each framework.",
          "Measure time-to-first-audio, developer experience, and Indian-language quality.",
          "Write an ADR with a clear pick and rationale. Every later WP builds on it."
        ],
        tags: [["WP-1", ""], ["ADR merged", "proof"]]
      }
    ]
  },

  /* ------------------------------------------------------------ */
  {
    id: "production",
    tab: "To Production",
    sub: "M0 — M10 · build",
    goal: "Ship a production-grade fleet that holds a natural, compliant, code-mixed call at scale.",
    why: "The conversation engine is the product's soul — staff it first and heaviest. Everything else (orchestration, tools, compliance gate, eval) exists to put a great call on the wire and prove it happened. Build to the acceptance bar, not to a demo.",
    meta: [
      ["Owner", "Founding AI/voice engineer + founder (.NET)"],
      ["Spec", "WP-2 … WP-9"],
      ["Exit criteria", "100 concurrent calls · TTFA p50 <500ms · opt-out SLA met"]
    ],
    steps: [
      {
        h: "Caller-agent pipeline — over-invest here (WP-3)",
        p: "Production streaming STT→LLM→TTS with excellent turn-taking. This WP is the product's soul.",
        list: [
          "Stream every stage; target time-to-first-audio <500ms p50, alarm >1.2s.",
          "Tune VAD + endpointing; ship barge-in/interruption and backchanneling.",
          "Load flow + prompt from caller-agent/flows/ as versioned data — never hard-code conversation.",
          "Done when it holds a natural Telugu/Hindi/English code-mixed call with false-interruption rate under target."
        ],
        tags: [["WP-3 · critical path", ""], ["Natural call", "proof"]]
      },
      {
        h: "Provider abstraction layer (WP-4)",
        p: "Swap STT/LLM/TTS/telephony without touching business logic. Never import a vendor SDK into business logic.",
        list: [
          "Clean interfaces + adapters: Sarvam, AI4Bharat/Bhashini stub, hosted LLM, Ollama/VLLM, Plivo, Exotel.",
          "Done when you can switch TTS provider via config only — no redeploy of business logic."
        ],
        tags: [["WP-4", ""], ["Swap via config", "proof"]]
      },
      {
        h: "Orchestrator (WP-2)",
        p: "Spawn/track caller agents, balance load, manage human handoff.",
        list: [
          "Job queue, concurrency tiers, agent lifecycle (spawn → run → teardown), healthchecks.",
          "Warm-transfer API to a human endpoint with full context.",
          "Done when N concurrent simulated calls run and one warm-transfers to a human."
        ],
        tags: [["WP-2", ""]]
      },
      {
        h: "Backend (.NET) services + tool contract (WP-6)",
        p: "Where the agent's tool calls land — the founder's .NET strength.",
        list: [
          "REST endpoints: book_site_visit, book_callback, send_whatsapp, mark_optout, lead-score write-back, inventory lookup.",
          "CRM + Google/Outlook calendar + WhatsApp integration; suppression-list store.",
          "Done when each live tool call creates the correct record + confirmation; contract documented in shared/."
        ],
        tags: [["WP-6", ""]]
      },
      {
        h: "Compliance agent — the moat in code (WP-5)",
        p: "Gate every dial. Fails CLOSED. Must be DONE before any real customer dial, regardless of build order.",
        list: [
          "Real-time DND scrub (no verified-clean number → no dial).",
          "Non-skippable AI disclosure at call open; consent/header check.",
          "Opt-out propagates to suppression list within SLA and blocks all future dials.",
          "Recording + 90-day Indian-soil retention; immutable per-call audit log.",
          "Done when an un-scrubbed number is provably un-dialable and mid-call opt-out blocks future dials."
        ],
        tags: [["WP-5 · gate before any dial", ""], ["Audit complete", "proof"]]
      },
      {
        h: "Eval / analytics agent — the flywheel (WP-7)",
        p: "Make every call improve the next. Write the eval test before changing any prompt.",
        list: [
          "Auto-transcribe + LLM-as-judge scoring: disclosed? on-script? booked/opt-out clean? natural?",
          "Human-review sampling queue; dashboards for TTFA, interruption rate, book rate, opt-out rate.",
          "Regression suite of recorded scenarios that gates every prompt change before deploy.",
          "Done when a prompt change is blocked by the eval suite and a weekly quality report auto-generates."
        ],
        tags: [["WP-7", ""], ["Prompt gated by evals", "proof"]]
      },
      {
        h: "Infra, CI/CD, observability + dashboard (WP-9, WP-8)",
        p: "Production-grade ops and a console a design partner can run unaided.",
        list: [
          "Docker images for all services; k8s manifests scaling caller agents horizontally.",
          "Centralized logging + metrics + tracing (OpenTelemetry); secrets management; recordings on Indian region.",
          "Client dashboard: CSV campaign upload → scrubbed → queued; live results, recordings, transcripts, scores.",
          "Done when one-command deploy + autoscale is verified under simulated 100-concurrent-call load."
        ],
        tags: [["WP-9 + WP-8", ""], ["One-command deploy", "proof"]]
      }
    ]
  },

  /* ------------------------------------------------------------ */
  {
    id: "investors",
    tab: "Grabbing Investors",
    sub: "raise · diligence-proof",
    goal: "Raise a pre-seed/seed at the ₹100 Cr target on a deck that survives diligence.",
    why: "Inflated claims survive a pitch and die in diligence. The whole plan is written to separate what is true today from what we will build — that honesty is what protects you in the room. Every number must trace to a cited source or design-partner data.",
    meta: [
      ["Owner", "Founder & CEO"],
      ["Source", "BUSINESS_PLAN.md, FINANCIAL_MODEL_NOTES.md"],
      ["Exit criteria", "Term sheet · no placeholder survives the model"]
    ],
    steps: [
      {
        h: "Sharpen the narrative on the three stacked facts",
        p: "Lead with the problem that makes the value violent, not with the tech.",
        list: [
          "Speed-to-lead decides who wins, and India is catastrophically slow (2–6 hr response vs 5-min winners).",
          "The work is unscalable with humans (50–80 quality calls/day, ₹25–40k/month, attrition, no nights).",
          "Existing AI doesn't speak Bharat — fails on accents, regional languages, code-mixing, and TRAI/DLT/DND."
        ],
        tags: [["Problem-first", ""]]
      },
      {
        h: "Frame the market top-down AND bottom-up",
        p: "Use the cited figures for credibility; use the bottom-up for the number that matters.",
        list: [
          "India voice assistant: USD 153M (2024) → USD 958M (2030), 35.7% CAGR (NextMSC).",
          "India conversational AI: 26.3% CAGR 2025–30 (Grand View Research).",
          "Bottom-up: ₹5–15L/year per developer × a few thousand developers = multi-thousand-crore RE segment alone.",
          "Validate with the tailwind: IndicVoices 12,000-hr / 22-language dataset; Gnani 10M daily bank interactions."
        ],
        tags: [["Cited or it's cut", "proof"]]
      },
      {
        h: "Make the unit economics the engine of the pitch",
        p: "Show the cost-per-call and the planned gross-margin step-change as a milestone, not a hope.",
        list: [
          "Cost/call: ~₹13–22 managed early → ~₹6–10 on self-hosted Sarvam + own LLM (the WP-2/WP-4 migration).",
          "Outcome pricing: a booked site visit for a ₹2–4 Cr villament is worth lakhs — the arbitrage funds both sides.",
          "Revenue levers: platform/seat floor (MRR) + per-booked-meeting + usage pass-through + enterprise/on-prem (BFSI).",
          "Replace EVERY bracketed placeholder with real design-partner data before an investor sees the model."
        ],
        tags: [["No fabricated numbers", "proof"]]
      },
      {
        h: "Pre-empt diligence with the risk register and the honest 'do-not-build' list",
        p: "Naming the risks and the scope you refuse is what makes the rest believable.",
        list: [
          "State plainly: the agent qualifies + books; humans close. We do NOT sell the 'AI closed the deal' fantasy.",
          "Provider-abstracted architecture answers the platform-dependency risk.",
          "Compliance-as-core-competency answers the regulatory-change risk.",
          "Tie the ask to milestones: use of funds ≈ 45% engineering / 25% GTM / 15% compliance+infra / 15% runway."
        ],
        tags: [["Survives diligence", "proof"]]
      },
      {
        h: "Show the multi-agent architecture as the scaling story",
        p: "The fleet isn't just engineering — it's why this compounds.",
        list: [
          "Caller agents scale horizontally to thousands of concurrent calls.",
          "The eval flywheel: more calls → better data → better agents → better outcomes → more customers.",
          "Point diligence to /engineering/MULTI_AGENT_SPEC.md — the build is real and scoped, not vapor."
        ],
        tags: [["Flywheel = moat", ""]]
      }
    ]
  },

  /* ------------------------------------------------------------ */
  {
    id: "marketing",
    tab: "Marketing & GTM",
    sub: "land · expand · cross",
    goal: "Land 3–5 design partners in Hyderabad RE, prove booked-visit lift, then expand.",
    why: "The wedge is narrow and deep; the platform underneath is horizontal. Win the founder's home market with referenceable, in-language proof, then ride developer and channel-partner networks outward and finally cross into BFSI where contracts are larger.",
    meta: [
      ["Owner", "Founder + enterprise sales lead (to hire)"],
      ["Source", "BUSINESS_PLAN §8, §11"],
      ["Exit criteria", "20+ RE customers · NRR >100% · first BFSI logo"]
    ],
    steps: [
      {
        h: "Beachhead: Hyderabad real estate (founder's home advantage)",
        p: "Use the founder's existing channel-partner relationships and live projects as unfair distribution.",
        list: [
          "Land 3–5 design-partner developers who feel the slow-follow-up pain daily.",
          "Instrument booked-visit lift vs. the human-telecaller baseline from day one.",
          "Generate referenceable, in-language case studies — proof beats pitch in this market."
        ],
        tags: [["P1 · M2–M6", ""], ["Measured lift", "proof"]]
      },
      {
        h: "Lead with proof points the market has already seen work",
        p: "Demand is proven, not hypothetical — anchor outreach to it.",
        list: [
          "Reference public AI-led, sales-team-free launches (e.g. HoABL Naigaon 1,419-home digital allotment).",
          "Sell time-to-value: compliance + conversation quality + eval flywheel are hard to replicate in-house.",
          "Position against US platforms (Vapi/Retell/Bland): weak Indic quality, not TRAI-native, USD/min punishes Indian call patterns."
        ],
        tags: [["Why-now", ""]]
      },
      {
        h: "Expand within real estate along the channel graph",
        p: "Grow city-by-city through developer and channel-partner networks.",
        list: [
          "Hyderabad → Bangalore → Pune → MMR.",
          "Repeatable onboarding so a design partner launches a campaign and reads results unaided (WP-8).",
          "Target net revenue retention >100% — land-and-expand inside each account."
        ],
        tags: [["P3 · M10–M14", ""]]
      },
      {
        h: "Cross the vertical into BFSI / lending",
        p: "The same engine books a site visit, qualifies an insurance lead, or runs a collections call.",
        list: [
          "First BFSI/lending logos where contract sizes are larger and the regulated, phone-driven need is identical.",
          "Lean on the enterprise/on-prem tier (data residency) for higher ACV and stickiness.",
          "This is the horizontal proof that makes the company Series-A ready (P4 · M14–M18)."
        ],
        tags: [["P4 · Series-A readiness", "proof"]]
      },
      {
        h: "Compound the moats with every call",
        p: "Marketing's job long-term is to feed the flywheel that makes the product undeniable.",
        list: [
          "Proprietary in-language, in-telephony objection data from real high-ticket calls.",
          "Compliance infrastructure as a hard-to-copy product surface.",
          "Outcome pricing that's structurally awkward for foreign per-minute platforms to match."
        ],
        tags: [["Compounding moat", ""]]
      }
    ]
  }
];
