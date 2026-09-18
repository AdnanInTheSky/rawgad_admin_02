// api/_catalog.js
// Fetches & parses the live product catalog from remote CATALOG_URL
// Single source of truth for product information (names, images, prices, types, subProducts)

const CATALOG_URL = process.env.CATALOG_URL || "https://notun-rawgadz.vercel.app/products.json";

function getStoreBaseUrl() {
  try {
    return new URL(CATALOG_URL).origin;
  } catch (_) {
    return "https://notun-rawgadz.vercel.app";
  }
}

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
 * Fetches the live raw products array directly from the remote URL.
 * Real, live data with no local file fallbacks.
 * @param {boolean} forceFresh - bypass cache if true
 */
async function fetchRawProducts(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedCatalog && (now - lastFetchTime < CACHE_TTL_MS)) {
    return cachedCatalog;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
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
      throw new Error(`Failed to fetch live catalog from ${CATALOG_URL}: HTTP ${res.status}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error(`Invalid catalog data received from ${CATALOG_URL}: expected array of products`);
    }

    cachedCatalog = data;
    lastFetchTime = now;
    return data;
  } catch (err) {
    if (cachedCatalog) {
      console.warn("[_catalog.js] Live fetch failed, using active in-memory cache:", err.message);
      return cachedCatalog;
    }
    throw new Error(`Unable to fetch live catalog from ${CATALOG_URL}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
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
function getStockStatus(stock) {
  if (typeof stock !== "number" || stock <= 0) return "out_of_stock";
  if (stock <= 5) return "low_stock";
  return "in_stock";
}

function extractPurchasableItems(products) {
  const items = [];
  if (!Array.isArray(products)) return items;
  const storeBaseUrl = getStoreBaseUrl();

  for (const product of products) {
    const productId = String(product.id ?? "").trim();
    if (!productId) continue;

    const slug = String(product.slug || "").trim();
    const tab = String(product.tab || "").trim();
    const productUrl = slug ? `${storeBaseUrl}/product/${slug}` : "";

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
        slug,
        tab,
        productUrl,
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
            slug,
            tab,
            productUrl,
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
          slug,
          tab,
          productUrl,
        });
      }
    }
  }

  return items;
}

/**
 * Builds a hierarchical nested representation of the products catalog with live stock information.
 * Each part (subProduct, type, or standalone product) maintains its own separate stock.
 * Aggregates are computed for parent types and products.
 *
 * @param {Array} products - Raw products from products.json
 * @param {Map} stockMap - Map of key (makeKey) -> { stock, updatedAt, createdAt }
 */
function buildNestedCatalog(products, stockMap = new Map()) {
  if (!Array.isArray(products)) return [];
  const storeBaseUrl = getStoreBaseUrl();

  return products.map((product) => {
    const productId = String(product.id ?? "").trim();
    const slug = String(product.slug || "").trim();
    const tab = String(product.tab || "").trim();
    const productUrl = slug ? `${storeBaseUrl}/product/${slug}` : "";
    const types = Array.isArray(product.types) ? product.types : [];

    if (types.length === 0) {
      // Standalone product (no types/variants): the product itself is the stockable item
      const key = makeKey(productId, null, null);
      const stockDoc = stockMap.get(key);
      const stock = stockDoc && typeof stockDoc.stock === "number" ? Math.max(0, stockDoc.stock) : 0;
      const status = getStockStatus(stock);

      return {
        key,
        productId,
        typeId: null,
        subProductId: null,
        title: product.title || "Untitled Product",
        productTitle: product.title || "Untitled Product",
        slug,
        tab,
        productUrl,
        imageSrc: product.imageSrc || "",
        description: product.description || "",
        price: Number(product.price) || 0,
        tags: product.tags || "",
        hasTypes: false,
        hasSubProducts: false,
        totalVariants: 0,
        stock,
        totalStock: stock,
        status,
        updatedAt: stockDoc ? (stockDoc.updatedAt || stockDoc.updated_at || stockDoc.createdAt) : null,
        types: [],
      };
    }

    // Product has nested types
    let productTotalStock = 0;
    let totalVariants = 0;

    const mappedTypes = types.map((type) => {
      const typeId = String(type.subProductId || type.id || "").trim();
      const subProducts = Array.isArray(type.subProducts) ? type.subProducts : [];
      let typeTotalStock = 0;

      if (subProducts.length > 0) {
        // Type has nested subProducts: each subProduct has its OWN separate stock
        const mappedSubs = subProducts.map((sub) => {
          totalVariants++;
          const subProductId = String(sub.subProductId || sub.id || "").trim();
          const key = makeKey(productId, typeId, subProductId);
          const stockDoc = stockMap.get(key);
          const stock = stockDoc && typeof stockDoc.stock === "number" ? Math.max(0, stockDoc.stock) : 0;
          typeTotalStock += stock;
          const status = getStockStatus(stock);

          const itemPrice = typeof sub.price === "number" ? sub.price : (typeof type.price === "number" ? type.price : Number(product.price) || 0);
          const itemImage = sub.subImage || type.subImage || product.imageSrc || "";

          return {
            key,
            productId,
            typeId,
            subProductId,
            title: sub.subTitle || "Default Subproduct",
            subTitle: sub.subTitle || "Default Subproduct",
            typeTitle: type.subTitle || "Default Type",
            productTitle: product.title || "Untitled Product",
            displayName: `${product.title} - ${type.subTitle || "Type"} (${sub.subTitle || "Option"})`,
            price: itemPrice,
            imageSrc: itemImage,
            stock, // SEPARATE STOCK FOR THIS SUBPRODUCT
            status,
            slug,
            tab,
            productUrl,
            updatedAt: stockDoc ? (stockDoc.updatedAt || stockDoc.updated_at || stockDoc.createdAt) : null,
          };
        });

        productTotalStock += typeTotalStock;

        return {
          typeId,
          title: type.subTitle || "Default Type",
          typeTitle: type.subTitle || "Default Type",
          productTitle: product.title || "Untitled Product",
          price: typeof type.price === "number" ? type.price : Number(product.price) || 0,
          imageSrc: type.subImage || product.imageSrc || "",
          hasSubProducts: true,
          totalVariants: mappedSubs.length,
          totalStock: typeTotalStock,
          status: getStockStatus(typeTotalStock),
          subProducts: mappedSubs,
        };
      } else {
        // Type has NO nested subProducts: the type itself has its OWN separate stock
        totalVariants++;
        const key = makeKey(productId, typeId, null);
        const stockDoc = stockMap.get(key);
        const stock = stockDoc && typeof stockDoc.stock === "number" ? Math.max(0, stockDoc.stock) : 0;
        typeTotalStock += stock;
        productTotalStock += stock;
        const status = getStockStatus(stock);

        const itemPrice = typeof type.price === "number" ? type.price : Number(product.price) || 0;
        const itemImage = type.subImage || product.imageSrc || "";

        return {
          key,
          productId,
          typeId,
          subProductId: null,
          title: type.subTitle || "Default Type",
          typeTitle: type.subTitle || "Default Type",
          productTitle: product.title || "Untitled Product",
          displayName: `${product.title} - ${type.subTitle || "Type"}`,
          price: itemPrice,
          imageSrc: itemImage,
          hasSubProducts: false,
          totalVariants: 1,
          stock, // SEPARATE STOCK FOR THIS TYPE
          totalStock: stock,
          status,
          slug,
          tab,
          productUrl,
          updatedAt: stockDoc ? (stockDoc.updatedAt || stockDoc.updated_at || stockDoc.createdAt) : null,
          subProducts: [],
        };
      }
    });

    return {
      productId,
      title: product.title || "Untitled Product",
      productTitle: product.title || "Untitled Product",
      slug,
      tab,
      productUrl,
      imageSrc: product.imageSrc || "",
      description: product.description || "",
      price: Number(product.price) || 0,
      tags: product.tags || "",
      hasTypes: true,
      hasSubProducts: mappedTypes.some((t) => t.hasSubProducts),
      totalVariants,
      totalStock: productTotalStock,
      status: getStockStatus(productTotalStock),
      types: mappedTypes,
    };
  });
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
  getStoreBaseUrl,
  makeKey,
  normalizeId,
  getStockStatus,
  fetchRawProducts,
  extractPurchasableItems,
  buildNestedCatalog,
  getPurchasableCatalogMap,
};
