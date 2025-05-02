const Datastore = require('@seald-io/nedb')
const path = require("path");

// // Create or load the NeDB database file

const nedbFilePath = path.join(process.cwd(), "database.db");
const db = new Datastore({ filename: nedbFilePath, autoload: true });

module.exports = { db }