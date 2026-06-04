const mongoose = require('mongoose');
const Node = require('./src/models/Node');

async function run() {
    await mongoose.connect('mongodb://127.0.0.1:27017/kubex');
    const nodes = await Node.find({});
    console.log(nodes);
    process.exit(0);
}
run();
