const mongoose = require('mongoose');
const Deployment = require('./src/models/Deployment');

async function run() {
    await mongoose.connect('mongodb://127.0.0.1:27017/kubex');
    const deps = await Deployment.find({});
    console.log(JSON.stringify(deps, null, 2));
    process.exit(0);
}
run();
