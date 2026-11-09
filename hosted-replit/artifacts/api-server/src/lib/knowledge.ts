import { SupportError } from "./support-config";

// Recursively split on structural boundaries; retain 180 characters of overlap.
export function recursiveChunks(text: string, size = 1400, separators = ["\n\n", "\n", ". ", " ", ""]): string[] {
  if (text.length <= size) return text.trim() ? [text.trim()] : [];
  const [separator = "", ...rest] = separators;
  if (!separator) {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += size - 180) chunks.push(text.slice(i, i + size));
    return chunks;
  }
  const pieces = text.split(separator);
  const result: string[] = [];
  let current = "";
  for (const piece of pieces) {
    if (piece.length > size) {
      if (current.trim()) result.push(current.trim());
      current = "";
      result.push(...recursiveChunks(piece, size, rest));
    } else if ((current + separator + piece).length > size) {
      result.push(current.trim());
      current = current.slice(-180) + separator + piece;
      if (current.length > size) { result.push(...recursiveChunks(current, size, rest)); current = ""; }
    } else current += (current ? separator : "") + piece;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}
export function flattenJson(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => flattenJson(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => flattenJson(v, path ? `${path}.${k}` : k));
  return value == null ? [] : [`${path}: ${String(value)}`];
}
export async function ingest(_input: { title: string; sourceUrl?: string; content: string }): Promise<{ documentId: string; chunks: number }> {
  // The approved source is read-only. Never append, replace, or delete its vectors.
  throw new SupportError(409, "This app uses a protected existing corpus. Use Validate and synchronize to import its metadata without changing Pinecone. New content must be approved and indexed by the source corpus owner.");
}
