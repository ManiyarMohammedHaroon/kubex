const router = require('express').Router();
const User = require('../models/User');
const auth = require('../middleware/auth');

// ─── GET /api/settings/dockerhub ─────────────────────────────────────────────
router.get('/dockerhub', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        res.json({
            success: true,
            username: user.dockerHubUsername || '',
            // Only send a boolean indicating if a token exists, never the actual token
            hasToken: !!user.dockerHubToken
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── PUT /api/settings/dockerhub ─────────────────────────────────────────────
router.put('/dockerhub', auth, async (req, res) => {
    try {
        const { username, token } = req.body;
        
        const updateData = { dockerHubUsername: username };
        // Only update the token if a new one was provided (to allow updating just username)
        if (token && token.trim() !== '') {
            updateData.dockerHubToken = token.trim();
        }

        await User.findByIdAndUpdate(req.user._id, { $set: updateData });

        res.json({ success: true, message: 'Docker Hub credentials saved successfully' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
