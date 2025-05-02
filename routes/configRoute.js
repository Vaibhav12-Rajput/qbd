const express = require("express");
const route = express.Router();
const auth = require("../middleware/auth");
const configController = require("../controllers/configController.js");
const { body } = require('express-validator');

const validateInput = [
    body('company1').notEmpty().withMessage('Company1 is a mandatory field'),
    // body('assetAccountName').notEmpty(),
    // body('cogsAccountName').notEmpty(),
    // body('incomeAccountName').notEmpty(),
    body('salesTaxAgency').notEmpty(),
    body('terms').notEmpty(),
    body('keepQBInvoiceNumber').notEmpty().isBoolean(),
    body('templateName').notEmpty(),
    body("multiUserMode").notEmpty().isBoolean()
    // body('salexTaxReturnLine').notEmpty(),
  ];

route.post("/write",auth.verifyRequest,validateInput,configController.write);

module.exports = route;
