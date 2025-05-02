const readConfigFile = require("../util/configUtil");
const { logger } = require("../config/winstonConfig");
const { QBApp, appName } = require("../config/qbdConfig");
const { checkTemplate, validateSalesTax, validateOrCreateCustomer, getItemAndProcessInvoice, checkOrCreateNonTax, checkOrCreateSubtotalItem, checkOrCreateZeroSalesTaxCodes, checkOrCreateServiceItems, checkOrCreateIncomeAccounts, removeOldDBRecords, insertOrUpdateInDBForFailure, getAllSalesTaxFromQB, processBill } = require("../services/qbdService");
const CommonResponsePayload = require("../responsePayload/commonResponsePayload");

exports.connect = async (req, res) => {
  let ticket;
  let responsePayload;
  let responseMessage;

  try {
    const companyPath = readConfigFile.getCompanyPath(req.body.qbCompanyConfigCode);
    if (!companyPath) {
      logger.error(`Company File Path not found for ${req.body.qbCompanyConfigCode} in config.ini file`);
      return res.status(400).send({ error: `Company File Path not found for ${req.body.qbCompanyConfigCode} in config.ini file` });
    }

    logger.info("Successfully got the company path for " + req.body.qbCompanyConfigCode);
    let userMode = readConfigFile.getMultiUserMode() === true ? 1 : 0;
    // QBApp.OpenConnection('', appName);
    ticket = QBApp.BeginSession(companyPath, userMode);

    logger.info("Session began for " + req.body.qbCompanyConfigCode);
    logger.info("Company have accepted the connect request")

    await checkOrCreateNonTax(ticket);

    await checkOrCreateZeroSalesTaxCodes(ticket);

    await checkOrCreateIncomeAccounts(ticket);

    await checkOrCreateServiceItems(ticket);
    // await checkOrCreateItems(ticket);
    await checkOrCreateSubtotalItem(ticket);

    QBApp.EndSession(ticket);
    // QBApp.CloseConnection();

    logger.info("Session ended for " + req.body.qbCompanyConfigCode);

    responseMessage = `App Successfully connected with Quickbooks Desktop for ${req.body.qbCompanyConfigCode}`
    responsePayload = new CommonResponsePayload(responseMessage, {});
    res.status(201).send(responsePayload)
  } catch (error) {

    if (ticket) {
      QBApp.EndSession(ticket);
      // QBApp.CloseConnection();
    }

    responseMessage = error.message;
    responsePayload = new CommonResponsePayload(responseMessage, {});

    logger.error(responseMessage);
    logger.error("For company : " + req.body.qbCompanyConfigCode);

    res.status(400).send(responsePayload);
  }
}

exports.createInvoice = async (req, res) => {
  let ticket;
  let responsePayload;
  let responseMessage;

  try {
    const companyName = req.body.qbCompanyConfigCode;
    logger.info(`Request recieved of invoice batch size : ${req.body.invoiceList.length}`)
    const companyPath = readConfigFile.getCompanyPath(companyName);

    if (!companyPath) {
      logger.error(`Company File Path not found for ${companyName} in config.ini file`);
      responseMessage = `Company File Path not found for ${companyName} in config.ini file`
      responsePayload = new CommonResponsePayload(responseMessage, {});
      return res.status(400).send(responsePayload);
    }
    logger.info(`Successfully got the company path for ${companyName}`);

    let userMode = readConfigFile.getMultiUserMode() === true ? 1 : 0;

    // QBApp.OpenConnection('', appName);

    ticket = QBApp.BeginSession(companyPath, userMode);

    logger.info(`Session began for ${companyName}`);

    const templateName = readConfigFile.getTemplateName();
    let isTemplateExist = await checkTemplate(templateName, ticket);

    if (!isTemplateExist) {
      QBApp.EndSession(ticket);
      // QBApp.CloseConnection();

      responseMessage = `Template not found for company : ${companyName}, template name : ${templateName}`;
      logger.error(responseMessage);
      responsePayload = new CommonResponsePayload(responseMessage, {});
      return res.status(400).send(responsePayload);
    }

    logger.info("Successfully got the Template for " + req.body.qbCompanyConfigCode);

    let allInvoicesPayload = req.body.invoiceList;

    let reponseList = [];

    let taxesFromQB = await getAllSalesTaxFromQB(ticket);

    for (const invoicePayload of allInvoicesPayload) {

      logger.info(`Processing invoice for workOrderId : ${invoicePayload.workOrderId}`)
      try {
        let misMatchedTaxes = await validateSalesTax(invoicePayload, taxesFromQB);
        if (misMatchedTaxes.length > 0) {

          responseMessage = `Sales Tax does not match for company : ${companyName}`;
          logger.error(responseMessage);
          responsePayload = new CommonResponsePayload(responseMessage, { taxDetails: misMatchedTaxes });
          reponseList.push({
            message: responseMessage,
            workOrderId: invoicePayload.workOrderId,
            taxDetails: misMatchedTaxes,
            status: "FAILURE"
          })
          await insertOrUpdateInDBForFailure(invoicePayload.workOrderId, responseMessage, invoicePayload.invoiceDate, companyName)
        }
        else {
          logger.info(`Successfully validated tax for ${companyName}`);

          await validateOrCreateCustomer(invoicePayload, ticket, companyName);

          let invoiceResponse = await getItemAndProcessInvoice(invoicePayload, ticket, companyName);
          responseMessage = "Invoice created Successfully.";

          reponseList.push({
            ...invoiceResponse,
            message: responseMessage,
          });
        }

      } catch (error) {
        logger.error(error)
        let response = await insertOrUpdateInDBForFailure(invoicePayload.workOrderId, error.message, invoicePayload.invoiceDate, companyName)
        reponseList.push({
          ...response,
          message: error.message
        });
      }

    }

    logger.info("Deleting older DB records")
    await removeOldDBRecords();


    await QBApp.EndSession(ticket);
    // QBApp.CloseConnection();

    logger.info(`Session ended for ${companyName}`);

    responsePayload = new CommonResponsePayload("Invoice created", { invoicesResponse: reponseList });
    return res.status(201).send(responsePayload);
  } catch (err) {

    if (ticket) {
      try {
        QBApp.EndSession(ticket);
      } catch (e) {
        logger.error(e)
      }
      logger.info(`Session ended.`);
    }
    // QBApp.CloseConnection();

    responseMessage = err.message;
    logger.error(err)
    responsePayload = new CommonResponsePayload(responseMessage, {});
    return res.status(400).send(responsePayload);
  }
}

exports.createBillController = async (req, res) => {
  let ticket;
  let responsePayload;
  let responseMessage;

  try {
    const companyName = req.body.qbCompanyConfigCode;
    const companyPath = readConfigFile.getCompanyPath(companyName);

    if (!companyPath) {
      logger.error(`Company File Path not found for ${companyName} in config.ini file`);
      responseMessage = `Company File Path not found for ${companyName} in config.ini file`
      responsePayload = new CommonResponsePayload(responseMessage, {});
      return res.status(400).send(responsePayload);
    }
    logger.info(`Successfully got the company path for ${companyName}`);

    let userMode = readConfigFile.getMultiUserMode() === true ? 1 : 0;
    ticket = QBApp.BeginSession(companyPath, userMode);
    logger.info(`Session began for ${companyName}`);

    let bill = req.body;

    let reponseList = [];
    // for (const bill of allBill) {

      try {
        let billResponse = await processBill(bill, ticket, companyName);
        // responseMessage = "Bill created Successfully.";
        // // reponseList.push({
        // //   ...billResponse,
        // //   message: responseMessage,
        // // });
        // return res.status(201).send(billResponse);
      } catch (error) {
        logger.error(error)
        let response = await insertOrUpdateInDBForFailure(invoicePayload.poId, error.message, invoicePayload.billDate, companyName)
        reponseList.push({
          ...response,
          message: error.message
        });
      }

    // }

    logger.info("Deleting older DB records")
    await removeOldDBRecords();


    await QBApp.EndSession(ticket);
    // QBApp.CloseConnection();

    logger.info(`Session ended for ${companyName}`);

    responsePayload = new CommonResponsePayload("Invoice created", { invoicesResponse: reponseList });
    return res.status(201).send(responsePayload);
  } catch (err) {

    if (ticket) {
      try {
        QBApp.EndSession(ticket);
      } catch (e) {
        logger.error(e)
      }
      logger.info(`Session ended.`);
    }
    // QBApp.CloseConnection();

    responseMessage = err.message;
    logger.error(err)
    responsePayload = new CommonResponsePayload(responseMessage, {});
    return res.status(400).send(responsePayload);
  }
}