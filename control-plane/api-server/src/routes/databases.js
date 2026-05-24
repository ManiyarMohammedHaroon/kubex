const router = require('express').Router();
const crypto = require('crypto');
const Database = require('../models/Database');
const User = require('../models/User');
const auth = require('../middleware/auth');
const dockerService = require('../services/DockerService');
const { createProxyMiddleware } = require('http-proxy-middleware');

router.use(auth);

// GET /api/databases - List all databases for the user
router.get('/', async (req, res) => {
    try {
        const query = req.user.role === 'viewer'
            ? { viewers: req.user._id }
            : { $or: [{ owner: req.user._id }, { viewers: req.user._id }] };
        const dbs = await Database.find(query)
            .populate('viewers', 'name email')
            .sort('-createdAt');
        res.json({ success: true, data: dbs });
    } catch (err) {
        console.error('[DBaaS] Get error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/databases - Create a new database instance
router.post('/', async (req, res) => {
    try {
        const { name, type } = req.body;
        
        if (!name || !type) {
            return res.status(400).json({ success: false, message: 'Name and type are required' });
        }

        const validTypes = ['mongo', 'postgres', 'mysql', 'redis'];
        if (!validTypes.includes(type)) {
            return res.status(400).json({ success: false, message: 'Invalid database type' });
        }

        const existing = await Database.findOne({ name });
        if (existing) {
            return res.status(400).json({ success: false, message: 'Database name already exists' });
        }

        // Generate secure random credentials
        const username = type === 'redis' ? 'default' : `user_${crypto.randomBytes(4).toString('hex')}`;
        const password = crypto.randomBytes(16).toString('hex');
        
        // Internal container port mapping
        const ports = {
            'mongo': 27017,
            'postgres': 5432,
            'mysql': 3306,
            'redis': 6379
        };

        const db = new Database({
            name,
            type,
            internalPort: ports[type],
            credentials: { username, password },
            owner: req.user._id
        });

        await db.save();

        // Spin up the Docker container in the background
        setImmediate(async () => {
            try {
                const { containerId, volumeName } = await dockerService.createDatabaseContainer(db);
                db.containerId = containerId;
                db.volumeName = volumeName;
                db.status = 'Running';
                await db.save();
            } catch (err) {
                console.error(`[DBaaS] Failed to provision ${db.name}:`, err);
                db.status = 'Failed';
                await db.save();
            }
        });

        res.json({ success: true, data: db });
    } catch (err) {
        console.error('[DBaaS] Create error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// DELETE /api/databases/:id - Terminate database and destroy volume
router.delete('/:id', async (req, res) => {
    if (req.user.role === 'viewer') {
        return res.status(403).json({ success: false, error: 'Viewers cannot delete databases' });
    }
    try {
        const db = await Database.findOne({ _id: req.params.id, owner: req.user._id });
        if (!db) {
            return res.status(404).json({ success: false, message: 'Database not found' });
        }

        db.status = 'Terminating';
        await db.save();

        if (db.containerId) {
            await dockerService.removeDatabaseContainer(db.containerId, db.volumeName, db._id.toString());
        }

        await Database.deleteOne({ _id: db._id });

        res.json({ success: true, message: 'Database deleted' });
    } catch (err) {
        console.error('[DBaaS] Delete error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// POST /api/databases/:id/share - Share a database with a client
router.post('/:id/share', async (req, res) => {
    if (req.user.role === 'viewer') return res.status(403).json({ success: false, message: 'Viewers cannot share' });
    try {
        const { email } = req.body;
        const db = await Database.findOne({ _id: req.params.id, owner: req.user._id });
        if (!db) return res.status(404).json({ success: false, message: 'Database not found' });

        const client = await User.findOne({ email });
        if (!client) return res.status(404).json({ success: false, message: 'User not found with that email' });
        if (client._id.equals(req.user._id)) return res.status(400).json({ success: false, message: 'Cannot share with yourself' });

        if (!db.viewers.includes(client._id)) {
            db.viewers.push(client._id);
            await db.save();
        }

        res.json({ success: true, message: 'Database shared successfully' });
    } catch (err) {
        console.error('[DBaaS] Share error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// DELETE /api/databases/:id/share/:userId - Revoke access
router.delete('/:id/share/:userId', async (req, res) => {
    if (req.user.role === 'viewer') return res.status(403).json({ success: false, message: 'Viewers cannot revoke' });
    try {
        const db = await Database.findOne({ _id: req.params.id, owner: req.user._id });
        if (!db) return res.status(404).json({ success: false, message: 'Database not found' });

        db.viewers = db.viewers.filter(v => !v.equals(req.params.userId));
        await db.save();

        res.json({ success: true, message: 'Access revoked' });
    } catch (err) {
        console.error('[DBaaS] Revoke error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// USE /api/databases/:id/gui - Secure Database Studio Proxy
router.use('/:id/gui', async (req, res, next) => {
    try {
        const query = req.user.role === 'viewer'
            ? { _id: req.params.id, viewers: req.user._id }
            : { _id: req.params.id, $or: [{ owner: req.user._id }, { viewers: req.user._id }] };
            
        const db = await Database.findOne(query);
        if (!db) return res.status(403).send('Unauthorized or Not Found');

        const targetUrl = await dockerService.ensureGuiContainer(db);
        
        if (!targetUrl) return res.status(503).send('GUI Service Unavailable');

        return createProxyMiddleware({
            target: targetUrl,
            changeOrigin: true,
            ws: true,
            on: {
                proxyRes: (proxyRes, req, res) => {
                    // Ensure the kubex_gui_token is safely appended without being overwritten by the proxy target's own cookies
                    if (req.query.token) {
                        const cookieStr = `kubex_gui_token=${req.query.token}; Path=/api/databases/${req.params.id}/gui; Max-Age=86400; HttpOnly`;
                        let existing = proxyRes.headers['set-cookie'] || [];
                        if (!Array.isArray(existing)) existing = [existing];
                        existing.push(cookieStr);
                        proxyRes.headers['set-cookie'] = existing;
                    }
                }
            },
            pathRewrite: (path, req) => {
                // path is req.url (which has the prefix stripped by Express router)
                // e.g., path is `/?token=123` or `/public/css/style.css`
                
                if (db.type === 'mongo') {
                    // mongo-express expects the full path because of ME_CONFIG_SITE_BASEURL
                    let newPath = `/api/databases/${req.params.id}/gui${path}`;
                    // Ensure the base path has a trailing slash before the query string to prevent Cannot GET /
                    newPath = newPath.replace(/\/gui(\?|$)/, '/gui/$1');
                    return newPath;
                }
                
                // For other databases (like adminer), just ensure it starts with a slash
                if (!path.startsWith('/')) {
                    return '/' + path;
                }
                return path;
            }
        })(req, res, next);
    } catch (err) {
        console.error('[DBaaS] GUI Proxy error:', err);
        res.status(500).send('Server error loading GUI');
    }
});

module.exports = router;
