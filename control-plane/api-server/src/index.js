/**
 * @file index.js — KUBEX API Server entry point.
 *
 * Responsibilities:
 *   1. Load environment variables from .env (dotenv)
 *   2. Set up Express middleware (CORS, JSON body parser, HTTP logger)
 *   3. Mount all REST API route handlers
 *   4. Register a global error handler
 *   5. Connect to MongoDB, then start the HTTP server
 *   6. Launch background services (Reconciler, AutoScaler, FailureDetector)
 *
 * Startup order matters:
 *   connectDB() must complete before background services start, because they
 *   read from MongoDB immediately. That's why ReconcilerService.start() etc.
 *   are called inside bootstrap() after await connectDB().
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('./config/db');
const fs = require('fs');
const path = require('path');

// ── Route handlers (each file handles one resource type) ─────────────────────
const deploymentsRouter = require('./routes/deployments');
const nodesRouter = require('./routes/nodes');
const clusterRouter = require('./routes/cluster');
const logsRouter = require('./routes/logs');
const workersRouter = require('./routes/workers');

const systemRouter = require('./routes/system');
const authRouter = require('./routes/auth');
const webhooksRouter = require('./routes/webhooks');
const databasesRouter = require('./routes/databases');

// ── Background services (started after DB connects) ───────────────────────────

const AutoScalerService = require('./services/AutoScalerService');
const FailureDetector = require('./services/FailureDetector');
const HealthCheckService = require('./services/HealthCheckService');

const app = express();

// Ensure the logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
}

// Create a write stream for logging
const logStream = fs.createWriteStream(path.join(logsDir, 'api-server.log'), { flags: 'a' });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());                             // Allow cross-origin requests from the React frontend

app.use(express.json({ limit: '1mb' }));    // Parse JSON bodies; cap size to prevent abuse

// Custom Morgan configuration: Silences the high-frequency polling/heartbeat noise
app.use(morgan('dev', {
    skip: (req) => {
        const url = req.originalUrl || req.url;
        const isNoisy = url.includes('/heartbeat') || 
                        url.includes('/nodes') || 
                        url.includes('/cluster') || 
                        (req.method === 'GET' && url.includes('/deployments'));
        return isNoisy;
    }
}));

app.use((req, res, next) => {
    const url = req.originalUrl || req.url;
    const isNoisy = url.includes('/heartbeat') || 
                    url.includes('/nodes') || 
                    url.includes('/cluster') || 
                    (req.method === 'GET' && url.includes('/deployments'));
    
    if (!isNoisy) {
        const logEntry = `${new Date().toISOString()} - ${req.method} ${url}\n`;
        logStream.write(logEntry);
    }
    next();
});

console.log('✅ KUBEX Silence Mode: Enabled (Heartbeats hidden)');

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter); // Auth routes (signup, login, me)
app.use('/api/deployments', deploymentsRouter); // CRUD + scale for Deployments
app.use('/api/nodes', nodesRouter);       // Node list, detail, heartbeat, events
app.use('/api/workers', workersRouter);   // Worker spawning and management
app.use('/api/cluster', clusterRouter);     // Cluster status snapshot + scheduler scores
app.use('/api/logs', logsRouter);        // Live container log fetching
app.use('/api/system', systemRouter);    // System utilities (browse, etc.)
app.use('/api/webhooks', webhooksRouter);  // GitHub webhook listener
app.use('/api/databases', databasesRouter); // Managed DBs

// Convenience shortcut: worker agents POST to /api/heartbeat (without the /nodes/ prefix)
// We forward the request internally to the nodes router's /heartbeat handler
app.post('/api/heartbeat', (req, res, next) => {
    req.url = '/heartbeat';      // Rewrite URL to match the route inside nodesRouter
    nodesRouter(req, res, next);
});

// Simple health check endpoint — used by Docker healthcheck and load balancers
app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'kubex-api-server', ts: new Date() });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// Catches any error passed to next(err) from route handlers.
// Returns a consistent JSON error shape so the frontend can handle it uniformly.
app.use((err, req, res, _next) => {
    console.error('[API Error]', err.stack || err.message);
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Internal Server Error',
    });
});

// ─── Bootstrap ───────────────────────────────────────────────────────────────
/**
 * Connect to MongoDB, start the HTTP server, then launch background services.
 * Any error during boot causes an immediate process.exit(1) so the container
 * restarts rather than running in a broken half-started state.
 */
async function bootstrap() {
    await connectDB(); // Must succeed before anything else runs

    const PORT = process.env.PORT || 3001;
    app.listen(PORT, async () => {
        console.log(`\n🚀 KUBEX API Server running on http://localhost:${PORT}`);
        console.log('──────────────────────────────────────────────');

        try {
            const Node = require('./models/Node');
            // 1. Force cleanup of any surviving ghost processes from previous run
            const WorkerService = require('./services/WorkerService');
            await WorkerService.stopAllWorkers();

            // 3. Check for TRULY active nodes (heartbeat in last 5 seconds)
            const activeNodeCount = await Node.countDocuments({
                lastHeartbeat: { $gt: new Date(Date.now() - 5000) }
            });
            
            if (activeNodeCount === 0) {
                console.log('🌱 Cluster recovery: Spawning fresh 3-worker cluster...');
                // Sequential spawn to avoid port conflict race condition
                for (let i = 0; i < 3; i++) {
                    await WorkerService.spawnWorker();
                }
            }
        } catch (err) {
            console.error('Failed to auto-spawn initial workers:', err.message);
        }

        // Bug 15 fix: start background services INSIDE the listen callback, not after it.
        // app.listen() is asynchronous; calling .start() synchronously after it means
        // the services begin before the server is confirmed to be listening.

        AutoScalerService.start();  // CPU-based autoscaling loop (every 10 s)
        FailureDetector.start();    // Heartbeat timeout / node failure detection (every 5 s)
        HealthCheckService.start(); // Application L7 HTTP Health Checking (every 10 s)
    });
}

bootstrap().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});

// ─── Process Signal Handlers ──────────────────────────────────────────────────
// Handle unhandled promise rejections and uncaught exceptions to prevent
// the API server from crashing silently.
process.on('unhandledRejection', (reason, promise) => {
    console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception:', err.message);
    // In production, you might want to exit and let a process manager restart
});

// Graceful shutdown: stop background loops before exiting
const shutdown = async () => {
    console.log('\n[Process] Shutting down KUBEX API Server...');

    AutoScalerService.stop();
    FailureDetector.stop();
    HealthCheckService.stop();
    
    try {
        const WorkerService = require('./services/WorkerService');
        await WorkerService.stopAllWorkers();
    } catch (e) {
        console.error('[Process] Error stopping workers:', e.message);
    }

    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 0) {
        await mongoose.connection.close();
        console.log('[Process] MongoDB connection closed.');
    }
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = app; // Exported for potential integration tests
