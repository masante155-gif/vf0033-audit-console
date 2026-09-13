// Safety & Food Culture Training — a weekly rotating knowledge-check
// answered right inside the Daily Safety Walk's Sign-Off card (it no longer
// has its own tab). One question per week (see index.js's weekIndex() for
// the rotation logic), pulled from one mixed pool of OSHA general-industry
// safety questions and food safety culture / HACCP questions, since the two
// are meant to reinforce each other rather than live in separate tracks.
// Every question is multiple choice (A/B/C) with a short explanation shown
// after answering, so a wrong answer still teaches the point rather than
// just being marked wrong. Admins can add, edit, deactivate, or remove
// questions from the admin-only "Manage Weekly Training Question Bank"
// section at the bottom of the Daily Safety Walk tab (same account-wide
// Admin passcode as everywhere else in the app) — this file only supplies
// the starting bank that seeds the database the first time it's empty;
// after that, the database (not this file) is the source of truth.
//
// The `correct` letter is deliberately spread across A/B/C below (roughly
// evenly) rather than always being the same letter. The client always
// renders options in fixed A/B/C order, so if every seed question had the
// same correct letter (an earlier version of this file had every one set
// to "B"), the question would be answerable by position alone without
// reading it at all — defeating the point of a knowledge check. Keep that
// spread in mind when adding new questions by hand.
module.exports = [
  {
    category: "OSHA Safety",
    prompt: "Before clearing a jam on Husky 1 or Husky 2, what's the first thing you should do?",
    options: {
      A: "Lock out and tag out the machine's energy source",
      B: "Ask a coworker to watch the machine while you reach in",
      C: "Just be extra careful and work quickly",
    },
    correct: "A",
    explanation: "Lockout/tagout isolates the machine's hazardous energy so it can't start or move while you're clearing the jam. Being careful isn't a substitute for LOTO.",
  },
  {
    category: "OSHA Safety",
    prompt: "A process tank or silo is labeled as a confined space. What's required before anyone enters it?",
    options: {
      A: "Nothing extra, as long as it looks empty",
      B: "Just having a coworker stand nearby",
      C: "A permit-required confined-space entry procedure",
    },
    correct: "C",
    explanation: "Confined spaces can have hidden hazards (bad air, engulfment, entrapment) that aren't visible from outside — the permit procedure is what actually checks for those before entry.",
  },
  {
    category: "OSHA Safety",
    prompt: "You notice a machine guard is missing on a piece of equipment. What should you do?",
    options: {
      A: "Keep working — someone else will probably notice",
      B: "Report it and stay clear of the exposed point until it's fixed",
      C: "Cover the gap yourself with tape or cardboard",
    },
    correct: "B",
    explanation: "A missing guard is a real machine-safety hazard. Report it so it gets fixed properly — a taped-over gap isn't a real guard and can fail.",
  },
  {
    category: "OSHA Safety",
    prompt: "Hearing protection is required in an area posted for high noise. True or false: you only need to wear it if the noise personally bothers you.",
    options: {
      A: "False — it's required regardless of personal comfort",
      B: "True",
      C: "Only during the day shift",
    },
    correct: "A",
    explanation: "Hearing damage from noise exposure is cumulative and often doesn't feel like anything at the time. Posted PPE requirements apply to everyone in that area, every shift.",
  },
  {
    category: "OSHA Safety",
    prompt: "Where can you find the hazards and safe-handling info for a chemical used in the plant?",
    options: {
      A: "Ask a coworker who's used it before",
      B: "Guess based on the color or smell of the container",
      C: "The chemical's Safety Data Sheet (SDS)",
    },
    correct: "C",
    explanation: "The SDS is the actual documented source for a chemical's hazards, PPE requirements, and handling/storage rules — every chemical on-site should have one accessible.",
  },
  {
    category: "OSHA Safety",
    prompt: "You see an electrical panel with its cover open and wiring exposed. What's the right move?",
    options: {
      A: "Walk past it — it's not your job",
      B: "Report it immediately and keep others clear of it",
      C: "Close the cover yourself",
    },
    correct: "B",
    explanation: "Exposed wiring is a shock hazard. Report it so someone qualified can make it safe — closing an electrical panel yourself isn't the same as it being properly serviced.",
  },
  {
    category: "OSHA Safety",
    prompt: "Who is allowed to operate a forklift in the warehouse or dock area?",
    options: {
      A: "Only operators certified for powered industrial trucks",
      B: "Anyone who feels confident driving one",
      C: "Anyone, as long as it's a slow day",
    },
    correct: "A",
    explanation: "Forklift operation requires OSHA-required powered industrial truck certification — it's not optional, regardless of how busy or quiet the shift is.",
  },
  {
    category: "OSHA Safety",
    prompt: "What's the rule for materials stacked near an emergency exit door?",
    options: {
      A: "Fine, as long as there's a narrow gap to squeeze through",
      B: "OK temporarily during a busy production run",
      C: "Exits must stay fully clear and unobstructed at all times",
    },
    correct: "C",
    explanation: "An exit that's partially blocked isn't a real exit in an emergency — this rule doesn't flex for how busy the shift is.",
  },
  {
    category: "OSHA Safety",
    prompt: "You almost slipped on a wet floor but caught yourself, and nothing happened. Should you report it?",
    options: {
      A: "No — nothing actually happened, so there's nothing to report",
      B: "Yes — near misses help catch hazards before someone actually gets hurt",
      C: "Only if a supervisor happened to see it",
    },
    correct: "B",
    explanation: "A near miss is a free warning. Reporting it lets the hazard (the wet floor) get fixed before the next person isn't as lucky.",
  },
  {
    category: "OSHA Safety",
    prompt: "Two chemicals in storage are incompatible per their SDS (like an acid and a base). Where should they be stored?",
    options: {
      A: "Segregated, away from each other, per the SDS",
      B: "Next to each other, for convenience",
      C: "It doesn't matter as long as the containers are closed",
    },
    correct: "A",
    explanation: "Incompatible chemicals can react dangerously even in closed containers if they leak or spill near each other — SDS segregation guidance exists for exactly this reason.",
  },
  {
    category: "Food Safety Culture",
    prompt: "What is a Critical Control Point (CCP) in our food safety plan?",
    options: {
      A: "Any step in the production process",
      B: "Only steps that involve chemicals",
      C: "A step where a real hazard can be controlled or eliminated to keep the product safe",
    },
    correct: "C",
    explanation: "CCPs are the specific points HACCP identifies as necessary to control a real food safety hazard — not just any step in the line.",
  },
  {
    category: "Food Safety Culture",
    prompt: "You notice a piece of broken plastic near the filler line. What should you do?",
    options: {
      A: "Ignore it if production is running — don't slow things down",
      B: "Stop, report it, and make sure it's removed before it can reach product",
      C: "Kick it out of the way and keep working",
    },
    correct: "B",
    explanation: "Foreign material near product is a direct food safety risk. It needs to be found and removed, not just pushed aside where it could still end up in product.",
  },
  {
    category: "Food Safety Culture",
    prompt: "Why do we keep personal items (phones, food, jewelry) out of GMP production areas?",
    options: {
      A: "To prevent contamination of the product",
      B: "Just plant policy, no real reason behind it",
      C: "It just looks more professional",
    },
    correct: "A",
    explanation: "Personal items are a real contamination pathway — this rule exists to protect the product, not just for appearances.",
  },
  {
    category: "Food Safety Culture",
    prompt: "Why does every batch of finished product need to be traceable back to its ingredient lots?",
    options: {
      A: "It's just paperwork with no practical use",
      B: "Only required for product that gets exported",
      C: "So a food safety issue can be traced and contained quickly if something goes wrong",
    },
    correct: "C",
    explanation: "Traceability is what lets a problem be isolated to a specific batch and ingredient lot fast, instead of a much larger and slower recall.",
  },
  {
    category: "Food Safety Culture",
    prompt: "When should employees wash their hands in a GMP production area?",
    options: {
      A: "Only at the start of the shift",
      B: "Before starting work, after breaks, and any time hands become contaminated",
      C: "Only if hands are visibly dirty",
    },
    correct: "B",
    explanation: "Contamination isn't always visible. Handwashing at these points is what actually keeps hands from being a contamination source through the shift.",
  },
  {
    category: "Food Safety Culture",
    prompt: "You notice a coworker not following a GMP practice correctly (like a hairnet worn wrong). What's the right move?",
    options: {
      A: "Speak up or report it — food safety is everyone's responsibility",
      B: "Say nothing — it's not your place",
      C: "Only mention it if it keeps happening",
    },
    correct: "A",
    explanation: "Food safety culture depends on everyone holding the line, not just QA or supervisors. A quiet word or a report both count as speaking up.",
  },
  {
    category: "Food Safety Culture",
    prompt: "Why do we monitor bait stations and UV traps on a regular schedule?",
    options: {
      A: "It's just a checkbox exercise for audits",
      B: "It's only required once a year",
      C: "To catch pest activity early, before it can contaminate product or packaging",
    },
    correct: "C",
    explanation: "Regular monitoring is what catches a pest problem while it's still small — waiting for it to become obvious means it's already gotten worse.",
  },
  {
    category: "Food Safety Culture",
    prompt: "Why does a machine repair need to avoid tape, wire, or cardboard fixes in a production area?",
    options: {
      A: "It looks unprofessional to visitors",
      B: "Those materials can break off and become foreign material in the product",
      C: "It's more expensive than a real repair",
    },
    correct: "B",
    explanation: "A temporary fix like tape or cardboard can shed material right where product is moving — that's a direct contamination risk, not just a cosmetic issue.",
  },
  {
    category: "Food Safety Culture",
    prompt: "If a non-conformance is found during an audit, what's the actual point of a corrective action?",
    options: {
      A: "To fix the immediate issue and prevent it from happening again",
      B: "Just to close out the paperwork",
      C: "It's only required for major findings",
    },
    correct: "A",
    explanation: "A corrective action that only fixes today's problem but doesn't address the cause just guarantees the same finding shows up again later.",
  },
  {
    category: "Food Safety Culture",
    prompt: "Food safety culture means...",
    options: {
      A: "Something only QA is responsible for",
      B: "Something that only matters during an external audit",
      C: "A shared commitment where everyone on the floor takes ownership of product safety",
    },
    correct: "C",
    explanation: "Food safety culture is what happens when no one's watching, not just what shows up during an inspection — it only works if everyone owns it.",
  },
];
