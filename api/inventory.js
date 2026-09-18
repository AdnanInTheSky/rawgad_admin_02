// api/inventory.js
// Consolidated Vercel Serverless Function for all Inventory operations:
// 1. GET  /api/inventory           -> Returns live stock merged with public catalog metadata & system status
// 2. POST /api/inventory (sync)    -> Synchronizes catalog with MongoDB, adds missing items with stock: 0
// 3. POST /api/inventory (mutations) -> Set, increase, decrease stock enforcing stock >= 0 & INSUFFICIENT_STOCK

const { setCors, parseBody, ok, badRequest, serverError } = require("./_lib");
const { getInventoryCollection, getOrdersCollection, getDb } = require("./_db");
const { getPurchasableCatalogMap, makeKey, normalizeId, CATALOG_URL, getStoreBaseUrl, buildNestedCatalog, getStockStatus } = require("./_catalog");

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const url = (req.url || "").toLowerCase();

  // ==========================================
  // 1. GET: Fetch Inventory & Catalog Metadata
  // ==========================================
  if (req.method === "GET") {
    try {
      const inventoryCol = await getInventoryCollection();

      // Quick status mode if requested via ?status=true or /api/status
      if (req.query?.status === "true" || url.includes("/status")) {
        const client = await getDb();
        await client.db("admin").command({ ping: 1 });
        const ordersCol = await getOrdersCollection();
        const [invCount, ordCount] = await Promise.all([
          inventoryCol.countDocuments(),
          ordersCol.countDocuments(),
        ]);
        return ok(res, {
          status: "healthy",
          database: "paystationdemo",
          connected: true,
          inventoryCount: invCount,
          ordersCount: ordCount,
          catalogUrl: CATALOG_URL,
          timestamp: new Date().toISOString(),
        });
      }

      // Fetch MongoDB inventory documents
      const inventoryDocs = await inventoryCol
        .find({})
        .sort({ productId: 1, typeId: 1, subProductId: 1 })
        .toArray();

      // Fetch public catalog from https://notun-rawgadz.vercel.app/products.json
      const { map: catalogMap, items: catalogItems, products: rawCatalogProducts } = await getPurchasableCatalogMap(req.query?.fresh === "true");

      // Build stockMap for quick lookup
      const stockMap = new Map();
      for (const doc of inventoryDocs) {
        const pId = String(doc.productId ?? "").trim();
        const tId = normalizeId(doc.typeId);
        const sId = normalizeId(doc.subProductId);
        stockMap.set(makeKey(pId, tId, sId), doc);
      }

      let inStockCount = 0;
      let lowStockCount = 0;
      let outOfStockCount = 0;
      let orphanedCount = 0;

      const mergedItems = inventoryDocs.map((doc) => {
        const pId = String(doc.productId ?? "").trim();
        const tId = normalizeId(doc.typeId);
        const sId = normalizeId(doc.subProductId);

        const key = makeKey(pId, tId, sId);
        const catalogInfo = catalogMap.get(key);

        const stock = typeof doc.stock === "number" ? Math.max(0, doc.stock) : 0;
        const status = getStockStatus(stock);

        if (status === "in_stock") inStockCount++;
        else if (status === "low_stock") lowStockCount++;
        else outOfStockCount++;

        const isOrphaned = !catalogInfo;
        if (isOrphaned) orphanedCount++;

        const slug = catalogInfo ? catalogInfo.slug : (doc.slug || "");
        const tab = catalogInfo ? catalogInfo.tab : (doc.tab || "");
        const storeBaseUrl = getStoreBaseUrl();
        const productUrl = slug ? `${storeBaseUrl}/product/${slug}` : "";

        return {
          _id: String(doc._id),
          key,
          productId: pId,
          typeId: tId,
          subProductId: sId,
          stock,
          status,
          orphaned: isOrphaned,
          unmatched: isOrphaned, // backward-compat helper
          productTitle: catalogInfo ? catalogInfo.productTitle : `Item (${pId})`,
          typeTitle: catalogInfo ? catalogInfo.typeTitle : (tId || null),
          subTitle: catalogInfo ? catalogInfo.subTitle : (sId || null),
          displayName: catalogInfo ? catalogInfo.displayName : `Item: ${pId} / ${tId || "default"}`,
          price: catalogInfo ? catalogInfo.price : 0,
          imageSrc: catalogInfo ? catalogInfo.imageSrc : "",
          tags: catalogInfo ? catalogInfo.tags : "",
          slug,
          tab,
          productUrl,
          createdAt: doc.createdAt || null,
          updatedAt: doc.updatedAt || doc.updated_at || doc.createdAt || null,
        };
      });

      // Build hierarchical nested structure
      const nestedProducts = buildNestedCatalog(rawCatalogProducts, stockMap);
      const orphanedItems = mergedItems.filter(i => i.orphaned);

      return ok(res, {
        connected: true,
        database: "paystationdemo",
        count: mergedItems.length,
        totalCatalogItems: catalogItems.length,
        summary: {
          total: mergedItems.length,
          inStock: inStockCount,
          lowStock: lowStockCount,
          outOfStock: outOfStockCount,
          orphaned: orphanedCount,
        },
        items: mergedItems,
        nestedProducts,
        orphanedItems,
      });
    } catch (err) {
      return serverError(res, err);
    }
  }

  // ==========================================
  // 2. POST: Sync OR Update Stock
  // ==========================================
  if (req.method === "POST" || req.method === "PATCH") {
    try {
      const body = await parseBody(req);
      const inventoryCol = await getInventoryCollection();

      // Check if this request is a synchronization request
      const isSync = body.action === "sync" || req.query?.action === "sync" || url.includes("/sync") || body.sync === true;

      // ----------------------------------------------------
      // A. "Update Inventory" Synchronization Logic
      // ----------------------------------------------------
      if (isSync) {
        // 1. Force fresh catalog fetch
        const { items: catalogItems } = await getPurchasableCatalogMap(true);

        if (!catalogItems || catalogItems.length === 0) {
          return res.status(500).json({
            success: false,
            error: "Unable to retrieve products catalog from public storefront.",
          });
        }

        // 2. Query existing inventory keys from MongoDB
        const existingDocs = await inventoryCol
          .find({}, { projection: { _id: 0, productId: 1, typeId: 1, subProductId: 1 } })
          .toArray();

        const existingKeySet = new Set(
          existingDocs.map((doc) => makeKey(doc.productId, doc.typeId, doc.subProductId))
        );

        const catalogKeySet = new Set(catalogItems.map((item) => item.key));

        // Missing items: in catalog but not yet in MongoDB
        const missingItems = catalogItems.filter((item) => !existingKeySet.has(item.key));

        // Orphaned items: in MongoDB but no longer in catalog
        const orphanedCount = existingDocs.filter(
          (doc) => !catalogKeySet.has(makeKey(doc.productId, doc.typeId, doc.subProductId))
        ).length;

        let insertedCount = 0;

        if (missingItems.length > 0) {
          // Create missing inventory records with stock: 0
          const now = new Date();
          const docsToInsert = missingItems.map((item) => ({
            productId: item.productId,
            typeId: item.typeId,
            subProductId: item.subProductId,
            stock: 0,
            createdAt: now,
            updatedAt: now,
          }));

          try {
            const insertResult = await inventoryCol.insertMany(docsToInsert, { ordered: false });
            insertedCount = insertResult.insertedCount;
          } catch (insertErr) {
            if (insertErr.insertedCount !== undefined) {
              insertedCount = insertErr.insertedCount;
            } else {
              throw insertErr;
            }
          }
        }

        const currentTotal = await inventoryCol.countDocuments();

        // Exact response contract per TRD specification:
        // Do not return both unmatchedCount and orphanedCount. Use only orphanedCount.
        return ok(res, {
          catalogCount: catalogItems.length,
          existingCount: existingDocs.length,
          addedCount: insertedCount,
          orphanedCount,
          totalInventoryCount: currentTotal,
          message: `Inventory synchronized: ${catalogItems.length} catalog items found, ${existingDocs.length} existing records, ${insertedCount} new record(s) added, ${orphanedCount} orphaned records.`,
          addedItems: missingItems.slice(0, 10).map((i) => ({
            productId: i.productId,
            typeId: i.typeId,
            subProductId: i.subProductId,
            displayName: i.displayName,
          })),
        });
      }

      // ----------------------------------------------------
      // B. Stock Mutation Rules (set, increase, decrease)
      // ----------------------------------------------------
      const { productId, typeId, subProductId, action } = body;

      if (!productId || typeof productId !== "string" || !productId.trim()) {
        return badRequest(res, "Missing or invalid 'productId' in request body.");
      }

      const cleanProductId = String(productId).trim();
      const cleanTypeId = normalizeId(typeId);
      const cleanSubProductId = normalizeId(subProductId);

      const filter = {
        productId: cleanProductId,
        typeId: cleanTypeId,
        subProductId: cleanSubProductId,
      };

      const existingDoc = await inventoryCol.findOne(filter);
      const currentStock = existingDoc && typeof existingDoc.stock === "number" ? Math.max(0, existingDoc.stock) : 0;
      let newStock = currentStock;

      if (action === "set") {
        const target = parseInt(body.value !== undefined ? body.value : body.stock, 10);
        if (isNaN(target) || target < 0) {
          return badRequest(res, "Invalid 'value' provided for action 'set'. Must be a non-negative integer (>= 0).");
        }
        newStock = target;
      } else if (action === "increase") {
        const delta = parseInt(body.value !== undefined ? body.value : (body.delta || 1), 10);
        if (isNaN(delta) || delta <= 0) {
          return badRequest(res, "Invalid increase delta. Must be a positive integer.");
        }
        newStock = currentStock + delta;
      } else if (action === "decrease") {
        const delta = parseInt(body.value !== undefined ? body.value : (body.delta || 1), 10);
        if (isNaN(delta) || delta <= 0) {
          return badRequest(res, "Invalid decrease delta. Must be a positive integer.");
        }
        if (currentStock - delta < 0) {
          return res.status(400).json({
            success: false,
            error: "INSUFFICIENT_STOCK",
            message: "Requested decrease exceeds current stock. Stock cannot become negative."
          });
        }
        newStock = currentStock - delta;
      } else {
        return badRequest(res, "Invalid or missing action. Supported actions: 'set', 'increase', 'decrease', 'sync'.");
      }

      // Enforce stock invariant: integer >= 0
      if (newStock < 0) newStock = 0;

      const now = new Date();
      const updateResult = await inventoryCol.findOneAndUpdate(
        filter,
        {
          $set: {
            stock: newStock,
            updatedAt: now,
          },
          $setOnInsert: {
            productId: cleanProductId,
            typeId: cleanTypeId,
            subProductId: cleanSubProductId,
            createdAt: now,
          },
        },
        { upsert: true, returnDocument: "after" }
      );

      const updatedDoc = updateResult && (updateResult.value !== undefined ? updateResult.value : updateResult);

      return ok(res, {
        productId: cleanProductId,
        typeId: cleanTypeId,
        subProductId: cleanSubProductId,
        stock: newStock,
        previousStock: currentStock,
        action,
        updatedAt: now,
        inventory: updatedDoc,
      });
    } catch (err) {
      return serverError(res, err);
    }
  }

  return res.status(405).json({ success: false, error: "Method not allowed. Use GET, POST, or PATCH." });
};
