/**
 * @file middleware/auth.js — Express middleware for JWT verification.
 *
 * Checks the Authorization header for a Bearer token, verifies it,
 * and attaches the authenticated user record to `req.user`.
 */
const jwt = require('jsonwebtoken');
const User = require('../models/User');

module.exports = async (req, res, next) => {
    try {
        let token;
        const authHeader = req.header('Authorization');

        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.replace('Bearer ', '');
        } else if (req.query && req.query.token) {
            token = req.query.token;
        } else if (req.headers.cookie) {
            // Fallback for Database GUI static assets that don't send the token in the query string
            const match = req.headers.cookie.match(/kubex_gui_token=([^;]+)/);
            if (match) {
                token = match[1];
            }
        }

        if (!token) {
            return res.status(401).json({ success: false, error: 'Access denied. No token provided.' });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'kubex-development-super-secret-key-2026!');
        
        const user = await User.findById(decoded.id).select('-password');
        if (!user) {
            return res.status(401).json({ success: false, error: 'User session is invalid.' });
        }

        req.user = user;
        next();
    } catch (err) {
        res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    }
};
