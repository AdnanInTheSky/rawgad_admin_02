// api/orders.js
// Consolidated Vercel Serverless Function for all Order operations:
// 1. GET  /api/orders -> List all orders with enriched catalog items, payment methods, TrxIDs & sender numbers
// 2. POST /api/orders -> Update order fulfillment status with real MongoDB multi-document transaction for cancellation

const { ObjectId } = require("mongodb");
const { setCors, parseBody, ok, badRequest, notFound, serverError } = require("./_lib");
const { getOrdersCollection, getInventoryCollection, getDb } = require("./_db");
const { getPurchasableCatalogMap, makeKey, normalizeId } = require("./_catalog");

const VALID_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];

/**
 * Helper to resolve exact inventory identity (productId, typeId, subProductId)
 * for an order item, including backward compatibility with legacy orders.
 */
function resolveOrderItemIdentity(item, catalogMap) {
  const rawId = String(item.id || item.productId || "").trim();
  let pId = item.productId || rawId;
  let tId = normalizeId(item.typeId);
  let sId = normalizeId(item.subProductId);

  // 1. Exact composite match
  if (pId && tId !== undefined && catalogMap.has(makeKey(pId, tId, sId))) {
    const cat = catalogMap.get(makeKey(pId, tId, sId));
    return { productId: cat.productId, typeId: cat.typeId, subProductId: cat.subProductId, cat };
  }

  // 2. Legacy resolution when typeId is missing but subProductId exists
  if (sId) {
    for (const cat of catalogMap.values()) {
      if (cat.subProductId === sId) {
        return { productId: cat.productId, typeId: cat.typeId, subProductId: cat.subProductId, cat };
      }
    }
  }

  // 3. Legacy resolution when rawId was the subProductId or typeId
  for (const cat of catalogMap.values()) {
    if (cat.subProductId === rawId || (cat.subProductId === null && cat.typeId === rawId)) {
      return { productId: cat.productId, typeId: cat.typeId, subProductId: cat.subProductId, cat };
    }
  }

  // 4. Fallback matching product ID only
  for (const cat of catalogMap.values()) {
    if (cat.productId === pId) {
      return { productId: cat.productId, typeId: cat.typeId, subProductId: cat.subProductId, cat };
    }
  }

  return { productId: pId, typeId: tId, subProductId: sId, cat: null };
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ==========================================
  // 1. GET: Fetch Orders
  // ==========================================
  if (req.method === "GET") {
    try {
      const ordersCol = await getOrdersCollection();
      const rawOrders = await ordersCol
        .find({})
        .sort({ created_at: -1, createdAt: -1, _id: -1 })
        .limit(500)
        .toArray();

      // Catalog map to enrich items with detailed titles and resolve legacy items
      const { map: catalogMap } = await getPurchasableCatalogMap();

      const orders = rawOrders.map((order) => {
        const invoiceNumber = order.invoice_number || String(order._id);
        const paymentMethod = String(order.payment_method || "cod").toLowerCase();

        // Normalize items with exact product, type, and subProduct IDs
        const rawItems = Array.isArray(order.items) ? order.items : [];
        const items = rawItems.map((item) => {
          const resolved = resolveOrderItemIdentity(item, catalogMap);
          const cat = resolved.cat;

          const qty = parseInt(item.qty || item.quantity || 1, 10);
          const price = Number(item.price) || (cat ? cat.price : 0);
          const subtotal = Number(item.subtotal) || (price * qty);

          return {
            id: item.id || resolved.subProductId || resolved.productId,
            productId: resolved.productId,
            typeId: resolved.typeId,
            subProductId: resolved.subProductId,
            name: item.name || item.title || (cat ? cat.displayName : "Item"),
            productTitle: cat ? cat.productTitle : (item.productTitle || item.name || "Item"),
            typeTitle: cat ? cat.typeTitle : (item.typeTitle || (resolved.typeId ? `Type: ${resolved.typeId}` : "—")),
            subTitle: cat ? cat.subTitle : (item.subTitle || (resolved.subProductId ? `Sub: ${resolved.subProductId}` : null)),
            price,
            qty,
            subtotal,
            imageSrc: (cat ? cat.imageSrc : item.imageSrc) || "",
          };
        });

        const totalItemsCount = items.reduce((sum, i) => sum + (i.qty || 1), 0);
        const stockRestored = !!(order.stockRestored || order.stock_restored);

        return {
          _id: String(order._id),
          orderId: invoiceNumber,
          invoice_number: invoiceNumber,
          customer: {
            name: order.customer?.name || "Anonymous",
            phone: order.customer?.phone || "N/A",
            email: order.customer?.email || "N/A",
            full_address: order.customer?.full_address || order.customer?.address_detail || "N/A",
          },
          items,
          totalItemsCount,
          subtotal: Number(order.subtotal) || 0,
          discount_amount: Number(order.discount_amount) || 0,
          delivery_charge: Number(order.delivery_charge) || 0,
          payment_amount: Number(order.payment_amount) || 0,
          currency: order.currency || "BDT",
          payment_method: paymentMethod,
          trx_id: order.trx_id || null,
          trx_status: order.trx_status || "pending",
          sender_number: order.sender_number || null,
          verified: !!order.verified,
          status: String(order.status || "pending").toLowerCase(),
          stockRestored,
          stock_restored: stockRestored,
          stockRestoredAt: order.stockRestoredAt || order.stock_restored_at || null,
          created_at: order.created_at || order.createdAt || null,
          updated_at: order.updated_at || order.updatedAt || order.created_at || null,
        };
      });

      return ok(res, {
        count: orders.length,
        orders,
      });
    } catch (err) {
      return serverError(res, err);
    }
  }

  // ==========================================
  // 2. POST: Update Order Status & Handle Cancellation
  // ==========================================
  if (req.method === "POST" || req.method === "PATCH") {
    try {
      const body = await parseBody(req);
      const orderIdentifier = body.invoice_number || body.id || body._id;
      const newStatus = body.status ? String(body.status).toLowerCase().trim() : "";

      if (!orderIdentifier) {
        return badRequest(res, "Missing order identifier ('invoice_number' or 'id').");
      }

      if (!newStatus || !VALID_STATUSES.includes(newStatus)) {
        return badRequest(
          res,
          `Invalid status '${newStatus}'. Must be one of: ${VALID_STATUSES.join(", ")}`
        );
      }

      const client = await getDb();
      const db = client.db("paystationdemo");
      const ordersCol = db.collection("orders");
      const inventoryCol = db.collection("inventory");

      const filter = {
        $or: [{ invoice_number: String(orderIdentifier) }],
      };

      if (ObjectId.isValid(orderIdentifier)) {
        try {
          filter.$or.push({ _id: new ObjectId(orderIdentifier) });
        } catch (_) {}
      }

      const existingOrder = await ordersCol.findOne(filter);
      if (!existingOrder) {
        return notFound(res, `Order '${orderIdentifier}' not found.`);
      }

      const prevStatus = existingOrder.status;
      const now = new Date();
      let stockRestored = false;
      let restoredTotalQuantity = 0;

      // ----------------------------------------------------
      // Order Cancellation & Transactional Stock Restoration
      // When an order changes to 'cancelled':
      // 1. Start a MongoDB session.
      // 2. Start a MongoDB transaction.
      // 3. Read the order within the transaction.
      // 4. Check whether stock has already been restored.
      // 5. Resolve the exact inventory identity for every line item.
      // 6. Increment each inventory record by the ordered quantity.
      // 7. Update the order:
      //    status = cancelled
      //    stockRestored = true
      //    restoration timestamp
      // 8. Commit the transaction.
      // ----------------------------------------------------
      if (newStatus === "cancelled") {
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            const orderInTx = await ordersCol.findOne(filter, { session });
            if (!orderInTx) {
              throw new Error(`Order '${orderIdentifier}' not found during transaction.`);
            }

            const alreadyRestored = !!(orderInTx.stockRestored || orderInTx.stock_restored);

            // If order is already cancelled and stock was already restored, do not restore again
            if (alreadyRestored || orderInTx.status === "cancelled") {
              await ordersCol.updateOne(
                { _id: orderInTx._id },
                {
                  $set: {
                    status: "cancelled",
                    updated_at: now,
                    updatedAt: now,
                  },
                },
                { session }
              );
              stockRestored = false;
              return;
            }

            // Fetch catalog map for item identity resolution
            const { map: catalogMap } = await getPurchasableCatalogMap();
            const rawItems = Array.isArray(orderInTx.items) ? orderInTx.items : [];

            // Atomically increment each inventory record within the transaction
            for (const item of rawItems) {
              const qty = parseInt(item.qty || item.quantity || 1, 10);
              if (qty > 0) {
                const resolved = resolveOrderItemIdentity(item, catalogMap);
                const pId = resolved.productId;
                const tId = normalizeId(resolved.typeId);
                const sId = normalizeId(resolved.subProductId);

                await inventoryCol.updateOne(
                  {
                    productId: pId,
                    typeId: tId,
                    subProductId: sId,
                  },
                  {
                    $inc: { stock: qty },
                    $set: { updatedAt: now },
                  },
                  { session }
                );
                restoredTotalQuantity += qty;
              }
            }

            // Update order record within the transaction
            await ordersCol.updateOne(
              { _id: orderInTx._id },
              {
                $set: {
                  status: "cancelled",
                  stockRestored: true,
                  stock_restored: true,
                  stockRestoredAt: now,
                  stock_restored_at: now,
                  stockRestoredQuantity: restoredTotalQuantity,
                  updated_at: now,
                  updatedAt: now,
                },
              },
              { session }
            );

            stockRestored = true;
          });
        } catch (txError) {
          // Transaction automatically aborts if withTransaction throws
          console.error("[Cancellation Transaction Failed]", txError);
          return serverError(res, txError);
        } finally {
          await session.endSession();
        }
      } else {
        // Status is not cancelled (e.g. pending, confirmed, processing, shipped, delivered)
        // If a cancelled order is later moved to another status, do not automatically deduct stock again
        await ordersCol.updateOne(
          { _id: existingOrder._id },
          {
            $set: {
              status: newStatus,
              updated_at: now,
              updatedAt: now,
            },
          }
        );
      }

      const updatedDoc = await ordersCol.findOne(filter);

      const msg = stockRestored
        ? `Order ${existingOrder.invoice_number || existingOrder._id} cancelled and ${restoredTotalQuantity} item(s) restored to stock in a MongoDB transaction.`
        : `Order ${existingOrder.invoice_number || existingOrder._id} status updated to ${newStatus}`;

      return ok(res, {
        message: msg,
        orderId: existingOrder.invoice_number || String(existingOrder._id),
        previousStatus: prevStatus,
        status: newStatus,
        stockRestored,
        restoredTotalQuantity: stockRestored ? restoredTotalQuantity : 0,
        updated_at: now,
        order: updatedDoc,
      });
    } catch (err) {
      return serverError(res, err);
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed. Use GET or POST." });
};
