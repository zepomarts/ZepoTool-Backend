const mongoose = require("mongoose");

const AmazonRowSchema = new mongoose.Schema(
  {
    upload_id: mongoose.Schema.Types.ObjectId
  },
  { strict: false } // Excel ke columns dynamic hote hain
);

module.exports = mongoose.model("AmazonRow", AmazonRowSchema);
