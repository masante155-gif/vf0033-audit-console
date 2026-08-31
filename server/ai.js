// ---------------------------------------------------------------------------
// AI writing assistant for Non-Conformance entries.
//
// Calls the Anthropic Messages API directly over the platform's built-in
// fetch (Node 18+, no SDK dependency needed). Every exported function is
// safe to call even when no API key is configured — they throw a typed
// error that the routes in index.js turn into a friendly HTTP response
// instead of a stack trace, so the feature degrades gracefully until an
// admin adds ANTHROPIC_API_KEY on Railway.
"use strict";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
// Pinned model id (not an auto-updating alias) so behavior doesn't shift
// under you; override with an AI_MODEL env var if you ever want a different
// model without a code change.
const MODEL = process.env.AI_MODEL || "claude-sonnet-5";
const MAX_TOKENS = 500;

class AiNotConfiguredError extends Error {}
class AiUpstreamError extends Error {}

function isAiConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

async function callClaude(system, userText) {
  if (!isAiConfigured()) {
    throw new AiNotConfiguredError(
      "The AI writing assistant isn't set up yet. Ask your admin to add an Anthropic API key in Railway."
    );
  }
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: userText }],
      }),
    });
  } catch (e) {
    throw new AiUpstreamError("Couldn't reach the AI service right now. Try again in a moment.");
  }
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = (body && body.error && body.error.message) || "";
    } catch (e) {
      // ignore — fall through with no detail
    }
    throw new AiUpstreamError(
      "The AI service returned an error" + (detail ? ": " + detail + "." : ".") + " Try again in a moment."
    );
  }
  const data = await res.json();
  const block = (data.content || []).find((c) => c.type === "text");
  if (!block || !block.text || !block.text.trim()) {
    throw new AiUpstreamError("The AI service returned an empty response. Try again.");
  }
  return block.text.trim();
}

const FIELD_LABELS = {
  description: "Description / Deviation",
  corrective_action: "Corrective Action",
  preventive_measures: "Preventive Measures",
};

// Polish an auditor's own rough note for one field into clear, professional
// audit language, without inventing anything the auditor didn't say.
async function rephraseField({ auditLabel, sectionLabel, itemText, field, currentText }) {
  const fieldLabel = FIELD_LABELS[field] || field;
  const system =
    "You are a food safety and quality assurance auditor's writing assistant, helping polish short " +
    "notes for a formal GMP/quality audit non-conformance report. Rewrite the auditor's note into " +
    "clear, objective, professional audit language: factual, specific, and concise (1-2 sentences). " +
    "Never invent facts, numbers, names, dates, or details that are not in the original note — if the " +
    "note is vague, keep the rewrite equally general rather than making something up. Output ONLY the " +
    "rewritten text, with no preamble, quotation marks, labels, or explanation.";
  const userText =
    "Audit type: " + auditLabel + "\n" +
    sectionLabel + " / Checklist item: " + itemText + "\n" +
    "Field being written: " + fieldLabel + "\n" +
    "Auditor's note to polish:\n" + currentText;
  return callClaude(system, userText);
}

// Draft all three NC fields from a short phrase of keywords the auditor
// jots down on the spot, using the failed checklist item as context.
async function draftFromKeywords({ auditLabel, sectionLabel, itemText, keywords }) {
  const system =
    "You are a food safety and quality assurance auditor's writing assistant. Given a checklist item " +
    "that failed inspection and a few keywords from the auditor describing what they observed, draft " +
    "three short, professional fields for a formal non-conformance report: a factual Description of " +
    "the deviation, a plausible immediate Corrective Action that was taken on the spot, and a Preventive " +
    "Measure to reduce recurrence. Keep each field to 1-2 concise sentences. Stay general where the " +
    "keywords don't specify a detail — never invent specific names, dates, quantities, or measurements " +
    "the keywords didn't imply. Respond with ONLY a JSON object with exactly these three keys: " +
    "description, corrective_action, preventive_measures. No markdown code fences, no other text.";
  const userText =
    "Audit type: " + auditLabel + "\n" +
    sectionLabel + " / Checklist item: " + itemText + "\n" +
    "Auditor's keywords: " + keywords;
  const raw = await callClaude(system, userText);
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
  } catch (e) {
    throw new AiUpstreamError("The AI response couldn't be read. Try again.");
  }
  return {
    description: String(parsed.description || "").trim(),
    corrective_action: String(parsed.corrective_action || "").trim(),
    preventive_measures: String(parsed.preventive_measures || "").trim(),
  };
}

module.exports = {
  isAiConfigured,
  rephraseField,
  draftFromKeywords,
  AiNotConfiguredError,
  AiUpstreamError,
};
