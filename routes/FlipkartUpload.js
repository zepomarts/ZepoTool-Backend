const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

const FlipkartUpload = require("../models/FlipkartUpload");
const FlipkartRow = require("../models/FlipkartRow");

const UPLOAD_DIR = "./FlipkartUploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "_" + file.originalname.replace(/\s+/g, "_"))
});

const upload = multer({ storage });

// --- UPLOAD FILE ---
router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, error: "No file uploaded" });

    // duplicate check
    const duplicate = await FlipkartUpload.findOne({
      originalname: req.file.originalname
    });

    if (duplicate) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({
        success: false,
        error: "This Flipkart file already exists. Delete old one first."
      });
    }

    const filePath = req.file.path;
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    // Save upload record
    const uploadDoc = await FlipkartUpload.create({
      filename: req.file.filename,
      originalname: req.file.originalname,
      filePath,
      parsed: rows
    });

    // Remove older rows (precaution)
    await FlipkartRow.deleteMany({ upload_id: uploadDoc._id });

    // Format rows properly
    const formatted = rows.map((r) => ({
      upload_id: uploadDoc._id,
      order_id: r["Order ID"] || "",
      order_item_id: r["Order Item ID"] || "",
      sku: r["SKU"] || "",
      fsn: r["FSN"] || "",
      quantity: Number(r["QTY"] || 0),
      selling_price: Number(r["Selling Price"] || 0),
      shipping_charge: Number(r["Shipping Charge"] || 0),
      total_amount: Number(r["Total Amount"] || 0),

      order_date: r["Order Date"] || "",
      dispatch_date: r["Dispatch Date"] || "",
      delivered_date: r["Delivered Date"] || "",
      updated_date: r["Updated Date"] || "",

      return_status: r["Return Status"] || "",
      return_reason: r["Return Reason"] || "",
      cancellation_reason: r["Cancellation Reason"] || "",
      raw: r
    }));

    await FlipkartRow.insertMany(formatted);

    res.json({
      success: true,
      message: "Flipkart file processed successfully",
      upload_id: uploadDoc._id,
      rowsInserted: formatted.length
    });

  } catch (err) {
    console.error("FLIPKART UPLOAD ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// LIST UPLOADS
router.get("/", async (req, res) => {
  const files = await FlipkartUpload.find().sort({ createdAt: -1 });
  res.json(files);
});

// DELETE UPLOAD
router.delete("/:id", async (req, res) => {
  try {
    const upload = await FlipkartUpload.findById(req.params.id);

    if (!upload)
      return res.json({ success: false, error: "File not found" });

    await FlipkartRow.deleteMany({ upload_id: upload._id });

    if (upload.filePath && fs.existsSync(upload.filePath))
      fs.unlinkSync(upload.filePath);

    await FlipkartUpload.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: "Flipkart file + rows deleted" });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
