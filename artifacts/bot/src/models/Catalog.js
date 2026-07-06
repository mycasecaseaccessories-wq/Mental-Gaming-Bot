const mongoose = require('mongoose');

const checkoutFieldSchema = new mongoose.Schema(
  {
    key:         { type: String, required: true, trim: true },
    label:       { type: String, required: true, trim: true },
    fieldType:   { type: String, enum: ['text', 'number', 'email', 'textarea'], default: 'text' },
    required:    { type: Boolean, default: true },
    placeholder: { type: String, default: '' },
    helpText:    { type: String, default: '' },
    sortOrder:   { type: Number, default: 0 },
  },
  { _id: false }
);

const catalogSchema = new mongoose.Schema(
  {
    name:          { type: String, required: true, trim: true, unique: true },
    description:   { type: String, default: '' },
    imageUrl:      { type: String, default: null },
    parentCategory: { type: mongoose.Schema.Types.ObjectId, ref: 'Catalog', default: null },
    sortOrder:     { type: Number, default: 0 },
    isActive:      { type: Boolean, default: true },
    checkoutFields: { type: [checkoutFieldSchema], default: [] },
    defaultDeliveryNotes: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

catalogSchema.index({ sortOrder: 1, name: 1 });

module.exports = mongoose.model('Catalog', catalogSchema);
