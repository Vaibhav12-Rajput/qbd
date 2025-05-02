const { logger } = require("../config/winstonConfig");
const configUtil = require("../util/configUtil");
const { validationResult } = require('express-validator');
const CommonResponsePayload = require("../responsePayload/commonResponsePayload");

exports.write = (req, res) => {
    let responsePayload;
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        let responseMessage = "Validation Failed";
        logger.error(responseMessage);
        return res.status(400).json(new CommonResponsePayload(responseMessage,errors.array()));
    }
    let companyDetail = {};
    for (const key in req.body) {
        if (req.body.hasOwnProperty(key) && key.startsWith('company') && req.body[key]) {
            companyDetail[key] = req.body[key];
        }
    }
    // let accountDetails = {
    //     assetAccountName: req.body.assetAccountName,
    //     cogsAccountName: req.body.cogsAccountName,
    //     incomeAccountName: req.body.incomeAccountName
    // };
    let taxAgencyDetails = {
        salesTaxAgency: req.body.salesTaxAgency,
        salexTaxReturnLine: req.body.salexTaxReturnLine
    };

    let otherDetails = {
        terms : req.body.terms,
        keepQBInvoiceNumber : req.body.keepQBInvoiceNumber,
        templateName : req.body.templateName,
        multiUserMode : req.body.multiUserMode,
        nedbDataRetentionDays : 365
    }

    try {
        configUtil.writeInConfig(companyDetail,otherDetails,taxAgencyDetails);
        let responseMessage = "Configuration created successfully";
        logger.info(responseMessage);
        responsePayload = new CommonResponsePayload(responseMessage,{});
        res.status(200).send(responsePayload);
    } catch (err) {
        logger.error(err);
        responsePayload = new CommonResponsePayload("Something went wrong",{});
        res.status(500).send(responsePayload);
    }
}
