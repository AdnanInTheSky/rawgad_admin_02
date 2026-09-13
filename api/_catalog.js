// api/_catalog.js
// Fetches & parses the product catalog from https://lit-alpha-five.vercel.app/products.json
// Single source of truth for product information (names, images, prices, types, subProducts)

const fs = require("fs");
const path = require("path");

const CATALOG_URL = "https://lit-alpha-five.vercel.app/products.json";

let cachedCatalog = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 15000; // 15 seconds memory cache

/**
 * Creates a normalized composite lookup key for inventory items:
 * productId:::typeId:::subProductId (where null is string 'null')
 */
function makeKey(productId, typeId, subProductId) {
  const p = String(productId ?? "").trim();
  const t = (typeId === null || typeId === undefined || typeId === "null" || typeId === "") ? "null" : String(typeId).trim();
  const s = (subProductId === null || subProductId === undefined || subProductId === "null" || subProductId === "") ? "null" : String(subProductId).trim();
  return `${p}:::${t}:::${s}`;
}

/**
 * Normalizes an ID value to null if empty/null
 */
function normalizeId(val) {
  if (val === null || val === undefined || val === "null" || val === "") return null;
  return String(val).trim();
}

/**
 * Fetches the raw products array from the public URL, with local fallback if offline.
 * @param {boolean} forceFresh - bypass cache if true
 */
async function fetchRawProducts(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedCatalog && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedCatalog;
  }

  try {
    const controller = new AbortController();
    const fetchOptions = {
      signal: controller.signal,
      headers: {
        "User-Agent": "Rawgad-Admin-CMS/1.0",
        "Accept": "application/json",
        ...(forceFresh ? { "Cache-Control": "no-cache, no-store, must-revalidate" } : {})
      },
      ...(forceFresh ? { cache: "no-store" } : {})
    };
    const fetchUrl = forceFresh ? `${CATALOG_URL}?_t=${now}` : CATALOG_URL;
    const res = await fetch(fetchUrl, fetchOptions);

    if (!res.ok) {
      throw new Error(`Failed to fetch catalog: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (Array.isArray(data)) {
      cachedCatalog = data;
      lastFetchTime = now;
      return data;
    }
  } catch (err) {
    console.warn("[_catalog.js] Failed fetching remote products.json:", err.message);
  }

  // Fallback 1: Return stale cache if available
  if (cachedCatalog) {
    return cachedCatalog;
  }

  // Fallback 2: Check local fallback files if available
  const localCandidates = [
    path.join(__dirname, "products.json"),
    path.join(process.cwd(), "products.json"),
    path.join(process.cwd(), "..", "final_public", "products.json")
  ];

  for (const candidate of localCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          console.log(`[_catalog.js] Loaded fallback catalog from ${candidate}`);
          cachedCatalog = parsed;
          lastFetchTime = now;
          return parsed;
        }
      }
    } catch (_) {}
  }

  return [];
}

/**
 * Transforms products.json into an array of purchasable items based on rules:
 * Rule 1: Type has subProducts -> Each subProduct is a separate item
 *         productId = product.id
 *         typeId = type.subProductId
 *         subProductId = subProduct.subProductId
 * Rule 2: Type has no subProducts -> The type itself is the purchasable item
 *         productId = product.id
 *         typeId = type.subProductId
 *         subProductId = null
 * Rule 3: Product has no types -> The product itself is the purchasable item
 *         productId = product.id
 *         typeId = null
 *         subProductId = null
 */
function extractPurchasableItems(products) {
  const items = [];
  if (!Array.isArray(products)) return items;

  for (const product of products) {
    const productId = String(product.id ?? "").trim();
    if (!productId) continue;

    const types = Array.isArray(product.types) ? product.types : [];

    if (types.length === 0) {
      // Product with no types
      items.push({
        productId,
        typeId: null,
        subProductId: null,
        key: makeKey(productId, null, null),
        productTitle: product.title || "Untitled Product",
        typeTitle: null,
        subTitle: null,
        displayName: product.title || "Untitled Product",
        price: Number(product.price) || 0,
        imageSrc: product.imageSrc || "",
        tags: product.tags || "",
      });
      continue;
    }

    for (const type of types) {
      const typeId = String(type.subProductId || type.id || "").trim();
      const subProducts = Array.isArray(type.subProducts) ? type.subProducts : [];

      if (subProducts.length > 0) {
        // Type has nested subProducts: each subProduct is a separate inventory item
        for (const sub of subProducts) {
          const subProductId = String(sub.subProductId || sub.id || "").trim();
          const itemPrice = typeof sub.price === "number" ? sub.price : (typeof type.price === "number" ? type.price : Number(product.price) || 0);
          const itemImage = sub.subImage || type.subImage || product.imageSrc || "";

          items.push({
            productId,
            typeId,
            subProductId,
            key: makeKey(productId, typeId, subProductId),
            productTitle: product.title || "Untitled Product",
            typeTitle: type.subTitle || "Default Type",
            subTitle: sub.subTitle || "Default Subproduct",
            displayName: `${product.title} - ${type.subTitle || "Type"} (${sub.subTitle || "Option"})`,
            price: itemPrice,
            imageSrc: itemImage,
            tags: product.tags || "",
          });
        }
      } else {
        // Type has NO nested subProducts: the type itself is the purchasable item
        const itemPrice = typeof type.price === "number" ? type.price : Number(product.price) || 0;
        const itemImage = type.subImage || product.imageSrc || "";

        items.push({
          productId,
          typeId,
          subProductId: null,
          key: makeKey(productId, typeId, null),
          productTitle: product.title || "Untitled Product",
          typeTitle: type.subTitle || "Default Type",
          subTitle: null,
          displayName: `${product.title} - ${type.subTitle || "Type"}`,
          price: itemPrice,
          imageSrc: itemImage,
          tags: product.tags || "",
        });
      }
    }
  }

  return items;
}

/**
 * Returns a Map of all purchasable items keyed by makeKey(p, t, s)
 */
async function getPurchasableCatalogMap(forceFresh = false) {
  const products = await fetchRawProducts(forceFresh);
  const items = extractPurchasableItems(products);
  const map = new Map();
  for (const item of items) {
    map.set(item.key, item);
  }
  return { map, items, products };
}

module.exports = {
  CATALOG_URL,
  makeKey,
  normalizeId,
  fetchRawProducts,
  extractPurchasableItems,
  getPurchasableCatalogMap,
};
