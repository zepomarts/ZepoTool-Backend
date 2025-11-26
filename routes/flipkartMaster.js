const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const FlipkartMaster = require("../models/FlipkartMaster");

// ---------------------------
//  FOLDER
// ---------------------------
const DIR = path.join(__dirname, "../FlipkartMasters");
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

// ---------------------------
//  Multer Storage
// ---------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DIR),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "_" + file.originalname.replace(/\s+/g, "_")),
});

const upload = multer({ storage });

// ---------------------------
//  Upload Master File
// ---------------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file selected" });

    const filePath = req.file.path;
    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    // REMOVE OLD master
    await FlipkartMaster.deleteMany({});

    // INSERT New rows
    const data = rows.map(r => ({
      sku: String(r["Seller SKU"] || "").trim(),
      name: r["Product Name"] || "",
      cog: Number(r["COGS"] || 0),
      raw: r,
    }));

    await FlipkartMaster.insertMany(data);

    res.json({
      success: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      total: data.length
    });

  } catch (err) {
    console.log("FLIPKART MASTER UPLOAD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});


// ---------------------------
//  Get Master Info
// ---------------------------
router.get("/info", async (req, res) => {
  try {
    const count = await FlipkartMaster.countDocuments();
    const files = fs.readdirSync(DIR);

    if (!count || !files.length) {
      return res.json({ exists: false });
    }

    const latest = files.sort(
      (a, b) =>
        fs.statSync(path.join(DIR, b)).mtime -
        fs.statSync(path.join(DIR, a)).mtime
    )[0];

    res.json({
      exists: true,
      filename: latest,
      originalname: latest.replace(/^\d+_/, ""),
      uploadedAt: fs.statSync(path.join(DIR, latest)).mtime,
      total: count
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to load master info" });
  }
});


// ---------------------------
//  View Master (raw return)
// ---------------------------
router.get("/view", async (req, res) => {
  try {
    const rows = await FlipkartMaster.find().lean();
    return res.json({ success: true, rows: rows.map(r => r.raw) });
  } catch (err) {
    return res.json({ success: false, rows: [] });
  }
});


// ---------------------------
//  Save Edited Master
// ---------------------------
router.post("/save", async (req, res) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows))
      return res.status(400).json({ error: "Invalid data" });

    await FlipkartMaster.deleteMany({});

    const formatted = rows.map(r => ({
      sku: String(r["Seller SKU"] || "").trim(),
      name: r["Product Name"] || "",
      cog: Number(r["COGS"] || 0),
      raw: r
    }));

    await FlipkartMaster.insertMany(formatted);

    res.json({ success: true });

  } catch (err) {
    res.json({ success: false });
  }
});


// EXPORT
module.exports = router;
