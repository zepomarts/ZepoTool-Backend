const express = require("express");
const router = express.Router();
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");

const FlipkartRow = require("../models/FlipkartRow");
const Master = require("../models/FlipkartMaster");
const AnalysisResult = require("../models/FlipkartAnalysisResult");

/* ---------------- COMMON HELPERS (same as Amazon) ---------------- */

const safeNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function getField(obj = {}, candidates = []) {
  const keys = Object.keys(obj || {});
  for (const c of candidates) {
    const found = keys.find(k => k.toLowerCase().trim() === c.toLowerCase().trim());
    if (found) return obj[found];
  }
  return undefined;
}

function extractSKU(text) {
  if (!text) return "";
  const m = String(text).match(/[A-Z0-9\-\_]{3,}/g);
  return m ? m[0] : "";
}

/* ---------------- ANALYSIS ENGINE (Same As Amazon) ---------------- */

function runAnalysis(rawRows = [], masterRows = []) {

  /* ---- 1. Master Map ---- */
  const masterMap = {};
  masterRows.forEach(m => {
    const raw = m.raw || m;

    const sku =
      m.sku ||
      raw["Seller SKU"] ||
      raw["sku"] ||
      raw["SKU"] ||
      "";
    if (!sku) return;

    const name =
      m.name ||
      raw["Product Name"] ||
      raw["Product"] ||
      "";

    const cog = safeNum(
      m.cog ||
      raw.COGS ||
      raw.Cost ||
      raw.cost ||
      0
    );

    masterMap[String(sku).trim()] = { name, cog, raw };
  });

  /* ---- 2. Normalize Flipkart rows (Same logic format as Amazon) ---- */

  const processed = rawRows.map(r => {
    const raw = r.raw || r;

    const amount =
      safeNum(
        getField(raw, ["total amount", "total_amount", "amount"]) ||
        raw.amount ||
        0
      );

    let qty = 0;
    const qtyFields = ["quantity", "qty", "quantity-purchased"];
    for (const f of qtyFields) {
      const v = getField(raw, [f]);
      if (v !== undefined && v !== "") {
        qty = safeNum(v);
        break;
      }
    }

    let sku =
      getField(raw, ["sku", "seller sku", "Seller SKU", "item sku"]) ||
      extractSKU(raw.description) ||
      "";
    sku = String(sku).trim();

    let orderId =
      getField(raw, ["order id", "order-id", "orderId"]) ||
      r.order_id ||
      "UNKNOWN";

    const posted =
      raw.order_date ||
      raw.order_date_time ||
      "";

    const mm = masterMap[sku] || { name: "", cog: 0 };

    return {
      raw,
      order_id: String(orderId),
      sku,
      amount,
      quantity: safeNum(qty),
      posted_date: posted,
      posted_date_time: posted,
      product_name_master: mm.name,
      master_cog: mm.cog
    };
  });

  /* ---- 3. Group by order_id ---- */

  const groups = {};
  processed.forEach(p => {
    if (!groups[p.order_id]) groups[p.order_id] = [];
    groups[p.order_id].push(p);
  });

  const perOrderSkuQty = {};
  Object.keys(groups).forEach(orderId => {
    const map = {};
    groups[orderId].forEach(r => {
      if (!map[r.sku] || map[r.sku] < r.quantity) {
        map[r.sku] = r.quantity;
      }
    });
    perOrderSkuQty[orderId] = map;
  });

  /* ---- 4. Order Summary ---- */

  const orders_summary = Object.keys(groups).map(orderId => {
    const rows = groups[orderId];
    const skuQtyMap = perOrderSkuQty[orderId];

    const total_amount = rows.reduce((s, r) => s + safeNum(r.amount), 0);
    const total_quantity = Object.values(skuQtyMap).reduce((s, q) => s + safeNum(q), 0);

    let order_COG = 0;
    Object.keys(skuQtyMap).forEach(sku => {
      const mm = masterMap[sku] || { cog: 0 };
      order_COG += safeNum(mm.cog) * safeNum(skuQtyMap[sku]);
    });

    return {
      date: rows[0]?.posted_date || "",
      "order-id": orderId,
      type: "Order",
      skus: Object.keys(skuQtyMap).join(", "),
      total_quantity,
      total_amount,
      order_COG,
      final_amount: total_amount - order_COG,
      num_skus_missing_cog: Object.keys(skuQtyMap).filter(s => !(masterMap[s]?.cog > 0)).length,
      product_names: Object.keys(skuQtyMap).map(s => masterMap[s]?.name || "").join(", ")
    };
  });

  /* ---- 5. Unique SKUs ---- */

  const order_unique_skus = [];
  Object.keys(perOrderSkuQty).forEach(orderId => {
    const skuQty = perOrderSkuQty[orderId];
    Object.keys(skuQty).forEach(sku => {
      const mm = masterMap[sku] || { name: "", cog: 0 };
      order_unique_skus.push({
        "order-id": orderId,
        sku,
        sku_quantity_in_order: skuQty[sku],
        COGS: mm.cog,
        COGS_missing: !(mm.cog > 0),
        Total_COGS: mm.cog * skuQty[sku]
      });
    });
  });

  /* ---- 6. Raw Concat ---- */

  const raw_concat = processed.map(r => ({
    "order-id": r.order_id,
    sku: r.sku,
    quantity: r.quantity,
    amount: r.amount,
    posted_date: r.posted_date,
    posted_date_time: r.posted_date_time,
    product_name_master: r.product_name_master,
    master_cog: r.master_cog,
    raw: r.raw
  }));

  /* ---- 7. SKU MAP ---- */

  const sku_map = Object.keys(masterMap).map(sku => ({
    "Seller SKU": sku,
    "Product Name": masterMap[sku].name,
    COGS: masterMap[sku].cog
  }));

  /* ---- 8. Totals ---- */

  const totals = {
    totalSales: orders_summary.reduce((s, o) => s + o.total_amount, 0),
    totalCogs: orders_summary.reduce((s, o) => s + o.order_COG, 0),
    totalProfit: orders_summary.reduce((s, o) => s + o.final_amount, 0),
    totalOrders: orders_summary.length
  };

  return {
    sheets: {
      order_summery: orders_summary,
      order_unique_skus,
      raw_concat,
      sku_map,
      negative_orders: orders_summary.filter(o => o.final_amount < 0),
      missing_cog_orders: order_unique_skus.filter(x => x.COGS_missing)
    },
    totals
  };
}

/* ---------------- ROUTE (copy–paste from Amazon) ---------------- */

router.get("/:uploadId", async (req, res) => {
  try {
    const uploadId = req.params.uploadId.trim();

    let rawRows = await FlipkartRow.find({ upload_id: uploadId }).lean();
    if (!rawRows.length) {
      try {
        rawRows = await FlipkartRow.find({ upload_id: new mongoose.Types.ObjectId(uploadId) }).lean();
      } catch (e) {}
    }

    if (!rawRows.length) return res.status(400).send("No Flipkart rows found");

    const masterRows = await Master.find().lean();

    const result = runAnalysis(rawRows, masterRows);

    const saved = await AnalysisResult.findOneAndUpdate(
      { uploadId },
      {
        uploadId,
        marketplace: "flipkart",
        totals: result.totals,
        sheets: result.sheets
      },
      { upsert: true, new: true }
    );

    /* ---- EXCEL CREATE VIEW (same as Amazon) ---- */

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

    const outDir = path.join(__dirname, "../processed");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outName = `flipkart_${uploadId}_analyzed.xlsx`;
    const outPath = path.join(outDir, outName);

    XLSX.writeFile(wb, outPath);

    saved.filename = outName;
    await saved.save();

    res.download(outPath, outName, () => {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    });

  } catch (err) {
    console.error("Flipkart analyze error:", err);
    res.status(500).send("Flipkart Analyze Failed → " + err.message);
  }
});

module.exports = router;
