// Operator-only command, never a public unauthenticated route.
// Uses process credentials internally and prints only sanitized check results.
import { pool } from "@workspace/db";
import { synchronizeCorpus } from "../lib/corpus-bootstrap";
import { SupportError } from "../lib/support-config";

try {
  const report = await synchronizeCorpus(true);
  console.log(report.stage, report.message);
  console.log("Authenticated chat regression was not run. Sign in as an authorized administrator at /admin and select step 3.");
  if (!["synced", "ready"].includes(report.stage)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof SupportError ? error.message : "Validation could not start. Check required provider Secrets and database schema. No live verification was completed.");
  process.exitCode = 1;
} finally { await pool.end(); }
