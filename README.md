# Rawgad Admin CMS — Inventory & Orders Management

Production-ready Admin CMS for **Rawgad**, built with **HTML + Alpine.js + Tailwind CSS** on the frontend, powered by **Vercel Serverless Functions** and connected to **MongoDB Atlas**.

---

## 1. Core Architecture & Single Source of Truth

```
               PUBLIC SITE
                    |
                    | fetch
                    v
             products.json (https://lit-alpha-five.vercel.app/products.json)
                    |
             Product Catalog Source (Names, Images, Prices, Types, SubProducts)
                    |
                    +-----------------------+
                                            |
                                            v
                                     MongoDB Atlas (paystationdemo)
                                     ├── inventory  (Authoritative Stock)
                                     └── orders     (Customer Orders Ledger)
                                            ^
                                            |
                           +----------------+----------------+
                           |                                 |
                    /api/inventory                    /api/orders
                           |                                 |
                           +----------------+----------------+
                                            |
                                            v
                                     ADMIN CMS (UI)
```

- **Product Information Source**: `https://lit-alpha-five.vercel.app/products.json`
- **Inventory Stock Source**: MongoDB Atlas (`paystationdemo.inventory`)
- **Order Source**: MongoDB Atlas (`paystationdemo.orders`)
- **Secrets Management**: Kept exclusively in server-side environment variables (`MONGO_URI`). Browser never communicates directly with MongoDB.

---

## 2. Purchasable Item Identity & Structure

Every purchasable item is represented by a unique composite key:
$$\text{productId} + \text{typeId} + \text{subProductId}$$

### Purchasable Item Rules:
1. **Type has `subProducts`**:
   - Each `subProduct` is an individual inventory item.
   - `productId = product.id`
   - `typeId = type.subProductId`
   - `subProductId = subProduct.subProductId`
2. **Type has no `subProducts`**:
   - The `type` itself is the purchasable item.
   - `productId = product.id`
   - `typeId = type.subProductId`
   - `subProductId = null`
3. **Compound Unique Index**:
   ```javascript
   { "productId": 1, "typeId": 1, "subProductId": 1 } // unique: true
   ```

---

## 3. Consolidated Serverless API Endpoints

The architecture has been unified into **2 clean RESTful Vercel Serverless Functions** without removing any features or altering the database schema:

| Endpoint | Method | Action / Query | Purpose |
| :--- | :---: | :--- | :--- |
| **`/api/inventory`** | `GET` | *(default)* | Returns authoritative MongoDB stock merged with live public catalog metadata & health status. |
| **`/api/inventory`** | `GET` | `?status=true` | Quick diagnostic check (MongoDB connection, cluster database name, collection counts). |
| **`/api/inventory`** | `POST` | `{ action: "sync" }` | **Update Inventory**: Fetches `products.json`, detects missing purchasable items, inserts them with `stock: 0` without altering existing records. |
| **`/api/inventory`** | `POST` | `{ action: "set" \| "increase" \| "decrease", productId, typeId, subProductId, value }` | **Stock Management**: Sets or adjusts physical stock. Enforces stock $\ge 0$ and updates `updatedAt`. |
| **`/api/orders`** | `GET` | *(default)* | Lists all orders from `paystationdemo.orders` with customer details, enriched inventory item names/IDs, and TrxIDs. |
| **`/api/orders`** | `POST` | `{ invoice_number, status }` | Updates order fulfillment lifecycle status (`pending`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`). |

---

## 4. Running the Admin CMS

### Local Development
```bash
# 1. Install dependencies
npm install

# 2. Start local server
npm start
# Server listens on http://localhost:3001
```

### Vercel Deployment
Deploy directly to Vercel:
```bash
vercel --prod
```
Set the following environment variable in Vercel Project Settings:
- `MONGO_URI`: `mongodb+srv://<username>:<password>@cluster0.bd9ywas.mongodb.net/?retryWrites=true&w=majority`
