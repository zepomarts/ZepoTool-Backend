/**
 * backend/routes/processed.js
 * CLEAN + FILTER FIXED VERSION
 */

const router = require("express").Router();
const AnalysisResult = require("../models/AnalysisResult");
const path = require("path");
const fs = require("fs");

/* ----------------------------------------------------
   1) LIST ALL PROCESSED ANALYSIS FILES
-----------------------------------------------------*/
router.get("/list", async (req, res) => {
  try {
    const results = await AnalysisResult.find({}, null, {
      sort: { createdAt: -1 }
    }).lean();

    res.json({
      success: true,
      files: results.map(r => ({
        id: r._id,
        filename: r.filename,
        rowsCount: r.totals?.totalOrders || 0,
        createdAt: r.createdAt
      }))
    });

  } catch (err) {
    res.json({ success: false, message: "Failed to load files" });
  }
});

/* ----------------------------------------------------
   2) SUMMARY OF SELECTED FILE
-----------------------------------------------------*/
router.get("/summary/:id", async (req, res) => {
  try {
    const file = await AnalysisResult.findById(req.params.id).lean();
    if (!file) return res.json({ success: false, message: "File not found" });

    res.json({
      success: true,
      filename: file.filename,
      totalOrders: file.totals?.totalOrders || 0,
      totalSales: file.totals?.totalSales || 0,
      totalCogs: file.totals?.totalCogs || 0,
      totalProfit: file.totals?.totalProfit || 0,
      rows: file.sheets?.order_summery || []   // default sheet
    });

  } catch (err) {
    res.json({ success: false, message: "Summary load failed" });
  }
});

/* ----------------------------
  GET /api/processed/filters/:id
  -> returns skus, types, dates, marketplaces, asins
------------------------------*/
router.get("/filters/:id", async (req, res) => {
  try {
    const file = await AnalysisResult.findById(req.params.id).lean();
    if (!file) return res.json({ success: false });

    const rows = file.sheets.order_summery || [];

    // SKUs: split comma lists, trim, unique
    const skus = [...new Set(rows.flatMap(r => {
      if (!r.skus) return [];
      return String(r.skus).split(",").map(s => s.trim()).filter(Boolean);
    }))];

    const types = [...new Set(rows.map(r => r.type).filter(Boolean))];
    const dates = [...new Set(rows.map(r => r.date).filter(Boolean))];

    // marketplaces: try to detect from raw_concat or from order_summery marketplace field if present
    let marketplaces = [];
    if (file.sheets.raw_concat && file.sheets.raw_concat.length) {
      marketplaces = [...new Set(file.sheets.raw_concat.map(r => (r.marketplace || r.market || "Amazon")).filter(Boolean))];
    } else if (rows.some(r => r.marketplace)) {
      marketplaces = [...new Set(rows.map(r => r.marketplace).filter(Boolean))];
    } else {
      marketplaces = ["Amazon"]; // fallback
    }

    // ASIN: try to find from sku_map or raw_concat (if any)
    const asinsFromSkuMap = (file.sheets.sku_map || [])
      .flatMap(s => (s.ASIN ? [String(s.ASIN).trim()] : []));
    const asinsFromRaw = (file.sheets.raw_concat || [])
      .flatMap(r => (r.asin ? [String(r.asin).trim()] : []));
    const asins = [...new Set([...asinsFromSkuMap, ...asinsFromRaw].filter(Boolean))];

    res.json({ success: true, skus, types, dates, marketplaces, asins });
  } catch (err) {
    console.error("FILTER ERROR:", err);
    res.json({ success: false });
  }
});


/* ----------------------------------------------------
   4) ANY SHEET LOADER
-----------------------------------------------------*/
router.get("/sheet/:id/:sheet", async (req, res) => {
  try {
    const file = await AnalysisResult.findById(req.params.id).lean();
    if (!file) return res.json({ success: false, rows: [] });

    const rows = file.sheets[req.params.sheet] || [];
    res.json({ success: true, rows });

  } catch (err) {
    res.json({ success: false, rows: [] });
  }
});

/* ----------------------------
  POST /api/processed/filter-results
  -> apply filters (only on order_summery) and return totals using numeric conversion
------------------------------*/
router.post("/filter-results", async (req, res) => {
  try {
    const { fileId, sku, type, date } = req.body;

    const file = await AnalysisResult.findById(fileId).lean();
    if (!file) return res.json({ success: false, rows: [] });

    let rows = (file.sheets.order_summery || []).slice();

    // Convert type strings to normalized safe versions
    const normalize = v => String(v || "").trim().toLowerCase();

    if (sku) {
      rows = rows.filter(r => (r.skus || "").includes(sku));
    }

    if (type) {
      const t = normalize(type);
      rows = rows.filter(r => normalize(r.type) === t);
    }

    if (date) {
      rows = rows.filter(r => String(r.date).trim() === String(date).trim());
    }

    // sums
    const toNum = v => Number(v) || 0;

    res.json({
      success: true,
      count: rows.length,
      sales: rows.reduce((s, r) => s + toNum(r.total_amount), 0),
      cogs: rows.reduce((s, r) => s + toNum(r.order_COG), 0),
      profit: rows.reduce((s, r) => s + toNum(r.final_amount), 0),
      rows
    });

  } catch (err) {
    console.error("FILTER RESULTS ERROR:", err);
    res.json({ success: false, rows: [] });
  }
});

/* ----------------------------------------------------
   7) TOP SELLING PRODUCTS API
-----------------------------------------------------*/
router.get("/top-selling/:id", async (req, res) => {
  try {
    const file = await AnalysisResult.findById(req.params.id).lean();
    if (!file) return res.json({ success: false, list: [] });

    const rows = file.sheets.order_summery || [];

    const map = {}; // SKU => total qty

    rows.forEach(r => {
      const qty = Number(r.total_quantity) || 0;
      if (!r.skus) return;

      const list = r.skus.split(",").map(x => x.trim());
      list.forEach(sku => {
        if (!map[sku]) map[sku] = 0;
        map[sku] += qty;
      });
    });

    // convert to array & sort
    const sorted = Object.entries(map)
      .map(([sku, qty]) => ({ sku, qty }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 10); // top 10

    res.json({ success: true, list: sorted });

  } catch (err) {
    console.error("TOP SELLING ERROR:", err);
    res.json({ success: false, list: [] });
  }
});



/* ----------------------------------------------------
   6) DOWNLOAD EXCEL
-----------------------------------------------------*/
router.get("/download/:id", async (req, res) => {
  try {
    const file = await AnalysisResult.findById(req.params.id).lean();
    if (!file || !file.filename) return res.status(404).send("File not found");

    const filePath = path.join(__dirname, "../processed", file.filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("File missing");

    res.download(filePath);

  } catch (err) {
    res.status(500).send("Download failed");
  }
});

module.exports = router;
