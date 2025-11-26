const mongoose = require("mongoose");

const FlipkartUploadSchema = new mongoose.Schema(
  {
  filename: String,
  originalname: String,
  filePath: String,
  marketplace: { type: String, default: "flipkart" },
  parsed: { type: Array, default: [] },
},
 { timestamps: true }
);

module.exports = mongoose.model("FlipkartUpload", FlipkartUploadSchema);
