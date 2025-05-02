const winax = require('winax');

let appName = "QuickBooks Desktop Integration";
var QBApp = new winax.Object('QBXMLRP2.RequestProcessor.2');

// Open a connection to QuickBooks
QBApp.OpenConnection('', appName);

module.exports = { QBApp, appName };