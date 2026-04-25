import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import cron from "node-cron";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '10mb' }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);

      // Built-in daily report scheduler — midnight US Eastern (4:00 or 5:00 UTC)
      // Runs at both 4:00 and 5:00 UTC to cover EST and EDT
      cron.schedule("0 4 * * *", () => {
        log("Daily report cron triggered (4:00 UTC)", "cron");
        const postData = JSON.stringify({ date: getYesterdayET() });
        const http = require("http");
        const req = http.request({
          hostname: "localhost", port, path: "/api/admin/daily-report",
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer internal-cron", "Content-Length": Buffer.byteLength(postData) },
        }, (res: any) => {
          let body = "";
          res.on("data", (c: any) => body += c);
          res.on("end", () => log(`Daily report result: ${body}`, "cron"));
        });
        req.on("error", (err: any) => log(`Daily report error: ${err.message}`, "cron"));
        req.write(postData);
        req.end();
      }, { timezone: "UTC" });

      function getYesterdayET(): string {
        // Get yesterday's date in US Eastern timezone
        const now = new Date();
        const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
        et.setDate(et.getDate() - 1);
        return et.toISOString().split("T")[0];
      }

      // Sync time reports spreadsheet at 4:05 UTC (right after daily report)
      cron.schedule("5 4 * * *", () => {
        log("Time reports sheet sync triggered", "cron");
        const http = require("http");
        const req = http.request({
          hostname: "localhost", port, path: "/api/admin/sync-time-reports-sheet",
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer internal-cron" },
        }, (res: any) => {
          let body = "";
          res.on("data", (c: any) => body += c);
          res.on("end", () => log(`Time reports sync result: ${body}`, "cron"));
        });
        req.on("error", (err: any) => log(`Time reports sync error: ${err.message}`, "cron"));
        req.end();
      }, { timezone: "UTC" });

      log("Daily report scheduler active (midnight ET)", "cron");

      // Document reminder scheduler - runs at 9:00 AM ET (14:00 UTC)
      cron.schedule("0 14 * * *", () => {
        log("Document reminder cron triggered", "cron");
        const http = require("http");
        const req = http.request({
          hostname: "localhost", port, path: "/api/admin/doc-reminders",
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer internal-cron", "Content-Length": "2" },
        }, (res: any) => {
          let body = "";
          res.on("data", (c: any) => body += c);
          res.on("end", () => log(`Document reminders result: ${body}`, "cron"));
        });
        req.on("error", (err: any) => log(`Document reminders error: ${err.message}`, "cron"));
        req.write("{}");
        req.end();
      }, { timezone: "UTC" });

      log("Document reminder scheduler active (9 AM ET)", "cron");

      // Daily 7pm Florida-time reminder (Mon–Sat). Uses America/New_York
      // tz so DST is auto-handled. Sundays excluded.
      cron.schedule("0 19 * * 1-6", () => {
        log("Daily 7pm reminder cron triggered", "cron");
        const http = require("http");
        const req = http.request({
          hostname: "localhost", port, path: "/api/admin/daily-7pm-reminders",
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer internal-cron", "Content-Length": "2" },
        }, (res: any) => {
          let body = "";
          res.on("data", (c: any) => body += c);
          res.on("end", () => log(`Daily 7pm reminders result: ${body}`, "cron"));
        });
        req.on("error", (err: any) => log(`Daily 7pm reminders error: ${err.message}`, "cron"));
        req.write("{}");
        req.end();
      }, { timezone: "America/New_York" });

      log("Daily 7pm reminder scheduler active (Mon–Sat ET)", "cron");
    },
  );
})();
