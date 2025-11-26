const mongoose = require("mongoose");

const UploadSchema = new mongoose.Schema(
  {
    filename: String,
    originalname: String,
    filePath: String,
    marketplace: { type: String, default: "amazon" }, 
    parsed: { type: Array, default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Upload", UploadSchema);
