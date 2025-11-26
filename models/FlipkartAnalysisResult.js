const mongoose = require("mongoose");

const FlipkartAnalysisResultSchema = new mongoose.Schema(
  {
    uploadId: { type: String, required: true },
    filename: { type: String, default: "" },  
    totals: { type: Object, default: {} },
    sheets: { type: Object, default: {} }
  },
  { timestamps: true }   // ⭐ CRITICAL FIX
);

module.exports = mongoose.model("FlipkartAnalysisResult", FlipkartAnalysisResultSchema);
