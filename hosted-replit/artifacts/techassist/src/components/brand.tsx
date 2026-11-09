import { cn } from "@/lib/utils";

export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-8 w-8", className)} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="hsl(158 45% 9%)" />
      <path d="M18 22h28M32 22v24" stroke="hsl(152 55% 52%)" strokeWidth="5" strokeLinecap="round" />
      <circle cx="46" cy="44" r="4" fill="hsl(40 40% 94%)" />
    </svg>
  );
}

export function Wordmark({ light }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <Mark />
      <span className={cn("font-display text-[1.2rem] font-medium", light ? "text-sidebar-accent-foreground" : "text-foreground")}>
        TechAssist<span className={light ? "text-sidebar-primary" : "text-primary"}>.ai</span>
      </span>
    </span>
  );
}

export const PROMPTS = [
  { key: "connectivity", label: "Connectivity", text: "My laptop keeps dropping the office Wi-Fi." },
  { key: "camera", label: "Camera and meetings", text: "My camera is not working in video meetings." },
  { key: "audio", label: "Audio", text: "People cannot hear me on calls, or I cannot hear them." },
  { key: "power", label: "Laptop power", text: "My laptop will not charge or turn on." },
];
