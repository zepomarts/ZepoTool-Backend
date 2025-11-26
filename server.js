const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const processedRoutes = require("./routes/processed");
const pnlRoutes = require("./routes/pnl");
const flipkartRoutes = require("./routes/FlipkartUpload");



require("dotenv").config();

const app = express();

// MIDDLEWARE
app.use(cors());  
app.use(express.json());

// STATIC for downloads
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/processed", express.static(path.join(__dirname, "processed")));
app.use("/masters", express.static(path.join(__dirname, "masters")));
app.use("/flipkart", express.static(path.join(__dirname, "FlipkartUploads")));
app.use("/flipkart", express.static("FlipkartUploads"));





// AMAZON
app.use("/api/uploads", require("./routes/uploads"));
app.use("/api/master", require("./routes/master"));
app.use("/api/analyze", require("./routes/analyze"));

// FLIPKART
app.use("/api/flipkart/uploads", require("./routes/FlipkartUpload"));
app.use("/api/flipkart/master", require("./routes/flipkartMaster"));
app.use("/api/flipkart/analyze", require("./routes/Flipkartanalyze"));

// COMMON
app.use("/api/processed", require("./routes/processed"));
app.use("/api/dashboard", require("./routes/dashboard"));
app.use("/api/pnl", require("./routes/pnl"));


// DB CONNECTION
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.log("Mongo ERROR:", err));

// START SERVER
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
