// backend/routes/analyze.js
const express = require("express");
const router = express.Router();
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const AmazonRow = require("../models/AmazonRow");
const Master = require("../models/Master");
const AnalysisResult = require("../models/AnalysisResult");

// robust number parse
const safeNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// helper: find field by many candidate names (case-insensitive)
function getField(obj = {}, candidates = []) {
  if (!obj || typeof obj !== "object") return undefined;
  const keys = Object.keys(obj);
  for (const c of candidates) {
    const want = String(c).toLowerCase().trim();
    const found = keys.find(k => String(k).toLowerCase().trim() === want);
    if (found) return obj[found];
  }
  return undefined;
}

// extract SKU from free text as fallback (basic regex)
function extractSKUFromText(text) {
  if (!text) return "";
  const m = String(text).match(/[A-Z0-9\-\_]{3,}/g);
  return m ? m[0] : "";
}


function runAnalysis(rawRows = [], masterRows = []) {
  // build master map: sku -> { name, cog, raw }
  const masterMap = {};
  (masterRows || []).forEach(m => {
    const raw = m.raw || m;
    const sku =
      (m.sku || m.SellerSKU || raw["Seller SKU"] || raw.sku || raw.SKU || "")
        .toString()
        .trim();
    if (!sku) return;
    const name =
      m.name ||
      raw["Product Name"] ||
      raw["Product"] ||
      raw.ProductName ||
      raw.product ||
      "";
    const cog = safeNum(
      m.cog ||
        m.COGS ||
        raw.COGS ||
        raw.COG ||
        raw.Cost ||
        raw.cost ||
        0
    );
    masterMap[sku] = { name, cog, raw };
  });

  // normalize raw rows
  const processed = (rawRows || []).map(r => {
    const raw = r.raw || r;

    const amount =
      safeNum(
        getField(raw, [
          "amount",
          "total-amount",
          "total_amount",
          "Amount",
        ]) || raw.amount
      ) || 0;

    // Quantity detection: prefer quantity-purchased or qty or quantity
    let qty = 0;
    const qtyFields = [
      "quantity-purchased",
      "quantity purchased",
      "quantity_purchased",
      "qty",
      "quantity",
      "Quantity",
    ];
    for (const c of qtyFields) {
      const val = getField(raw, [c]) || raw[c];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        qty = safeNum(val);
        break;
      }
    }

    const skuFields = [
      "sku",
      "skus",
      "seller sku",
      "seller-sku",
      "seller_sku",
      "Seller SKU",
      "SellerSKU",
      "SKU",
    ];
    let skuRaw = getField(raw, skuFields) || raw.sku || raw.SKU || raw.SellerSKU || "";
    skuRaw = skuRaw ? String(skuRaw).trim() : "";
    const amountDesc =
      getField(raw, ["amount-description", "description", "item description"]) ||
      raw.description ||
      "";
    const sku = skuRaw || extractSKUFromText(amountDesc) || "";

    // order id detection
    const orderIdFields = [
      "merchant-order-id",
      "merchant order id",
      "merchantorderid",
      "order-id",
      "order id",
      "orderid",
      "order_id",
      "orderId",
    ];
    let orderId = "";
    for (const c of orderIdFields) {
      const v = getField(raw, [c]) || raw[c];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        orderId = String(v).trim();
        break;
      }
    }
    orderId = orderId || r.order_id || r["order-id"] || "UNKNOWN";

    const posted_date =
      getField(raw, ["posted-date", "posted date"]) || raw.posted_date || "";
    const posted_date_time =
      getField(raw, ["posted-date-time", "posted date time"]) ||
      raw.posted_date_time ||
      "";

    const transaction_type =
      getField(raw, ["transaction-type", "transaction type"]) ||
      raw.transaction_type ||
      raw.type ||
      "";

    const mm = masterMap[sku] || { name: "", cog: 0 };

    return {
      raw,
      order_id: orderId,
      sku,
      amount,
      quantity: safeNum(qty),
      posted_date,
      posted_date_time,
      transaction_type: (transaction_type || "").toString(),
      product_name_master: mm.name,
      master_cog: mm.cog
    };
  });

  // group by order_id
  const groups = {};
  processed.forEach(p => {
    const key = p.order_id || "UNKNOWN";
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  // classify order type (like Python logic)
  function classifyType(rows) {
    const types = new Set(rows.map(x => (x.transaction_type || "").toString().trim()).filter(Boolean));
    for (const t of types) if (t.includes("Refund")) return "Refund";
    for (const t of types) if (t.includes("Order")) return "Order";
    if (types.size === 0) return "Order";
    return Array.from(types).sort().join(",");
  }

  // min/posting date for an order (prefer any posted_date/post_date_time)
  function minDate(rows) {
    const arr = [];
    rows.forEach(r => {
      if (r.posted_date) arr.push(new Date(r.posted_date));
      else if (r.posted_date_time) arr.push(new Date(r.posted_date_time));
    });
    const valid = arr.filter(d => !isNaN(d));
    if (!valid.length) return "";
    return new Date(Math.min(...valid)).toISOString();
  }

  // Build per-order unique sku qty map (use max, prefer non-zero)
  const perOrderSkuQty = {};
  Object.keys(groups).forEach(orderId => {
    const rows = groups[orderId];
    const skuMap = {};
    rows.forEach(r => {
      const s = (r.sku || "").toString().trim();
      if (!s) return;
      const q = safeNum(r.quantity);
      if (!skuMap[s] || safeNum(skuMap[s]) < q) skuMap[s] = q;
    });
    perOrderSkuQty[orderId] = skuMap;
  });

  // Build orders_summary
  const orders_summary = Object.keys(groups).map(orderId => {
    const rows = groups[orderId];
    const skuQtyMap = perOrderSkuQty[orderId] || {};

    // total_amount: sum of amounts in group
    const total_amount = rows.reduce((s, r) => s + safeNum(r.amount), 0);

    // total_quantity: sum of unique sku quantities (not summing duplicate item lines)
    const total_quantity = Object.values(skuQtyMap).reduce((s, q) => s + safeNum(q), 0);

    // order_COG: sum(master_cog * unique_qty)
    let order_COG = 0;
    Object.keys(skuQtyMap).forEach(sku => {
      const m = masterMap[sku] || { cog: 0 };
      order_COG += safeNum(m.cog) * safeNum(skuQtyMap[sku]);
    });

    // final amount
    const final_amount = total_amount - order_COG;

    // distinct SKUs in order
    const distinctSkus = Array.from(new Set(rows.map(r => (r.sku || "").toString().trim()).filter(Boolean)));

    // product names and sku:name pairs
    const product_names_arr = distinctSkus.map(s => (masterMap[s] ? masterMap[s].name : "")).filter(Boolean);
    const sku_name_pairs_arr = distinctSkus.map(s => `${s}:${masterMap[s] ? masterMap[s].name : ""}`);

    // num_skus_missing_cog: count of SKUs where masterMap cog missing or zero
    const num_missing = distinctSkus.reduce((acc, s) => {
      const m = masterMap[s];
      return acc + ((!m || !safeNum(m.cog)) ? 1 : 0);
    }, 0);

    return {
      date: minDate(rows),
      "order-id": orderId,
      type: classifyType(rows),
      skus: distinctSkus.join(", "),
      total_quantity,
      total_amount,
      order_COG,
      final_amount,
      num_skus_missing_cog: num_missing,
      product_names: product_names_arr.join(", "),
      sku_name_pairs: sku_name_pairs_arr.join(", ")
    };
  });

  // Build order_unique_skus using perOrderSkuQty (unique qty)
  const order_unique_skus = [];
  Object.keys(perOrderSkuQty).forEach(orderId => {
    const skuQty = perOrderSkuQty[orderId];
    Object.keys(skuQty).forEach(sku => {
      const qty = safeNum(skuQty[sku]);
      const mm = masterMap[sku] || { name: "", cog: 0 };
      const cog = safeNum(mm.cog);
      order_unique_skus.push({
        "order-id": orderId,
        sku,
        sku_quantity_in_order: qty,
        "Seller SKU": sku,
        COGS: cog,
        COGS_missing: !(cog > 0),
        Total_COGS: cog * qty
      });
    });
  });

  // raw_concat (normalized)
  const raw_concat = processed.map(p => ({
    "order-id": p.order_id,
    sku: p.sku,
    quantity: p.quantity,
    amount: p.amount,
    posted_date: p.posted_date,
    posted_date_time: p.posted_date_time,
    transaction_type: p.transaction_type,
    product_name_master: p.product_name_master,
    master_cog: p.master_cog,
    raw: p.raw
  }));

  // sku_map (from master)
  const sku_map = Object.keys(masterMap).map(sku => ({
    "Seller SKU": sku,
    "Product Name": masterMap[sku].name,
    "COGS": safeNum(masterMap[sku].cog)
  }));

  // sku_map_reference: same as sku_map (for Python parity)
  const sku_map_reference = sku_map.map(r => ({ ...r }));

  // negative orders (final_amount < 0 and type == "Order")
  const negative_orders = orders_summary.filter(o => safeNum(o.final_amount) < 0 && o.type === "Order");

  // missing_cog_orders (sku-level rows where cog missing)
  const missing_cog_orders = order_unique_skus.filter(r => !!r.COGS_missing);

  // --- NEW: no_orders_this_week
  // Determine which master SKUs do NOT appear in settlement (raw_concat)
  const settlementSkusSet = new Set(
    raw_concat
      .map(r => (r.sku || "").toString().trim())
      .filter(Boolean)
  );

  // Compute last order date per SKU present in settlement
  const lastOrderDateBySku = {};
  raw_concat.forEach(r => {
    const s = (r.sku || "").toString().trim();
    if (!s) return;
    // prefer posted_date_time then posted_date; normalize to ISO if possible
    const dt = r.posted_date_time || r.posted_date || null;
    if (!dt) return;
    const dd = new Date(dt);
    if (isNaN(dd)) return;
    const t = dd.toISOString();
    if (!lastOrderDateBySku[s] || new Date(lastOrderDateBySku[s]) < new Date(t)) {
      lastOrderDateBySku[s] = t;
    }
  });

  // Build no_orders_this_week by iterating masterMap keys
  const no_orders_this_week = [];
  Object.keys(masterMap).forEach(sku => {
    if (!settlementSkusSet.has(sku)) {
      const m = masterMap[sku];
      no_orders_this_week.push({
        sku,
        product_name: m.name || "",
        COGS: safeNum(m.cog),
        last_order_date: lastOrderDateBySku[sku] || null,
        reason: "never ordered (in this file)"
      });
    }
  });

  // no_orders_summary
  const no_orders_summary = [{
    total_master_skus: Object.keys(masterMap).length,
    skus_with_no_orders_in_file: no_orders_this_week.length,
    percent_inactive: Math.round((no_orders_this_week.length / Math.max(1, Object.keys(masterMap).length)) * 100 * 100) / 100 // 2 decimals
  }];

  // totals
  const totals = {
    totalSales: orders_summary.reduce((s, o) => s + safeNum(o.total_amount), 0),
    totalCogs: orders_summary.reduce((s, o) => s + safeNum(o.order_COG), 0),
    totalProfit: orders_summary.reduce((s, o) => s + safeNum(o.final_amount), 0),
    totalOrders: orders_summary.length
  };

  return {
    sheets: {
      order_summery: orders_summary,
      order_unique_skus,
      raw_concat,
      sku_map,
      negative_orders,
      missing_cog_orders,
      sku_map_reference,
      no_orders_this_week,
      no_orders_summary
    },
    totals
  };
}

/* ROUTE: analyze by uploadId (reads AmazonRow docs) */
router.get("/:uploadId", async (req, res) => {
  try {
    const uploadIdRaw = req.params.uploadId;
    const uploadId = uploadIdRaw ? String(uploadIdRaw).trim() : null;
    if (!uploadId) return res.status(400).send("uploadId missing in URL");

    // try find amazon rows (string or ObjectId)
    let rawRows = await AmazonRow.find({ upload_id: uploadId }).lean();
    if (!rawRows || !rawRows.length) {
      try {
        rawRows = await AmazonRow.find({ upload_id: new mongoose.Types.ObjectId(uploadId) }).lean();
      } catch(_) {
        rawRows = [];
      }
    }

    if (!rawRows || !rawRows.length) {
      return res.status(400).send("No amazon rows found for this uploadId");
    }

    const masterRows = await Master.find().lean();

    // run analysis
    const result = runAnalysis(rawRows, masterRows);

    // SAVE ANALYSIS RESULT (DB)
    const saved = await AnalysisResult.findOneAndUpdate(
      { uploadId },
      {
        uploadId,
        filename: "",
        totals: result.totals,
        sheets: {
          order_summery: result.sheets.order_summery || [],
          order_unique_skus: result.sheets.order_unique_skus || [],
          raw_concat: result.sheets.raw_concat || [],
          sku_map: result.sheets.sku_map || [],
          negative_orders: result.sheets.negative_orders || [],
          missing_cog_orders: result.sheets.missing_cog_orders || [],
          sku_map_reference: result.sheets.sku_map_reference || [],
          no_orders_this_week: result.sheets.no_orders_this_week || [],
          no_orders_summary: result.sheets.no_orders_summary || []
        }
      },
      { upsert: true, new: true }
    );

    // PREPARE EXCEL OUTPUT
    const wb = XLSX.utils.book_new();
    function addSheet(name, arr) {
      const ws = XLSX.utils.json_to_sheet(
        Array.isArray(arr) && arr.length ? arr : [{ message: "No data" }]
      );
      XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
    }

    addSheet("order_summery", result.sheets.order_summery);
    addSheet("order_unique_skus", result.sheets.order_unique_skus);
    addSheet("raw_concat", result.sheets.raw_concat);
    addSheet("sku_map", result.sheets.sku_map);
    addSheet("negative_orders", result.sheets.negative_orders);
    addSheet("missing_cog_orders", result.sheets.missing_cog_orders);
    addSheet("sku_map_reference", result.sheets.sku_map_reference);
    addSheet("no_orders_this_week", result.sheets.no_orders_this_week);
    addSheet("no_orders_summary", result.sheets.no_orders_summary);

    // CREATE OUTPUT DIRECTORY
    const outDir = path.join(__dirname, "../processed");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // CREATE A CLEAN OUTPUT FILENAME BASED ON ORIGINAL UPLOADED FILE (short name)
    let originalName = "";
    if (rawRows?.length) {
      originalName =
        rawRows[0]?.original_filename ||
        rawRows[0]?.filename ||
        rawRows[0]?.raw?.originalname ||
        rawRows[0]?.raw?.filename ||
        "";
    }
    if (!originalName) originalName = "amazon_file.xlsx";
    const baseName = originalName.split(".")[0];
    const outName = `${baseName}_analyzed.xlsx`;
    const outPath = path.join(outDir, outName);

    // WRITE AND SAVE
    XLSX.writeFile(wb, outPath);

    saved.filename = outName;
    await saved.save();

    // DOWNLOAD then cleanup
    res.download(outPath, outName, err => {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch (e) { console.error("cleanup err", e); }

      if (err) console.error("download err", err);
    });

  } catch (err) {
    console.error("analyze route error:", err);
    res.status(500).send("Analyze failed: " + (err.message || err));
  }
});

module.exports = router;
