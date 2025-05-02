const readConfigFile = require("../util/configUtil");
const { logger } = require("../config/winstonConfig");
const { QBApp, appName } = require("../config/qbdConfig");
const { checkTemplate, validateSalesTax, validateOrCreateCustomer, getItemAndProcessInvoice, checkOrCreateNonTax, checkOrCreateSubtotalItem, checkOrCreateZeroSalesTaxCodes, checkOrCreateServiceItems, checkOrCreateIncomeAccounts, removeOldDBRecords, insertOrUpdateInDBForFailure, getAllSalesTaxFromQB, processBill, insertOrUpdateBillInDBForFailure } = require("../services/qbdService");
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
  let bill = req.body;
  const companyName = req.body.qbCompanyConfigCode;
  try {

    const validationErrors = validateBillPayload(bill);
    if (validationErrors.length > 0) {
      return res.status(400).send(new CommonResponsePayload(validationErrors[0], {}));
    }
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

    let billResponse = null;
    billResponse = await processBill(bill, ticket, companyName);


    logger.info("Deleting older DB records")
    await removeOldDBRecords();


    await QBApp.EndSession(ticket);
    // QBApp.CloseConnection();

    logger.info(`Session ended for ${companyName}`);

    responsePayload = new CommonResponsePayload("Bill Created", { billResponse: billResponse });
    return res.status(201).send(responsePayload);
  } catch (err) {
    await insertOrUpdateBillInDBForFailure(bill.poId, err.message, bill.billDate, companyName)
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

const validateBillPayload = (payload) => {
  const errors = [];
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const tenDigitMobileRegex = /^\+\d{10,12}$/;
  // Validate 'to' object
  if (!payload.to) {
    errors.push("'to' is required");
  } else {
    const toEmail = payload.to.contactPersonEmail;
    const toMobile = payload.to.contactPersonMobile;
    if (toEmail && !emailRegex.test(toEmail)) {
      errors.push("Invalid 'to.contactPersonEmail'");
    }
    if (!toMobile) {
      errors.push("'to.contactPersonMobile' is required");
    } else if (!tenDigitMobileRegex.test(toMobile)) {
      errors.push("Invalid 'to.contactPersonMobile'. It should be a 10-digit number without symbols or country code.");
    }
  }
  // Validate 'from' object
  if (!payload.from) {
    errors.push("'from' is required");
  } else {
    const fromEmail = payload.from.contactPersonEmail;
    const fromMobile = payload.from.contactPersonMobile;
    if (fromEmail && !emailRegex.test(fromEmail)) {
      errors.push("Invalid 'from.contactPersonEmail'");
    }
    if (fromMobile && !tenDigitMobileRegex.test(fromMobile)) {
      errors.push("Invalid 'from.contactPersonMobile'. It should be a 10-digit number");
    }
  }
  // Validate line items
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    errors.push("At least one line item is required");
  } else {
    payload.lines.forEach((line, index) => {
      const lineIndex = index + 1;
      // Amount validations
      if (line.amount == null || line.amount === "") {
        errors.push(`Line ${lineIndex}: 'amount' is required`);
      } else if (typeof line.amount === 'string' && /[a-zA-Z]/.test(line.amount)) {
        errors.push(`Line ${lineIndex}: 'amount' should not contain alphabets`);
      } else if (isNaN(line.amount)) {
        errors.push(`Line ${lineIndex}: 'amount' must be a valid number`);
      } else if (Number(line.amount) < 0) {
        errors.push(`Line ${lineIndex}: Negative amount not allowed`);
      } else if (Number(line.amount) === 0) {
        errors.push(`Line ${lineIndex}: 'amount' must be greater than zero`);
      }
      // Tax line validations
      if (line.taxLine) {
        const taxAmount = line.taxLine.amount;
        if (taxAmount == null || taxAmount === "") {
          errors.push(`Line ${lineIndex}: 'taxLine.amount' is required`);
        } else if (typeof taxAmount === 'string' && /[a-zA-Z]/.test(taxAmount)) {
          errors.push(`Line ${lineIndex}: 'taxLine.amount' should not contain alphabets`);
        } else if (isNaN(taxAmount)) {
          errors.push(`Line ${lineIndex}: 'taxLine.amount' must be a valid number`);
        } else if (Number(taxAmount) < 0) {
          errors.push(`Line ${lineIndex}: Negative tax amount not allowed`);
        } else if (Number(taxAmount) === 0) {
          errors.push(`Line ${lineIndex}: 'taxLine.amount' must be greater than zero`);
        }
      }
    });
  }
  return errors;
};
