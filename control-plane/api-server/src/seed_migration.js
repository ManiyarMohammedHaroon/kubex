/**
 * @file seed_migration.js — Database seeding and migration utility.
 *
 * Scans the database, creates a default admin user if missing, and assigns
 * any pre-existing "orphan" deployments (those without an owner field)
 * to this default admin to ensure multi-tenant backward compatibility.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Deployment = require('./models/Deployment');
const connectDB = require('./config/db');

async function migrate() {
    try {
        console.log('[Migration] Starting database migration...');
        
        // 1. Establish DB Connection
        await connectDB();

        // 2. Create Default Admin if it doesn't exist
        const adminEmail = 'admin@kubex.io';
        let adminUser = await User.findOne({ email: adminEmail });

        if (!adminUser) {
            console.log(`[Migration] Default admin account not found. Creating one...`);
            adminUser = new User({
                username: 'admin',
                email: adminEmail,
                password: 'adminpassword123', // Mongoose pre-save hook will hash this
                role: 'admin'
            });
            // Admin tenant ID points to self
            adminUser.tenantId = adminUser._id;
            await adminUser.save();
            console.log(`[Migration] Created default admin account: ${adminEmail} (password: adminpassword123)`);
        } else {
            console.log(`[Migration] Default admin account already exists.`);
        }

        // 3. Scan for orphan deployments (lacking owner)
        const orphanDeployments = await Deployment.find({ owner: { $exists: false } });
        console.log(`[Migration] Found ${orphanDeployments.length} orphan deployment(s) lacking owners.`);

        if (orphanDeployments.length > 0) {
            let migratedCount = 0;
            for (const dep of orphanDeployments) {
                dep.owner = adminUser._id;
                await dep.save();
                migratedCount++;
                console.log(`[Migration] Successfully assigned deployment "${dep.name}" to admin.`);
            }
            console.log(`[Migration] Completed assignment: ${migratedCount} deployment(s) migrated successfully.`);
        } else {
            console.log('[Migration] No orphan deployments to migrate.');
        }

        console.log('[Migration] Database migration completed successfully.');
        process.exit(0);
    } catch (err) {
        console.error(`[Migration] CRITICAL ERROR:`, err);
        process.exit(1);
    }
}

// Execute the migration
migrate();
