const mongoose = require("mongoose");

const MasterSchema = new mongoose.Schema(
  {
    sku: String,
    name: String,
    cog: Number,
    raw: Object
  },
  { timestamps: true }
);

module.exports = mongoose.model("Master", MasterSchema);
