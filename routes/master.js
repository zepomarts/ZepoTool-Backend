const express = require("express");
const router = express.Router();
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");

const Master = require("../models/Master");

// Master directory
const MASTER_DIR = path.join(__dirname, "../masters");
if (!fs.existsSync(MASTER_DIR)) fs.mkdirSync(MASTER_DIR, { recursive: true });

// Multer Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MASTER_DIR),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "_" + file.originalname.replace(/\s+/g, "_")),
});
const upload = multer({ storage });


// ----------------------------
// ⭐ Upload Master File
// ----------------------------
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file selected" });

    const filePath = req.file.path;

    const wb = XLSX.readFile(filePath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    // clear previous master
    await Master.deleteMany({});

    // map with correct columns
    const final = rows.map(r => ({
      sku: String(r["Seller SKU"] || "").trim(),
      name: r["Product Name"] || "",
      cog: Number(r["COGS"] || 0),
      raw: r
    }));

    await Master.insertMany(final);

    return res.json({
      success: true,
      filename: req.file.filename,
      originalname: req.file.originalname,
      total: final.length,
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "Master upload failed" });
  }
});


// ----------------------------
// ⭐ Get Master Info
// ----------------------------
router.get("/info", async (req, res) => {
  try {
    const rows = await Master.countDocuments();

    const files = fs.readdirSync(MASTER_DIR);

    if (!rows || !files.length) {
      return res.json({ exists: false });
    }

    const latest = files.sort(
      (a, b) =>
        fs.statSync(path.join(MASTER_DIR, b)).mtime -
        fs.statSync(path.join(MASTER_DIR, a)).mtime
    )[0];

    return res.json({
      exists: true,
      total: rows,
      filename: latest,
      originalname: latest.replace(/^\d+_/, ""),
      uploadedAt: fs.statSync(path.join(MASTER_DIR, latest)).mtime,
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to load master info" });
  }
});


// ----------------------------
// ⭐ View Master File (send RAW Excel rows only)
// ----------------------------
router.get("/view", async (req, res) => {
  try {
    const rows = await Master.find().lean();

    return res.json({
      success: true,
      rows: rows.map(r => r.raw)   // <-- ONLY raw Excel rows
    });

  } catch (err) {
    res.json({ success: false, rows: [] });
  }
});


// ----------------------------
// ⭐ Save edited master (save raw back)
// ----------------------------
router.post("/save", async (req, res) => {
  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows))
      return res.status(400).json({ error: "Invalid data" });

    await Master.deleteMany({});

    const formatted = rows.map(r => ({
      sku: String(r["Seller SKU"] || "").trim(),
      name: r["Product Name"] || "",
      cog: Number(r["COGS"] || 0),
      raw: r
    }));

    await Master.insertMany(formatted);

    res.json({ success: true });

  } catch (err) {
    res.json({ success: false });
  }
});


module.exports = router;
