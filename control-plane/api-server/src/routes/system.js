/**
 * @file routes/system.js — System-level utility routes.
 * 
 * Provides native OS integration for the KUBEX dashboard, such as
 * managing the saved images vault.
 */
const router = require('express').Router();
const auth = require('../middleware/auth');
const Image = require('../models/Image');

// Protect all routes in this file
router.use(auth);

/**
 * GET /api/system/images - Returns a list of all saved images for the user.
 */
router.get('/images', async (req, res) => {
    try {
        const dbImages = await Image.find({ owner: req.user._id }).sort({ createdAt: -1 });
        
        const images = dbImages.map(img => ({
            repo: img.repo,
            tag: img.tag,
            id: img._id.toString(),
            created: img.createdAt ? new Date(img.createdAt).toLocaleDateString() : 'recently',
            size: img.size
        }));

        console.log(`[API] Found ${images.length} saved images for user ${req.user._id}`);
        res.json({ success: true, images });
    } catch (err) {
        console.error('[API] GET /system/images Error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch saved images' });
    }
});

/**
 * DELETE /api/system/images/:id — Deletes a specific image from the database.
 */
router.delete('/images/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const deleted = await Image.findOneAndDelete({ _id: id, owner: req.user._id });
        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Image not found or not owned by you' });
        }
        console.log(`[API] Deleted image ${id} for user ${req.user._id}`);
        res.json({ success: true, message: 'Image successfully deleted from database' });
    } catch (err) {
        console.error('[API] DELETE /system/images Error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to delete image' });
    }
});

/**
 * POST /api/system/images/prune — Removes all saved images for the user.
 */
router.post('/images/prune', async (req, res) => {
    try {
        const result = await Image.deleteMany({ owner: req.user._id });
        console.log(`[API] Pruned ${result.deletedCount} images for user ${req.user._id}`);
        res.json({ success: true, message: 'All saved images pruned from your database' });
    } catch (err) {
        console.error('[API] POST /system/images/prune Error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to prune images' });
    }
});

module.exports = router;
