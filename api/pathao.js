// api/pathao.js
// Pathao Courier API integration for Rawgad Admin CMS
// Handles token issuance, caching, store listing, and order dispatch to Pathao Aladdin API

const fs = require("fs");
const path = require("path");
const { setCors, parseBody, ok, badRequest, serverError } = require("./_lib");
const { getOrdersCollection } = require("./_db");

function loadEnvFallback() {
  if (process.env.PATHAO_BASE_URL) return;
  try {
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const idx = trimmed.indexOf("=");
          const k = trimmed.slice(0, idx).trim();
          const v = trimmed.slice(idx + 1).trim();
          if (!process.env[k]) {
            process.env[k] = v;
          }
        }
      }
    }
  } catch (_) {}
}

// In-memory token cache across warm invocations
let tokenCache = {
  accessToken: null,
  expiresAt: 0,
};

async function getAccessToken() {
  loadEnvFallback();
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const baseUrl = (process.env.PATHAO_BASE_URL || "https://courier-api-sandbox.pathao.com").replace(/\/+$/, "");
  const clientId = (process.env.PATHAO_CLIENT_ID || "").trim();
  const clientSecret = (process.env.PATHAO_CLIENT_SECRET || "").trim();
  const username = (process.env.PATHAO_USERNAME || "").trim();
  const password = (process.env.PATHAO_PASSWORD || "").trim();

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error("Missing Pathao API credentials in environment (PATHAO_CLIENT_ID, PATHAO_CLIENT_SECRET, PATHAO_USERNAME, PATHAO_PASSWORD).");
  }

  const response = await fetch(`${baseUrl}/aladdin/api/v1/issue-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "password",
      username,
      password,
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    throw new Error(`Pathao token generation failed: ${errData.message || response.statusText}`);
  }

  const data = await response.json();
  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = Date.now() + Math.max((data.expires_in - 3600) * 1000, 60000);

  return tokenCache.accessToken;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  loadEnvFallback();
  const baseUrl = (process.env.PATHAO_BASE_URL || "https://courier-api-sandbox.pathao.com").replace(/\/+$/, "");

  // ----------------------------------------------------
  // GET /api/pathao - Get Stores or Config
  // ----------------------------------------------------
  if (req.method === "GET") {
    const action = (req.query && req.query.action) || "";

    if (action === "stores") {
      try {
        const token = await getAccessToken();
        const storeRes = await fetch(`${baseUrl}/aladdin/api/v1/stores`, {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        });
        const storeData = await storeRes.json().catch(() => ({}));
        if (!storeRes.ok) {
          return res.status(storeRes.status).json({ success: false, error: storeData.message || "Failed to fetch stores" });
        }
        const stores = (storeData.data && storeData.data.data) || storeData.data || [];
        return ok(res, {
          stores,
          defaultStoreId: process.env.PATHAO_STORE_ID || (stores[0] ? stores[0].store_id : null),
        });
      } catch (err) {
        return serverError(res, err);
      }
    }

    // Default GET: Return status and default store ID
    return ok(res, {
      configured: !!(process.env.PATHAO_CLIENT_ID && process.env.PATHAO_CLIENT_SECRET),
      baseUrl,
      defaultStoreId: process.env.PATHAO_STORE_ID || null,
    });
  }

  // ----------------------------------------------------
  // POST /api/pathao or /api/create-order - Create Pathao Delivery Order
  // ----------------------------------------------------
  if (req.method === "POST") {
    try {
      const orderData = await parseBody(req);

      if (!orderData.store_id) {
        orderData.store_id = process.env.PATHAO_STORE_ID || "";
      }

      if (!orderData.store_id || !orderData.recipient_name || !orderData.recipient_phone || !orderData.recipient_address) {
        return badRequest(res, "Missing required fields: store_id, recipient_name, recipient_phone, and recipient_address are mandatory.");
      }

      // Format & sanitize fields
      let cleanPhone = String(orderData.recipient_phone).replace(/[^0-9]/g, "");
      if (cleanPhone.startsWith("880")) cleanPhone = "0" + cleanPhone.slice(3);
      if (cleanPhone.length > 11 && cleanPhone.startsWith("88")) cleanPhone = cleanPhone.slice(2);

      const payload = {
        store_id: parseInt(orderData.store_id, 10),
        merchant_order_id: String(orderData.merchant_order_id || `ORD-${Date.now()}`),
        recipient_name: String(orderData.recipient_name).trim(),
        recipient_phone: cleanPhone,
        recipient_address: String(orderData.recipient_address).trim(),
        delivery_type: parseInt(orderData.delivery_type || 48, 10),
        item_type: parseInt(orderData.item_type || 2, 10),
        special_instruction: String(orderData.special_instruction || "").trim(),
        item_quantity: parseInt(orderData.item_quantity || 1, 10),
        item_weight: parseFloat(orderData.item_weight || 0.5),
        amount_to_collect: parseInt(orderData.amount_to_collect || 0, 10),
      };

      if (orderData.recipient_city) payload.recipient_city = parseInt(orderData.recipient_city, 10);
      if (orderData.recipient_zone) payload.recipient_zone = parseInt(orderData.recipient_zone, 10);
      if (orderData.recipient_area) payload.recipient_area = parseInt(orderData.recipient_area, 10);

      // 1. Get Access Token
      const accessToken = await getAccessToken();

      // 2. Dispatch to Pathao Aladdin API
      const pathaoResponse = await fetch(`${baseUrl}/aladdin/api/v1/orders`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });

      const responseData = await pathaoResponse.json().catch(() => ({}));

      if (!pathaoResponse.ok) {
        return res.status(pathaoResponse.status).json({
          success: false,
          error: responseData.message || "Failed to create Pathao delivery order",
          details: responseData,
        });
      }

      // 3. If linked to an order in MongoDB, update order record
      const consignmentId = responseData.data?.consignment_id;
      const merchantOrderId = payload.merchant_order_id;
      let orderUpdated = false;

      if (consignmentId && merchantOrderId) {
        try {
          const ordersCol = await getOrdersCollection();
          const existing = await ordersCol.findOne({
            $or: [{ invoice_number: merchantOrderId }, { _id: merchantOrderId }],
          });

          if (existing) {
            const now = new Date();
            await ordersCol.updateOne(
              { _id: existing._id },
              {
                $set: {
                  pathao_consignment_id: consignmentId,
                  pathao_order_status: responseData.data?.order_status || "Pending",
                  pathao_delivery_fee: responseData.data?.delivery_fee || null,
                  pathao_dispatched_at: now,
                  status: existing.status === "pending" || existing.status === "confirmed" || existing.status === "processing" ? "shipped" : existing.status,
                  updated_at: now,
                  updatedAt: now,
                },
              }
            );
            orderUpdated = true;
          }
        } catch (dbErr) {
          console.warn("[Pathao Order DB Update Warning]", dbErr.message);
        }
      }

      return ok(res, {
        message: "Order dispatched to Pathao successfully",
        orderUpdated,
        consignment_id: consignmentId,
        delivery_fee: responseData.data?.delivery_fee,
        data: responseData.data,
      });
    } catch (err) {
      return serverError(res, err);
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed. Use GET or POST." });
};
