import { connect } from "@api/db";
import app from "./app";
import { syncDifficultyCatalog } from "./lib/difficulty-catalog";
import { logger } from "./lib/logger";
import { syncQuestionTypeCatalog } from "./lib/question-type-catalog";
import 'dotenv/config';
import { createServer } from "node:http";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
const maxPortAttempts = 10;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function listenWithFallback(preferredPort: number) {
  let currentPort = preferredPort;

  for (let attempt = 0; attempt < maxPortAttempts; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer(app);

        server.once("error", (err: NodeJS.ErrnoException) => {
          server.close(() => reject(err));
        });

        server.listen(currentPort, () => {
          logger.info(
            {
              port: currentPort,
              requestedPort: preferredPort,
              fallbackUsed: currentPort !== preferredPort,
            },
            currentPort === preferredPort ? "Server listening" : "Server listening on fallback port",
          );
          resolve();
        });
      });

      return;
    } catch (err) {
      const listenError = err as NodeJS.ErrnoException;
      if (listenError.code !== "EADDRINUSE") {
        throw err;
      }

      currentPort += 1;
    }
  }

  throw new Error(`No available port found between ${preferredPort} and ${preferredPort + maxPortAttempts - 1}.`);
}

(async () => {
  try {
    await connect();
    await syncDifficultyCatalog();
    await syncQuestionTypeCatalog();
    logger.info("Connected to MongoDB");
  } catch (err) {
    logger.error({ err }, "Failed to connect to MongoDB");
    process.exit(1);
  }

  try {
    await listenWithFallback(port);
  } catch (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
})();
