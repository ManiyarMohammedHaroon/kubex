const mongoose = require('mongoose');
const Deployment = require('./src/models/Deployment');

async function fixPort() {
    await mongoose.connect('mongodb://127.0.0.1:27017/kubex');
    const result = await Deployment.updateOne(
        { name: 'expensestracker-backend' },
        { $set: { 'healthCheck.enabled': true, 'healthCheck.path': '/', 'healthCheck.maxRetries': 3 } }
    );
    console.log(result);
    process.exit(0);
}

fixPort();
