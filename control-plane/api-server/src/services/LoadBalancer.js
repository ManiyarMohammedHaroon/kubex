/**
 * @file LoadBalancer.js — In-memory round-robin load balancer.
 *
 * Maintains a pool of healthy container IP addresses per deployment.
 * When the Reconciler creates or removes containers, it calls updatePool()
 * or removeEndpoint() to keep this map in sync.
 *
 * The round-robin algorithm is stateful: each deployment has its own
 * cursor (index) that advances on every call to getNextEndpoint().
 *
 * This is an in-memory structure — it is reset when the API server restarts.
 * The Reconciler rebuilds it within a few seconds by calling updatePool()
 * during its first reconcile pass.
 *
 * Currently the load balancer is used for:
 *   - The frontend dashboard's "Load Balancer Pools" section (via /api/cluster/status)
 *   - Internal routing decisions (container pool visibility)
 */

class LoadBalancer {
    constructor() {
        /**
         * Map<deploymentName, { endpoints: { ip: string, hostPort: string }[], index: number }>
         *
         * endpoints  — list of container network info currently in the pool
         * index      — the next position to serve in the round-robin rotation
         */
        this.pools = new Map();
    }

    /**
     * Replace (or create) the endpoint pool for a deployment.
     * Called by the Reconciler after every reconcile pass.
     *
     * @param {string}   deploymentName
     * @param {{ip: string, hostPort: string}[]} endpoints  Array of container connection info
     */
    updatePool(deploymentName, endpoints) {
        const existing = this.pools.get(deploymentName) || { endpoints: [], index: 0 };
        // Filter out endpoints that have neither IP nor HostPort
        existing.endpoints = endpoints.filter(e => (e.ip || e.hostPort) && e.address);


        // Keep the index within bounds if the pool shrank
        if (existing.index >= existing.endpoints.length) {
            existing.index = 0;
        }
        this.pools.set(deploymentName, existing);
    }

    /**
     * Remove a single container from a pool by its IP.
     *
     * @param {string} deploymentName
     * @param {string} ip  The container IP to remove
     */
    removeEndpoint(deploymentName, ip) {
        const pool = this.pools.get(deploymentName);
        if (!pool) return;

        pool.endpoints = pool.endpoints.filter((e) => e.ip !== ip);

        if (pool.index >= pool.endpoints.length) pool.index = 0;
    }

    /**
     * Completely remove a deployment's pool.
     * Called when a deployment is deleted.
     */
    removePool(deploymentName) {
        this.pools.delete(deploymentName);
    }

    /**
     * Return the next endpoint in round-robin order.
     *
     * @param {string} deploymentName
     * @returns {{ip: string, hostPort: string}|null}
     */
    getNextEndpoint(deploymentName) {
        const pool = this.pools.get(deploymentName);
        if (!pool || pool.endpoints.length === 0) return null;

        const endpoint = pool.endpoints[pool.index % pool.endpoints.length];
        pool.index = (pool.index + 1) % pool.endpoints.length;
        return endpoint;
    }

    /**
     * Get the current state of a single deployment's pool.
     */
    getPool(deploymentName) {
        return this.pools.get(deploymentName) || { endpoints: [], index: 0 };
    }

    /**
     * Get a serialisable snapshot of ALL pools.
     */
    getAllPools() {
        const result = {};
        this.pools.forEach((val, key) => {
            result[key] = {
                endpoints: val.endpoints.map(e => e.ip),
                hostPorts: val.endpoints.map(e => e.hostPort),
                count: val.endpoints.length
            };
        });
        return result;
    }
}

// Singleton — one shared instance across the entire API server process.
// All services import this same instance, so pool updates are immediately visible everywhere.
module.exports = new LoadBalancer();
