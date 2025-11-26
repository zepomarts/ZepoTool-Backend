// routes/dashboard.js
const express = require("express");
const router = express.Router();
const AnalysisResult = require("../models/AnalysisResult");

// GET /api/dashboard
router.get("/", async (req, res) => {
  try {
    // Get last processed analysis result
    const doc = await AnalysisResult.findOne().sort({ _id: -1 }).lean();

    if (!doc) {
      return res.json({
        success: true,
        totals: {
          sales: 0,
          orders: 0,
          units: 0,
          cogs: 0,
          net: 0,
          refundCount: 0,
          refundLoss: 0,
          marginPct: 0
        },
        topSelling: [],
        topProfit: [],
        timeseries: [],
        recent: []
      });
    }

    // Response using saved structure
    return res.json({
      success: true,
      totals: doc.totals || {},
      topSelling: doc.topSelling || [],
      topProfit: doc.topProfit || [],
      timeseries: doc.timeseries || [],
      recent: doc.recent || []
    });

  } catch (err) {
    console.error("Dashboard ERROR:", err);
    return res.status(500).json({
      success: false,
      error: "Dashboard failed"
    });
  }
});

module.exports = router;
