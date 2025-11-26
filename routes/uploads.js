const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");
const Upload = require("../models/Upload");
const AmazonRow = require("../models/AmazonRow");


const UPLOAD_DIR = "./uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "_" + file.originalname.replace(/\s+/g, "_"))
});
const upload = multer({ storage });

// UPLOAD AMAZON
// backend/routes/uploads.js

router.post("/", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const marketplace = req.body.marketplace || "amazon";

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });


const duplicate = await Upload.findOne({ originalname: req.file.originalname });

if (duplicate) {
  // Delete physical file if duplicate
  if (fs.existsSync(req.file.path)) {
    fs.unlinkSync(req.file.path);
  }

  return res.status(400).json({
    success: false,
    error: "This file already exists. Please delete it before uploading again."
  });
}


    // Save to Upload collection
    const uploadDoc = await Upload.create({
      filename: req.file.filename,
      originalname: req.file.originalname,
      parsed: rows,
      filePath,
      marketplace,
    });

    // If Amazon → Save RAW rows to amazonrows
    if (marketplace === "amazon") {
      await AmazonRow.deleteMany({ upload_id: uploadDoc._id });

      const formatted = [];

      rows.forEach((r) => {
        const nr = {};
        Object.keys(r).forEach((k) => {
          nr[k.toLowerCase().trim()] = r[k];
        });

        formatted.push({
          upload_id: uploadDoc._id,

          settlement_id:
            nr["settlement-id"] ||
            nr["settlement id"] ||
            nr["settlementid"] ||
            "",

          transaction_type:
            nr["transaction-type"] ||
            nr["transaction type"] ||
            nr["transactiontype"] ||
            "",

          order_id:
            nr["order-id"] ||
            nr["order id"] ||
            nr["orderid"] ||
            "",

          merchant_order_id:
            nr["merchant-order-id"] ||
            nr["merchant order id"] ||
            nr["merchantorderid"] ||
            "",

          shipment_id:
            nr["shipment-id"] ||
            nr["shipment id"] ||
            nr["shipmentid"] ||
            "",

          marketplace_name:
            nr["marketplace-name"] ||
            nr["marketplace name"] ||
            "",

          amount_type:
            nr["amount-type"] ||
            nr["amount type"] ||
            "",

          amount_description:
            nr["amount-description"] ||
            nr["amount description"] ||
            "",

          amount:
            Number(nr["amount"]) ||
            Number(nr["total amount"]) ||
            0,

          fulfillment_id:
            nr["fulfillment-id"] ||
            nr["fulfillment id"] ||
            "",

          posted_date: nr["posted-date"] || "",
          posted_date_time: nr["posted-date-time"] || "",

          order_item_code:
            nr["order-item-code"] ||
            nr["order item code"] ||
            "",

          sku:
            nr["sku"] ||
            extractSKUFromText(nr["amount-description"]) ||
            "",

          quantity_purchased:
            Number(nr["quantity-purchased"]) ||
            Number(nr["quantity purchased"]) ||
            Number(nr["qty"]) ||
            0,
        });
      });

      await AmazonRow.insertMany(formatted);
    }

    res.json({
      success: true,
      message: "File uploaded and processed",
      upload_id: uploadDoc._id,
    });
  } catch (err) {
    console.error("UPLOAD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

// Helper to extract SKU if hidden in description
function extractSKUFromText(text) {
  if (!text) return "";
  const m = text.toString().match(/[A-Z0-9\-]{5,}/);
  return m ? m[0] : "";
}


router.get("/", async (req, res) => {
  const files = await Upload.find({ marketplace: "amazon" }).sort({ createdAt: -1 });
  res.json(files);
});


router.delete("/:id", async (req, res) => {
  try {
    const upload = await Upload.findById(req.params.id);
    if (!upload) return res.json({ success: false, error: "File not found" });

    // 1️⃣ Delete related amazonrows
    await AmazonRow.deleteMany({ upload_id: upload._id });

    // 2️⃣ Delete physical file
    if (upload.filePath && fs.existsSync(upload.filePath)) {
      fs.unlinkSync(upload.filePath);
    }

    // 3️⃣ Delete upload document
    await Upload.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: "File + related data deleted" });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
