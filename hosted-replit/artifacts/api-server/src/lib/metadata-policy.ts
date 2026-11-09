import { z } from "zod";
import { embeddingModel, SupportError } from "./support-config";

export const deviceTypes = ["laptop", "desktop", "tablet"] as const;
export const vendors = ["dell", "apple", "hp", "lenovo", "asus", "acer", "microsoft", "other"] as const;
export const categories = ["hardware", "software"] as const;
export const subcategories = ["audio", "battery_safety", "bluetooth", "bluetooth_audio", "camera", "camera_permissions", "charging", "cooling", "crashes", "disk_encryption", "display", "filesystem", "graphics_driver", "input_devices", "mac_startup", "memory", "motherboard", "networking", "os_recovery", "security", "storage", "updates"] as const;
export const languages = ["en", "es", "fr", "de", "ja", "zh"] as const;
const optionalSet = <T extends z.ZodTypeAny>(schema: T) => z.array(schema).min(1).max(24).optional();
export const metadataSettings = z.object({
  category: optionalSet(z.enum(categories)), subcategory: optionalSet(z.enum(subcategories)),
  language: optionalSet(z.enum(languages)), deviceType: z.enum(deviceTypes).optional(), vendor: z.enum(vendors).optional(),
  reviewedAfter: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
    const time = Date.parse(s); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === s;
  }).optional(),
}).strict();
type Settings = z.infer<typeof metadataSettings>;
export type DeviceScope = { os: string; deviceType?: string; vendor?: string };
type Family = "windows" | "macos" | "ubuntu" | "linux" | "fedora" | "debian" | "chromeos" | "general";
type Platform = { family: Family; version?: string; vendor?: string; deviceType?: string };
export type FilterPolicy = Readonly<Settings & { family?: Family; version?: string }>;
export type Metadata = Record<string, unknown>;
const clean = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const known = (s: string) => Boolean(s.trim()) && !/^(unknown|unspecified|not provided|not known|n\/a|none|\[unknown\])$/i.test(s.trim());
function first(m: Metadata, names: string[]) {
  for (const name of names) if (typeof m[name] === "string" && String(m[name]).trim()) return String(m[name]).trim();
  return "";
}
const platformAliases: Record<string, Platform> = {
  "windows": { family: "windows" }, "win": { family: "windows" },
  "windows 11": { family: "windows", version: "11" }, "win 11": { family: "windows", version: "11" },
  "windows 10": { family: "windows", version: "10" }, "win 10": { family: "windows", version: "10" },
  "windows 11; external devices": { family: "windows", version: "11" },
  "macos": { family: "macos" }, "mac os": { family: "macos" }, "os x": { family: "macos" },
  "macos; mac laptops": { family: "macos", vendor: "apple", deviceType: "laptop" },
  "ubuntu": { family: "ubuntu" }, "ubuntu desktop": { family: "ubuntu" },
  "ubuntu desktop with networkmanager": { family: "ubuntu" },
  "linux": { family: "linux" }, "fedora": { family: "fedora" }, "debian": { family: "debian" },
  "chromeos": { family: "chromeos" }, "chrome os": { family: "chromeos" },
  "dell laptops": { family: "general", vendor: "dell", deviceType: "laptop" },
  "dell laptops with windows": { family: "windows", vendor: "dell", deviceType: "laptop" },
  "general": { family: "general" }, "all": { family: "general" },
  "all platforms": { family: "general" }, "os-agnostic": { family: "general" }, "cross-platform": { family: "general" },
};
export function normalizePlatform(raw: string): Platform | undefined {
  const value = clean(raw);
  if (/^macos(?: \d+(?:\.\d+)*)?$/.test(value)) return { family: "macos" };
  const windows = value.match(/^(?:windows|win)\s*(10|11)(?: (?:pro|home|enterprise|education))?$/);
  return windows ? { family: "windows", version: windows[1] } : platformAliases[value];
}
export function buildFilterPolicy(context: DeviceScope, config?: unknown): FilterPolicy {
  let settings: Settings;
  try { settings = metadataSettings.parse(config ?? JSON.parse(process.env.RAG_METADATA_FILTERS || "{}")); }
  catch { throw new SupportError(500, "Invalid server metadata filter configuration. Review the documented allowlist."); }
  const os = known(context.os) ? normalizePlatform(context.os) : undefined;
  if (known(context.os) && (!os || os.family === "general")) throw new SupportError(400, "The operating system is not supported by the metadata filter policy. Specify Windows 10/11, macOS, Ubuntu, Linux, Fedora, Debian or ChromeOS.");
  for (const [key, allow] of [["deviceType", deviceTypes], ["vendor", vendors]] as const) {
    const value = context[key];
    if (value !== undefined && !(allow as readonly string[]).includes(value)) throw new SupportError(400, `Unsupported confirmed ${key}. Select a supported value or leave it unconfirmed.`);
    if (value && settings[key] && value !== settings[key]) throw new SupportError(400, `Confirmed ${key} conflicts with the configured evidence scope. The constraint was not relaxed.`);
  }
  return Object.freeze({ ...settings, family: os?.family, version: os?.version,
    deviceType: context.deviceType as Settings["deviceType"] || settings.deviceType,
    vendor: context.vendor as Settings["vendor"] || settings.vendor });
}
export function policyKeys(policy: FilterPolicy) {
  return ["namespace", "ready", "embedding", ...Object.entries(policy).filter(([, v]) => v !== undefined).map(([k]) => k)].sort();
}

export function metadataRejection(metadata: unknown, policy: FilterPolicy): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "unknown_metadata";
  const m = metadata as Metadata;
  const raw = first(m, ["platform", "os"]);
  const scope = normalizePlatform(raw);
  if (!scope) return "unknown_platform";
  // Conflicting aliases are not a license to widen scope.
  if (m.platform && m.os && JSON.stringify(normalizePlatform(String(m.os))) !== JSON.stringify(scope)) return "conflicting_platform";
  const model = first(m, ["embedding_model", "embeddingModel", "embed_model", "embedding_model_name"]);
  const provider = first(m, ["embedding_provider", "embeddingProvider"]);
  const dimensions = m.embedding_dimensions ?? m.embedding_dimension ?? m.dimensions;
  if (![embeddingModel(), `pinecone/${embeddingModel()}`].includes(model) ||
    (provider && clean(provider) !== "pinecone") || (dimensions !== undefined && Number(dimensions) !== 1024)) return "embedding_incompatible";
  if (first(m, ["model", "device_model", "laptop_model"])) return "model_scope_unsupported";
  const explicitVendor = first(m, ["vendor", "manufacturer"]);
  if (explicitVendor && (!(vendors as readonly string[]).includes(clean(explicitVendor)) || (scope.vendor && scope.vendor !== clean(explicitVendor)))) return "unknown_vendor";
  const vendor = explicitVendor ? clean(explicitVendor) : scope.vendor;
  if (vendor && !policy.vendor) return "vendor_unconfirmed";
  if (vendor && vendor !== policy.vendor) return "vendor_mismatch";
  const rawDevice = first(m, ["device_type", "deviceType"]);
  if (rawDevice && !(deviceTypes as readonly string[]).includes(clean(rawDevice)) && !["general", "all"].includes(clean(rawDevice))) return "unknown_device";
  const device = rawDevice ? clean(rawDevice) : scope.deviceType;
  if (scope.deviceType && device && !["general", "all", scope.deviceType].includes(device)) return "conflicting_device";
  if (policy.deviceType && !device) return "device_unconfirmed";
  if (policy.deviceType && device && !["general", "all", policy.deviceType].includes(device)) return "device_mismatch";
  if (scope.family !== "general") {
    if (!policy.family) return "os_unconfirmed";
    if (scope.family !== policy.family) return "os_mismatch";
    // A version-specific procedure needs a matching confirmed version. Conversely,
    // unversioned Windows procedures are not assumed compatible with 10 or 11.
    if (scope.family === "windows" && scope.version !== policy.version) return "os_version_mismatch";
  }
  for (const [key, values] of [["category", policy.category], ["subcategory", policy.subcategory], ["language", policy.language]] as const) {
    if (values && !(values as readonly string[]).includes(clean(first(m, [key])))) return `${key}_mismatch`;
  }
  if (policy.reviewedAfter) {
    const date = first(m, ["reviewed_on"]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date || date < policy.reviewedAfter) return "freshness_mismatch";
  }
  // risk_level=high and technical_validation=not_lab_tested are provenance,
  // never exclusion predicates or a technician-approval claim.
  return undefined;
}

const identityFields = ["document_id", "documentId", "doc_id", "docId"];
const scopeFields = ["platform", "os", "device_type", "deviceType", "vendor", "manufacturer", "category", "subcategory", "language",
  "embedding_model", "embeddingModel", "embed_model", "embedding_model_name", "embedding_provider", "embeddingProvider",
  "embedding_dimensions", "embedding_dimension", "dimensions"];
export type DocumentFilter = Record<string, unknown>;
export function compileDocumentFilter(records: { id: string; metadata: Metadata }[], policy: FilterPolicy): DocumentFilter {
  const clauses = new Map<string, DocumentFilter>();
  for (const { metadata: m } of records) {
    const identity = identityFields.find(k => typeof m[k] === "string" && String(m[k]).trim());
    if (!identity) throw new SupportError(503, "A synchronized knowledge record lacks a stable source identity. Validate and synchronize the corpus.");
    const keys = [identity, ...scopeFields, ...(policy.reviewedAfter ? ["reviewed_on"] : [])];
    const and = keys.filter(k => ["string", "number", "boolean"].includes(typeof m[k])).map(k => ({ [k]: { $eq: m[k] } }));
    const clause = { $and: and };
    clauses.set(JSON.stringify(clause), clause);
  }
  // No eligible records => short-circuit retrieval, never send an empty filter.
  const filter = { $or: [...clauses.values()] };
  if (Buffer.byteLength(JSON.stringify(filter)) > 128 * 1024) {
    throw new SupportError(503, "The metadata filter exceeds the bounded compatibility payload limit. An administrator must configure a supported strategy; filters were not relaxed.");
  }
  return filter;
}
