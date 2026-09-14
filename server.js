// server.js
// Lightweight local development server for Rawgad Admin CMS
// Dispatches requests to the 2 consolidated endpoints: api/inventory.js & api/orders.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// Load .env fallback
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const idx = trimmed.indexOf("=");
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        if (!process.env[k]) process.env[k] = v;
      }
    }
  }
} catch (_) {}

const PORT = process.env.PORT || 3001;

const inventoryHandler = require("./api/inventory");
const ordersHandler = require("./api/orders");
const pathaoHandler = require("./api/pathao");

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname.replace(/\/+$/, "") || "/";

  // Vercel Serverless Function response adapter
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (data) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(data));
    return res;
  };

  req.query = parsedUrl.query;

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    return res.status(200).end();
  }

  // Route matching to the consolidated handlers
  let handler = null;
  if (pathname.startsWith("/api/inventory") || pathname === "/api/status") {
    handler = inventoryHandler;
  } else if (pathname.startsWith("/api/orders")) {
    handler = ordersHandler;
  } else if (pathname.startsWith("/api/pathao") || pathname === "/api/create-order") {
    handler = pathaoHandler;
  }

  if (handler) {
    if (["POST", "PATCH", "PUT"].includes(req.method)) {
      let bodyData = "";
      req.on("data", (chunk) => {
        bodyData += chunk;
      });
      req.on("end", async () => {
        try {
          req.body = bodyData.trim() ? JSON.parse(bodyData) : {};
        } catch (_) {
          req.body = {};
        }
        try {
          await handler(req, res);
        } catch (err) {
          console.error("API Error:", err);
          if (!res.writableEnded) {
            res.status(500).json({ success: false, error: err.message });
          }
        }
      });
      return;
    }

    try {
      await handler(req, res);
    } catch (err) {
      console.error("API Error:", err);
      if (!res.writableEnded) {
        res.status(500).json({ success: false, error: err.message });
      }
    }
    return;
  }

  // Serve static files (index.html, orders.html, inventory.html, pathao.html, etc.)
  let filePath = path.join(__dirname, pathname === "/" ? "index.html" : pathname);

  if (!fs.existsSync(filePath) && fs.existsSync(filePath + ".html")) {
    filePath = filePath + ".html";
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(__dirname, "index.html");
  }

  const ext = path.extname(filePath);
  const contentTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
  };

  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
});

server.listen(PORT, () => {
  console.log(`[Rawgad Admin CMS] Dev server running on http://localhost:${PORT}`);
});
