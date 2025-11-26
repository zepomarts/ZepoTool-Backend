const mongoose = require("mongoose");

const FlipkartMasterSchema = new mongoose.Schema(
  {
    sku: String,
    name: String,
    cog: Number,
    raw: mongoose.Schema.Types.Mixed
  },
  { timestamps: true }
);

module.exports = mongoose.model("FlipkartMaster", FlipkartMasterSchema);