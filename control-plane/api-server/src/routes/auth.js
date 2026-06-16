/**
 * @file routes/auth.js — REST API routes for authentication and session management.
 *
 * Mounted at /api/auth in index.js.
 */
const router = require('express').Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const auth = require('../middleware/auth');

// Generate JWT token helper
const generateToken = (userId) => {
    return jwt.sign(
        { id: userId },
        process.env.JWT_SECRET || 'kubex-development-super-secret-key-2026!',
        { expiresIn: '7d' }
    );
};

// ─── POST /api/auth/signup ──────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
    try {
        const { username, email, password, role = 'developer', developerEmail } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ success: false, error: 'All fields are required.' });
        }

        // Check if username or email already exists
        const emailExists = await User.findOne({ email: email.toLowerCase() });
        if (emailExists) {
            return res.status(400).json({ success: false, error: 'Email already registered.' });
        }

        const usernameExists = await User.findOne({ username: username.trim() });
        if (usernameExists) {
            return res.status(400).json({ success: false, error: 'Username already taken.' });
        }

        // Check if this is the first user in the system
        const userCount = await User.countDocuments();
        let finalRole = (userCount === 0) ? 'admin' : role;

        // Pre-allocate user ID to make tenantId assignment elegant
        const userId = new mongoose.Types.ObjectId();
        let finalTenantId = userId; // Defaults to self for developer

        if (role === 'viewer') {
            if (!developerEmail) {
                return res.status(400).json({ success: false, error: 'Developer link email is required for Viewer accounts.' });
            }

            const developerUser = await User.findOne({ 
                email: developerEmail.toLowerCase(), 
                role: 'developer' 
            });

            if (!developerUser) {
                return res.status(404).json({ 
                    success: false, 
                    error: 'Developer account not found. Please double-check their email address.' 
                });
            }

            finalTenantId = developerUser.tenantId || developerUser._id;
        }

        const newUser = new User({
            _id: userId,
            username: username.trim(),
            email: email.toLowerCase(),
            password,
            role: finalRole,
            tenantId: finalTenantId
        });

        await newUser.save();

        const token = generateToken(newUser._id);
        res.status(201).json({
            success: true,
            token,
            user: {
                _id: newUser._id,
                username: newUser.username,
                email: newUser.email,
                role: newUser.role,
                tenantId: newUser.tenantId
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── POST /api/auth/login ───────────────────────────────────────────────────
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, error: 'Email and password are required.' });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid email or password.' });
        }

        const token = generateToken(user._id);
        res.json({
            success: true,
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                role: user.role,
                tenantId: user.tenantId
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', auth, async (req, res) => {
    res.json({
        success: true,
        user: {
            _id: req.user._id,
            username: req.user.username,
            email: req.user.email,
            role: req.user.role,
            tenantId: req.user.tenantId
        }
    });
});

module.exports = router;
