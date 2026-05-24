const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const LoadBalancer = require('../services/LoadBalancer');
const Deployment = require('../models/Deployment');
const router = express.Router();

/**
 * Service Gateway for KUBEX.
 * 
 * Supports two routing modes:
 * 1. Path-based: /gate/:deploymentName/...
 * 2. Host-based: http://[deploymentName].localhost:3001/...
 * 
 * Performance: Caches proxy instances per deployment to avoid overhead.
 */

const proxyCache = new Map(); // deploymentName -> proxy middleware instance

function getProxyForDeployment(deploymentName) {
    if (proxyCache.has(deploymentName)) {
        return proxyCache.get(deploymentName);
    }

    console.log(`[Gateway] Initializing new proxy instance for "${deploymentName}"`);

    const proxy = createProxyMiddleware({
        target: 'http://localhost', // Initial dummy target, will be overridden by router
        router: (req) => {
            const endpoint = LoadBalancer.getNextEndpoint(deploymentName);
            if (!endpoint || !endpoint.hostPort) {
                console.warn(`[Gateway] No healthy endpoints for "${deploymentName}"`);
                return null;
            }
            const target = (endpoint.address && !endpoint.address.includes('localhost')) 
                ? `${endpoint.address.replace(/:\d+$/, '')}:${endpoint.hostPort}`
                : `http://localhost:${endpoint.hostPort}`;

            console.log(`[Gateway] Routing "${deploymentName}" to ${target}`);
            return target;
        },

        changeOrigin: true,
        pathRewrite: (path, req) => {
            // Express might strip the /gate prefix depending on how the router is mounted,
            // so we look for either ^/gate/deploymentName or just ^/deploymentName
            const gatePrefix = new RegExp(`^(/gate)?/${deploymentName}`);
            let newPath = path.replace(gatePrefix, '');
            
            // Ensure path starts with /
            if (!newPath.startsWith('/')) newPath = '/' + newPath;
            
            console.log(`[Gateway] ${req.method} ${deploymentName}: ${path} -> ${newPath}`);
            return newPath;
        },
        logLevel: 'warn',
        onError: (err, req, res) => {
            console.error(`[Gateway] Proxy Error for "${deploymentName}": ${err.message}`);
            res.status(502).json({ 
                success: false, 
                error: 'Gateway Proxy Error', 
                message: `Could not reach backend service for "${deploymentName}". Ensure the app is running and healthy.`,
                tip: 'Check deployment logs in the KUBEX dashboard.'
            });
        },
        onProxyRes: (proxyRes, req, res) => {
            // Add some helpful headers for debugging
            proxyRes.headers['X-Proxied-By'] = 'KUBEX-Gateway';
            proxyRes.headers['X-Deployment'] = deploymentName;
        }
    });

    proxyCache.set(deploymentName, proxy);
    return proxy;
}

// Global Gateway Handler
router.use(async (req, res, next) => {
    let deploymentName = null;

    // 1. Check Host header for subdomain (e.g. "my-app.localhost")
    const host = req.headers.host || '';
    const hostParts = host.split('.');
    if (hostParts.length > 1 && hostParts[hostParts.length - 1].startsWith('localhost')) {
        // If it's something.localhost, the first part is the deployment name
        deploymentName = hostParts[0];
    }

    // 2. Fallback: Check path-based routing (/gate/:name)
    if (!deploymentName || deploymentName === 'localhost') {
        const pathParts = req.path.split('/');
        // path is like "/my-app/subpath" because gateway is mounted at "/gate"
        if (pathParts[1]) {
            deploymentName = pathParts[1];
        }
    }

    if (!deploymentName) {
        return res.status(400).json({ 
            success: false, 
            error: 'Could not determine deployment name from request. Use /gate/:name or [name].localhost' 
        });
    }

    // Validate that the deployment exists
    const pool = LoadBalancer.getPool(deploymentName);
    if (!pool || pool.endpoints.length === 0) {
        // Check DB to see if it even exists
        const exists = await Deployment.findOne({ name: deploymentName });
        if (!exists) {
            return res.status(404).json({ success: false, error: `Deployment "${deploymentName}" not found` });
        }
        return res.status(503).json({ 
            success: false, 
            error: `Deployment "${deploymentName}" has no active endpoints`,
            status: 'Scaling/Pending'
        });
    }

    const proxy = getProxyForDeployment(deploymentName);
    return proxy(req, res, next);
});

module.exports = router;
