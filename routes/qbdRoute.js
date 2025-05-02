const express = require('express');
const router = express.Router();
const qbdController = require("../controllers/qbdController");
const auth = require("../middleware/auth");
const {logger} = require("../config/winstonConfig");

router.get('/', (req, res) => {
  logger.info("Application Connected to Quickbooks Desktop");
  res.send('Application Connected to Quickbooks Desktop');
});

router.post('/connect',auth.verifyRequest, qbdController.connect);
router.post('/invoice',auth.verifyRequest,qbdController.createInvoice);
router.post('/bill', qbdController.createBillController);


module.exports = router;
