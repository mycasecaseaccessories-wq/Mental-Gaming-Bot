const mongoose = require('mongoose');

const replySchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['customer', 'admin'], required: true },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    adminId: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const customerFeedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    telegramId: { type: Number, required: true, index: true },
    username: { type: String, default: null },
    firstName: { type: String, default: null },
    type: { type: String, enum: ['suggestion', 'feedback'], required: true, index: true },
    message: { type: String, required: true, trim: true, maxlength: 4000 },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Catalog', default: null },
    subcategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Catalog', default: null },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    categoryName: { type: String, default: null },
    subcategoryName: { type: String, default: null },
    productName: { type: String, default: null },
    status: { type: String, enum: ['new', 'read', 'replied', 'resolved'], default: 'new', index: true },
    replies: { type: [replySchema], default: [] },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Number, default: null },
  },
  { timestamps: true, versionKey: false }
);

customerFeedbackSchema.index({ status: 1, createdAt: -1 });
customerFeedbackSchema.index({ type: 1, status: 1, createdAt: -1 });
customerFeedbackSchema.index({ telegramId: 1, createdAt: -1 });

module.exports = mongoose.model('CustomerFeedback', customerFeedbackSchema);
