const mongoose = require('mongoose');

const imageSchema = new mongoose.Schema(
    {
        repo: { type: String, required: true },
        tag: { type: String, required: true },
        imageId: { type: String, default: 'unknown' },
        size: { type: String, default: '128m' },
        owner: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model('Image', imageSchema);
