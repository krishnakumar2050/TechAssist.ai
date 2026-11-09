export type DemoMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  step?: string;
  explanation?: string;
  navigation?: string;
  expectedResult?: string;
  outcome?: "solved" | "failed" | "blocked";
};

export type DemoSession = {
  id: string;
  title: string;
  updatedAt: string;
  context: { os: string; model: string; application: string };
  messages: DemoMessage[];
};

const KEY = "techassist.demo.sessions";
const ON = "techassist.demo.on";

export function loadDemo(): DemoSession[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DemoSession[]) : [];
  } catch {
    return [];
  }
}
export function saveDemo(m: DemoSession[]) {
  try { sessionStorage.setItem(KEY, JSON.stringify(m)); } catch { /* ignore */ }
}
export function isDemoOn() {
  try { return sessionStorage.getItem(ON) === "1"; } catch { return false; }
}
export function setDemoOn(on: boolean) {
  try { if (on) sessionStorage.setItem(ON, "1"); else sessionStorage.removeItem(ON); } catch { /* ignore */ }
}
export function clearDemo() {
  try { sessionStorage.removeItem(KEY); sessionStorage.removeItem(ON); } catch { /* ignore */ }
}
export function newId() {
  return uid();
}

export function demoHandoff(s: DemoSession): string {
  const ctx = [s.context.os && `OS: ${s.context.os}`, s.context.model && `Laptop: ${s.context.model}`, s.context.application && `Application: ${s.context.application}`].filter(Boolean);
  const first = s.messages.find((m) => m.role === "user")?.text ?? s.title;
  const tried = s.messages.filter((m) => m.role === "assistant" && m.step && m.outcome);
  const label = { solved: "solved the issue", failed: "did not fix it", blocked: "could not be done" } as const;
  return [
    "[DEMO - illustrative summary, not sent to IT]",
    "",
    `Issue: ${first}`,
    ctx.length ? `Device: ${ctx.join("; ")}` : "Device: not provided",
    "",
    "Steps tried:",
    ...(tried.length ? tried.map((m, i) => `${i + 1}. ${m.step} - ${label[m.outcome!]}`) : ["None reported yet"]),
  ].join("\n");
}

type Topic = "wifi" | "camera" | "audio" | "power" | "other";
function topicOf(t: string): Topic {
  const s = t.toLowerCase();
  if (/wi-?fi|network|internet|vpn|connect/.test(s)) return "wifi";
  if (/camera|webcam|teams|zoom|meeting|video/.test(s)) return "camera";
  if (/audio|sound|mic|speaker|headset|hear/.test(s)) return "audio";
  if (/power|battery|charg|turn on|boot/.test(s)) return "power";
  return "other";
}

const STEPS: Record<Topic, Omit<DemoMessage, "id" | "role">[]> = {
  wifi: [
    { text: "Let's start by resetting the wireless adapter.", step: "Turn Wi-Fi off, wait ten seconds, then turn it back on.", explanation: "This forces the adapter to request a fresh connection, which clears most temporary drops.", navigation: "Click the network icon in the taskbar or menu bar, then use the Wi-Fi toggle.", expectedResult: "Your office network reconnects within about thirty seconds." },
    { text: "Next, let's make sure the saved network profile is not stale.", step: "Forget the office network, then join it again.", explanation: "Saved profiles can hold expired credentials after a password change.", navigation: "Network settings, select the office network, choose Forget, then reconnect.", expectedResult: "You are asked to sign in again and the connection holds." },
  ],
  camera: [
    { text: "First, confirm the meeting app is allowed to use the camera.", step: "Check camera permission for your meeting app.", explanation: "Operating system privacy settings silently block the camera if access was declined once.", navigation: "Settings, Privacy, Camera, then make sure your meeting app is switched on.", expectedResult: "Your preview appears in the meeting app's video settings." },
    { text: "Let's make sure no other app is holding the camera.", step: "Quit every app that might use video, then reopen only your meeting app.", explanation: "Only one app can use most built-in cameras at a time.", navigation: "Close browsers with meeting tabs and any other video apps fully.", expectedResult: "The camera light turns on when you open video settings." },
  ],
  audio: [
    { text: "Let's check where your sound is actually going.", step: "Select the correct speaker and microphone in your meeting app.", explanation: "Docking stations and headsets often take over as the default device without notice.", navigation: "In the meeting app, open Settings, then Audio devices.", expectedResult: "The speaker test plays and the mic meter moves when you talk." },
    { text: "Next, reset the audio device connection.", step: "Unplug or disconnect your headset, wait five seconds, then reconnect it.", explanation: "This makes the system re-detect the device and its drivers.", navigation: "For Bluetooth, use the Bluetooth menu to disconnect and reconnect.", expectedResult: "The headset appears again in your audio device list." },
  ],
  power: [
    { text: "Let's rule out the charger first.", step: "Plug the charger directly into a wall outlet and check the charging light.", explanation: "Power strips and docks are a common hidden cause.", navigation: "Use the original charger and the laptop's own charging port.", expectedResult: "A charging light or battery icon shows the laptop is charging." },
    { text: "Next, try a full power reset.", step: "Hold the power button for fifteen seconds, release, then press it once.", explanation: "This clears a frozen power state without affecting your files.", navigation: "The power button is usually top right of the keyboard.", expectedResult: "The manufacturer logo appears on screen." },
  ],
  other: [
    { text: "Let's start with the simplest reset that clears most issues.", step: "Save your work and restart the device.", explanation: "A restart clears stuck processes and applies pending updates.", navigation: "Start menu or Apple menu, then Restart.", expectedResult: "The problem is gone after you sign back in." },
  ],
};

let n = 0;
const uid = () => `d${Date.now().toString(36)}${(n++).toString(36)}`;

export function demoReply(history: DemoMessage[], userText: string): DemoMessage {
  const firstUser = history.find((m) => m.role === "user")?.text ?? userText;
  const topic = topicOf(firstUser);
  const used = history.filter((m) => m.role === "assistant" && m.step).length;
  const pool = STEPS[topic];
  if (used >= pool.length) {
    return { id: uid(), role: "assistant", text: "In a live session this is where TechAssist would suggest a handoff to your IT team, with a summary of every step you already tried. The demo stops here." };
  }
  return { id: uid(), role: "assistant", ...pool[used] };
}
export function userMsg(text: string): DemoMessage {
  return { id: uid(), role: "user", text };
}
