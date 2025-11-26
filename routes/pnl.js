// backend/routes/pnl.js
const express = require("express");
const router = express.Router();
const { getPnlReport } = require("../controllers/pnl.controller");

router.get("/pnl", getPnlReport);

module.exports = router;
