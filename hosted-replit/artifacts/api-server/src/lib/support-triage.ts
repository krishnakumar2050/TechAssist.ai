import type { ConversationDetail } from "./rag";

export type Triage = NonNullable<ConversationDetail["messages"][number]["triage"]>;
export type SupportReply = ConversationDetail["messages"][number];
const wifi = /\bwi[\s-]?fi\b|\bwireless\b/i;
const unknown = /^(?:unknown|unspecified|not (?:provided|known|sure)|n\/a|none|\[unknown\])$/i;
export function known(value: string) { return Boolean(value.trim()) && !unknown.test(value.trim()); }
export function parseOS(text: string) {
  if (/\bwindows\s*11\b|\bwin\s*11\b/i.test(text)) return "Windows 11";
  if (/\bwindows\s*10\b|\bwin\s*10\b/i.test(text)) return "Windows 10";
  if (/\bmacos\b|\bmac\s*os\b|\bmacbook\b|\bos\s*x\b|^\s*mac\s*$/i.test(text)) return "macOS";
  if (/\bubuntu\b/i.test(text)) return "Ubuntu";
  if (/\bchrome\s*os\b|\bchromebook\b/i.test(text)) return "ChromeOS";
  if (/\bfedora\b/i.test(text)) return "Fedora";
  if (/\bdebian\b/i.test(text)) return "Debian";
  if (/^\s*windows\s*$/i.test(text)) return "Windows";
  return "";
}
function symptom(text: string): Triage["symptom"] {
  if (/(?:stays?|remains?|still|shows?)\s+(?:\w+\s+){0,2}connected|connected\s+(?:but|with|without)|no\s+internet|internet\s+(?:stops|unavailable|doesn.t work)/i.test(text)) return "connectedNoInternet";
  if (/disconnects?\s+(?:completely|entirely)|completely\s+disconnect|wi[\s-]?fi\s+(?:icon\s+)?(?:disconnects?|disappears)|loses?\s+(?:the\s+)?(?:wireless|wi[\s-]?fi)\s+connection/i.test(text)) return "disconnects";
  if (/(?:cannot|can't|unable to|never)\s+connect|won't\s+connect/i.test(text)) return "cannotConnect";
  return "unknown";
}
export function prepareTriage(chat: ConversationDetail, question: string): { state: Triage; clarification?: string } {
  const previous = [...chat.messages].reverse().find(m => m.role === "assistant" && m.triage)?.triage;
  const followup = /\b(?:still|next|tried|did not|didn't|failed|not working|cannot do|can't do|else|another step|what now)\b/i;
  const explicitOther = /\b(camera|teams|microphone|bluetooth|printer|startup|battery|keyboard|payroll|disk|screen)\b/i.test(question) && !wifi.test(question);
  const continuing = previous && !explicitOther && (
    previous.pending || wifi.test(question) || parseOS(question) ||
    followup.test(question) || /connected|internet|disconnect/i.test(question)
  );
  // Old conversations without snapshots still retain their original issue on follow-ups.
  const oldIssue = followup.test(question)
    ? chat.messages.find(m => m.role === "user")?.text : undefined;
  const originalIssue = continuing ? previous.originalIssue : oldIssue || question;
  const state: Triage = continuing ? { ...previous } : {
    originalIssue, topic: wifi.test(originalIssue) ? "wifi" : "other", symptom: "unknown",
  };
  const confirmedOS = parseOS(question);
  if (confirmedOS) chat.context.os = confirmedOS;
  if (!known(chat.context.os)) chat.context.os = "";
  if (state.topic === "wifi") {
    const described = symptom(question);
    if (described !== "unknown") state.symptom = described;
    if (!known(chat.context.os)) {
      state.pending = "os";
      return { state, clarification: "Which operating system is this laptop running—for example, Windows 11, macOS, or Ubuntu?" };
    }
    if (state.symptom === "unknown") {
      state.pending = "wifiSymptom";
      return { state, clarification: "Does Wi-Fi disconnect completely, or does it stay connected while internet access stops?" };
    }
  } else if (state.pending === "os" && !known(chat.context.os)) {
    return { state, clarification: "Which operating system is this laptop running?" };
  }
  delete state.pending;
  return { state };
}

// Controlled query enhancement: no unverified LLM additions, inferred enterprise
// configuration or unknown-value placeholders. Always retain the original issue.
export function enhancedQuery(state: Triage, context: ConversationDetail["context"]) {
  const facts = [state.originalIssue, ...Object.values(context).filter(v => typeof v === "string" && known(v))];
  if (state.topic === "wifi") {
    facts.push("Wi-Fi wireless network");
    if (state.symptom === "connectedNoInternet") facts.push("connected but no internet access");
    if (state.symptom === "disconnects") facts.push("wireless connection disconnects completely");
    if (state.symptom === "cannotConnect") facts.push("cannot connect to wireless network");
  }
  return facts.join(" ").replace(/\s+/g, " ").trim();
}
const stopwords = new Set("a an and are as at be been but by can cannot could do does for from has have i in is it keeps laptop me my not of on or please that the their this to was when which while with working office dropping unknown unspecified".split(" "));
export function lexicalQuery(query: string) {
  const tokens: string[] = query.toLowerCase().replace(/wi[\s-]?fi/g, "wifi").match(/[a-z0-9]+/g) || [];
  return [...new Set(tokens.filter(t => t.length > 2 && !stopwords.has(t)))].slice(0, 24).join(" | ");
}
type EvidenceLike = { title: string; text: string; metadata?: { platform?: string; source_urls?: string[] } };
export function platformFamily(platform: string) {
  if (/windows/i.test(platform)) return "windows";
  if (/mac|os x/i.test(platform)) return "macos";
  if (/ubuntu/i.test(platform)) return "ubuntu";
  if (/linux|fedora|debian/i.test(platform)) return "linux";
  return "unspecified";
}
export function applicablePlatform(e: EvidenceLike, os: string) {
  if (!known(os)) return true;
  const expected = platformFamily(os), actual = platformFamily(e.metadata?.platform || "");
  if (actual === "unspecified") return true; // Explicitly OS-agnostic hardware guidance.
  if (expected !== actual) return false;
  const wantedVersion = os.match(/\b(10|11)\b/)?.[0];
  const sourceVersion = e.metadata?.platform?.match(/\b(10|11)\b/)?.[0];
  return !(expected === "windows" && wantedVersion && sourceVersion && wantedVersion !== sourceVersion);
}
export function applicableTopic(e: EvidenceLike, state: Triage) {
  if (state.topic === "wifi") return /wi[\s-]?fi|wireless|network|internet/i.test(e.title) && wifi.test(e.text);
  const patterns = [/\bcamera\b/i, /\bmicrophone\b/i, /\bbluetooth\b/i, /\bprinter\b/i];
  const pattern = patterns.find(p => p.test(state.originalIssue));
  return !pattern || pattern.test(e.title);
}
export function applicableSymptom(e: EvidenceLike, state: Triage) {
  if (state.topic !== "wifi") return true;
  if (state.symptom === "connectedNoInternet") return /connected/i.test(e.text) && /no internet|internet unavailable|internet access.*(?:stop|fail)/i.test(e.text);
  if (state.symptom === "disconnects") return /(?:wi[\s-]?fi|wireless|network)[\s\S]{0,80}(?:intermittent|disconnect|drop)|(?:intermittent|disconnect|drop)[\s\S]{0,80}(?:wi[\s-]?fi|wireless|network)/i.test(e.text);
  if (state.symptom === "cannotConnect") return /cannot connect|connection fails|can't connect|unable to connect/i.test(e.text);
  return true;
}
