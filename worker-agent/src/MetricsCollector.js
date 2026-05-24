/**
 * @file MetricsCollector.js — Real-time CPU and memory metrics for the worker node.
 *
 * Uses the `systeminformation` library to read actual OS-level metrics every 2 s.
 *
 * ── Density-Aware Virtualization ─────────────────────────────────────────────
 * Because multiple workers in a local dev setup share the SAME physical machine,
 * the raw OS metrics (CPU/MEM) would be identical across all workers.
 * That would make the Scheduler always pick the same node and the AutoScaler
 * never actually trigger (all nodes look the same).
 *
 * To simulate a realistic multi-node cluster on one machine we add:
 *   1. baseOffset  — a small, stable value derived from the node's name (2%–6%)
 *                    This makes each worker appear slightly different even at idle
 *   2. noise       — ±2% random jitter to simulate natural metric fluctuation
 *   3. densityCpu  — +8.5% per running KUBEX container (simulates container CPU overhead)
 *   4. densityMem  — +4.2% per running KUBEX container (simulates container MEM overhead)
 *
 * Final formula:
 *   cpuUsage = clamp(1, 99,  rawCpu + baseOffset + noise + densityCpu)
 *   memUsage = clamp(5, 98,  rawMem% + baseOffset/2 + noise/3 + densityMem)
 *
 * ── Chaos / Override Mode ────────────────────────────────────────────────────
 * When POST /chaos/stress is called, setOverride() sets a temporary high value
 * that replaces the real metrics for the specified duration.
 * This is used to trigger AutoScaler scale-up events during demos/tests.
 */
const si = require('systeminformation');
const ContainerRunner = require('./ContainerRunner');

// Current metric values (updated every 2 s by tick())
let cpuUsage = 0;
let memUsage = 0;

// Chaos override: { cpu, mem, until (timestamp) } or null when not active
let override = null;

// ── Node identity seed ─────────────────────────────────────────────────────
// Convert the node name (e.g. "worker-1") to a stable integer by summing
// char codes. Used to derive the baseOffset so each node has a unique baseline.
const nodeName = process.env.NODE_ID || 'worker-unknown';
const nodeSeed = nodeName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);

/**
 * Collect fresh metrics from the OS and update the module-level cpuUsage/memUsage.
 * Called every 2 seconds via setInterval. Also called at module load time.
 */
async function tick() {
    // ── Chaos override check ──────────────────────────────────────────────────
    if (override && Date.now() < override.until) {
        // Chaos mode active — use the overridden values instead of real OS metrics
        cpuUsage = override.cpu;
        memUsage = override.mem;
        return;
    } else if (override) {
        // Override duration has expired — clear it
        override = null;
    }

    try {
        const load = await si.currentLoad(); // Returns object with currentLoad (0–100%)
        const mem = await si.mem();          // Returns { active, total, ... } in bytes

        // Count running KUBEX containers on this node (used for density simulation)
        const containers = await ContainerRunner.listRunningContainerIds();
        const containerCount = containers.length;

        // ── Density-Aware Simulation ──────────────────────────────────────────

        // 1. baseOffset: stable 2%–6% derived from the node name
        //    Different workers on the same machine will have different baselines
        const baseOffset = (nodeSeed % 5) + 2; // Range: 2 to 6

        // 2. noise: ±2% random jitter to prevent flat lines in the dashboard charts
        const noise = (Math.random() * 4) - 2; // Range: -2 to +2

        // 3. densityCpu / densityMem: each running container adds simulated load
        //    This makes a node with 3 containers look busier than one with 0 containers
        const densityCpu = containerCount * 4.5; // +4.5% CPU per container
        const densityMem = containerCount * 1.5; // +1.5% MEM per container

        // 4. Compute final values, clamped to realistic bounds
        cpuUsage = Math.max(1, Math.min(99, load.currentLoad + baseOffset + noise + densityCpu));
        // Convert raw mem.active/total to a percentage first, then apply adjustments
        memUsage = Math.max(5, Math.min(98, ((mem.active / mem.total) * 100) + (baseOffset / 2) + (noise / 3) + densityMem));

    } catch (error) {
        console.error('Error collecting metrics:', error);
        // Keep last known values — don't reset to 0 (would confuse the AutoScaler)
    }
}

// Start the metric collection loop immediately and every 2 seconds afterwards
setInterval(tick, 2000);
tick(); // First collection right away so metrics are non-zero on the first heartbeat

/**
 * Override real metrics with synthetic values for chaos testing.
 * The override expires automatically after durationMs.
 *
 * @param {number} cpu        Fake CPU% to report (e.g. 90)
 * @param {number} mem        Fake MEM% to report (e.g. 80)
 * @param {number} durationMs How long to hold the override (default 30 s)
 */
function setOverride(cpu, mem, durationMs = 30000) {
    override = { cpu, mem, until: Date.now() + durationMs };
}

/**
 * Return the most recently collected metrics.
 * Called by HeartbeatService on every heartbeat tick.
 *
 * @returns {{ cpuUsage: number, memUsage: number, isSimulated: boolean }}
 *   isSimulated is true when a chaos override is currently active
 */
function getMetrics() {
    return {
        cpuUsage: parseFloat(cpuUsage.toFixed(2)), // Round to 2 dp for cleaner dashboard values
        memUsage: parseFloat(memUsage.toFixed(2)),
        isSimulated: !!override, // Lets the API server / dashboard flag overridden metrics
    };
}

module.exports = { getMetrics, setOverride };
