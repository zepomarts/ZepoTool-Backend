const mongoose = require("mongoose");

const FlipkartRowSchema = new mongoose.Schema(
  {
    upload_id: mongoose.Schema.Types.ObjectId
  },
  { strict: false } // Excel ke columns dynamic hote hain
);

module.exports = mongoose.model("FlipkartRow", FlipkartRowSchema);
