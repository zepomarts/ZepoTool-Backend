// backend/controllers/pnlController.js
const AnalysisResult = require("../models/AnalysisResult");
const moment = require("moment");

const safe = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function getPnlReport(req, res) {
  try {
    // Optional: allow fileId query param; fallback to latest
    const fileId = req.query.fileId;
    let doc;
    if (fileId) {
      doc = await AnalysisResult.findById(fileId).lean();
    } else {
      doc = await AnalysisResult.findOne().sort({ _id: -1 }).lean();
    }

    if (!doc) return res.json({ months: [], totals: {}, topProducts: [] });

    const orders = doc.sheets?.order_summery || [];
    if (!orders.length) return res.json({ months: [], totals: {}, topProducts: [] });

    // monthly buckets map
    const monthMap = {}; // YYYY-MM -> stats

    // global aggregates
    let global = {
      sales: 0,
      unitsSold: 0,
      refundAmount: 0,
      refundCount: 0,
      cogs: 0,
      netProfit: 0
    };

    // also build SKU-level metrics for top products
    const skuStat = {}; // sku -> { qty, sales, cogs, profit, refunds }

    orders.forEach(o => {
      const date = o.date || o.posted_date || o.posted_date_time || "";
      const monthKey = date ? moment(date).format("YYYY-MM") : "Unknown";

      if (!monthMap[monthKey]) {
        monthMap[monthKey] = {
          month: monthKey,
          sales: 0,
          unitsSold: 0,
          refundAmount: 0,
          refundCount: 0,
          cogs: 0,
          grossProfit: 0,
          netProfit: 0,
          asp: 0,
          sellableReturnPercent: 0
        };
      }
      const bucket = monthMap[monthKey];

      const sales = safe(o.total_amount);
      const qty = safe(o.total_quantity);
      const orderCogs = safe(o.order_COG);
      const final = safe(o.final_amount);

      // accumulate
      bucket.sales += sales;
      bucket.unitsSold += qty;
      bucket.cogs += orderCogs;
      bucket.netProfit += final;
      bucket.grossProfit = bucket.sales - bucket.cogs;

      global.sales += sales;
      global.unitsSold += qty;
      global.cogs += orderCogs;
      global.netProfit += final;

      // refunds: detect by type or negative final_amount
      const isRefund = (String(o.type || "").toLowerCase().includes("refund")) || final < 0;
      if (isRefund) {
        // Ideally refund amount = absolute of negative contribution.
        // Use final if negative; else if refund_amount present use that.
        const refundAmt = final < 0 ? Math.abs(final) : safe(o.refund_amount);
        bucket.refundAmount += refundAmt;
        bucket.refundCount += 1;
        global.refundAmount += refundAmt;
        global.refundCount += 1;
      }

      // SKU-level: split skus, attribute qty & money proportionally.
      const skusStr = o.skus || "";
      const skus = skusStr ? String(skusStr).split(",").map(s => s.trim()).filter(Boolean) : [];
      if (skus.length === 0) {
        // if no SKU, attribute to UNKNOWN
        const sku = "__UNKNOWN__";
        if (!skuStat[sku]) skuStat[sku] = { qty: 0, sales: 0, cogs: 0, profit: 0, refunds: 0 };
        skuStat[sku].qty += qty;
        skuStat[sku].sales += sales;
        skuStat[sku].cogs += orderCogs;
        skuStat[sku].profit += final;
        if (isRefund) skuStat[sku].refunds += 1;
      } else {
        // If multiple SKUs, we distribute qty/sales/cogs equally across SKUs
        const perSkuQty = qty > 0 ? qty / skus.length : 0;
        const perSkuSales = sales / Math.max(1, skus.length);
        const perSkuCogs = orderCogs / Math.max(1, skus.length);
        const perSkuProfit = final / Math.max(1, skus.length);

        skus.forEach(sku => {
          if (!skuStat[sku]) skuStat[sku] = { qty: 0, sales: 0, cogs: 0, profit: 0, refunds: 0 };
          skuStat[sku].qty += perSkuQty;
          skuStat[sku].sales += perSkuSales;
          skuStat[sku].cogs += perSkuCogs;
          skuStat[sku].profit += perSkuProfit;
          if (isRefund) skuStat[sku].refunds += 1;
        });
      }
    });

    // finalize month metrics
    const months = Object.values(monthMap).map(m => {
      m.asp = m.unitsSold ? (m.sales / m.unitsSold) : 0;
      m.grossProfit = m.sales - m.cogs;
      m.grossMargin = m.sales ? (m.grossProfit / m.sales) * 100 : 0;
      m.netMargin = m.sales ? (m.netProfit / m.sales) * 100 : 0;
      m.refundPercent = m.sales ? (m.refundAmount / m.sales) * 100 : 0;
      m.sellableReturnPercent = m.unitsSold ? (m.refundCount / m.unitsSold) * 100 : 0;
      // round values to 2 decimals
      ["sales","cogs","grossProfit","netProfit","asp","grossMargin","netMargin","refundAmount","refundPercent","sellableReturnPercent"].forEach(k=>{
        if (m[k] !== undefined) m[k] = Number(m[k].toFixed(2));
      });
      return m;
    }).sort((a,b)=> b.month.localeCompare(a.month));

    // totals (rounded)
    const totals = {
      sales: Number(global.sales.toFixed(2)),
      unitsSold: Math.round(global.unitsSold),
      refundAmount: Number(global.refundAmount.toFixed(2)),
      refundCount: global.refundCount,
      cogs: Number(global.cogs.toFixed(2)),
      netProfit: Number(global.netProfit.toFixed(2)),
      grossProfit: Number((global.sales - global.cogs).toFixed(2)),
      grossMargin: global.sales ? Number(((global.sales - global.cogs) / global.sales * 100).toFixed(2)) : 0
    };

    // Top products by qty and by profit
    const topByQty = Object.entries(skuStat).map(([sku, s]) => ({ sku, qty: Number(s.qty.toFixed(2)), sales: Number(s.sales.toFixed(2)), profit: Number(s.profit.toFixed(2)), refunds: s.refunds }))
      .sort((a,b)=> b.qty - a.qty).slice(0, 20);

    const topByProfit = Object.entries(skuStat).map(([sku, s]) => ({ sku, profit: Number(s.profit.toFixed(2)), sales: Number(s.sales.toFixed(2)), qty: Number(s.qty.toFixed(2)) }))
      .sort((a,b)=> b.profit - a.profit).slice(0, 20);

    res.json({ months, totals, topByQty, topByProfit, rawCount: orders.length });

  } catch (err) {
    console.error("PNL ERROR:", err);
    res.status(500).send("Failed to load P&L");
  }
}

module.exports = { getPnlReport };
