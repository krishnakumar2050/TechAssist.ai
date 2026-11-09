import { pool } from "@workspace/db";
import { liveReady, runValidation, validationReport } from "./corpus-validation";
import { indexName, namespace, SupportError } from "./support-config";

// Explicitly authorized operator maintenance. Never runs chat tests or grants roles.
// Only data DML: Replit's publish flow, not startup, owns production schema DDL.
export async function synchronizeCorpus(force = false) {
  const connection = await pool.connect();
  const key = `corpus-bootstrap:${indexName()}:${namespace()}`;
  let held = false;
  try {
    held = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [key])).rows[0].locked;
    if (!held) return { stage: "busy" as const, message: "Another instance is synchronizing the approved source." };
    const schema = await connection.query("SELECT to_regclass('public.support_validation') IS NOT NULL AS available");
    if (!schema.rows[0].available) throw new SupportError(503, "Republish to apply the additive database schema before synchronization. Startup will not create tables.");
    await connection.query("SELECT metadata FROM support_chunks LIMIT 0");
    if (!force && await liveReady()) return await validationReport();
    let report = await validationReport();
    if (force || !["providers", "syncing"].includes(report.stage)) report = await runValidation("providers");
    if (report.stage === "failed") throw new SupportError(503, report.message);
    while (report.stage === "providers" || report.stage === "syncing") {
      report = await runValidation("sync");
      if (report.stage === "failed") throw new SupportError(503, report.message);
    }
    return report;
  } finally {
    if (held) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
    connection.release();
  }
}
