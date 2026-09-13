// api/_lib.js
// Common utilities for Vercel Serverless Functions

function setCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch (_) {
      return {};
    }
  }

  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function json(res, statusCode, data) {
  res.setHeader("Content-Type", "application/json");
  return res.status(statusCode).json(data);
}

function ok(res, data = {}) {
  return json(res, 200, { success: true, ...data });
}

function badRequest(res, message = "Bad Request") {
  return json(res, 400, { success: false, error: message });
}

function notFound(res, message = "Not Found") {
  return json(res, 404, { success: false, error: message });
}

function serverError(res, err) {
  console.error("[API Error]", err);
  const message = err && err.message ? err.message : "Internal Server Error";
  return json(res, 500, { success: false, error: message });
}

module.exports = {
  setCors,
  parseBody,
  json,
  ok,
  badRequest,
  notFound,
  serverError,
};
