import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
const defaultAllowedOrigins = [
  "http://localhost",
  "https://localhost",
  "capacitor://localhost",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "https://kritamcqs.com",
  "https://www.kritamcqs.com",
  "https://app.kritamcqs.com",
  "http://admin.kritamcqs.com",
  "https://admin.kritamcqs.com",
  "https://affiliate.kritamcqs.com",
  "http://localhost:3000",
  "http://localhost:3001",
  "https://acd9-2409-40f4-111b-5b22-b02b-bda8-9293-fc44.ngrok-free.app",
];
const configuredAllowedOrigins = String(process.env["CLIENT_ORIGIN"] || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = [...new Set([...defaultAllowedOrigins, ...configuredAllowedOrigins])];

app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (mobile apps, postman, curl)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS not allowed for origin: ${origin}`));
      }
    },
    credentials: true,
  })
);

app.use(express.static(path.resolve(process.cwd(), "public")));

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

app.use("/api", router);

export default app;
