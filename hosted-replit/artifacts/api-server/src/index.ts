import app from "./app";
import { logger } from "./lib/logger";
import { synchronizeCorpus } from "./lib/corpus-bootstrap";
import { SupportError } from "./lib/support-config";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  if (process.env.NODE_ENV === "production" && process.env.TECHASSIST_SYNC_ON_STARTUP === "true") {
    // Health/startup serving is independent of retrieval readiness.
    void synchronizeCorpus().then(report => {
      logger.info({ stage: report.stage, message: report.message }, "Approved corpus startup synchronization");
    }).catch(error => {
      logger.warn({ reason: error instanceof SupportError ? error.message : "Database, provider or schema check failed; use authorized admin setup to retry." },
        "Corpus is not ready; frontend remains available");
    });
  }
});
