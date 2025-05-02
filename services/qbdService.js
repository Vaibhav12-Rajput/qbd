const xmlPayloads = require("../constant/xmlPayloads");
const { QBApp } = require("../config/qbdConfig");
const { convertXmlToJson, jsonToXml } = require("../util/xmlUtil");
const { logger } = require("../config/winstonConfig");
const readConfig = require("../util/configUtil");
const qbdConstants = require("../constant/qbdConstants");
const { ensureArray } = require("../util/commonUtil");
const { db } = require("../config/nedbConfig");
const neDbConstant = require("../constant/neDbConstant");
const STATUS_CODES = {
  ZERO: "0",
  ONE: "1",
};


const sendRequestToQBD = async (xmlRequest, ticket) => {
  const response = QBApp.ProcessRequest(ticket, xmlRequest);
  return response
}

const checkTemplate = async (templateName, ticket) => {
  const resultOfTemplate = await sendRequestToQBD(xmlPayloads.templateQuery, ticket);
  const resultofTemplateJson = convertXmlToJson(resultOfTemplate);
  if (resultofTemplateJson.QBXML.QBXMLMsgsRs.TemplateQueryRs.$.statusCode == STATUS_CODES.ZERO && ensureArray(resultofTemplateJson.QBXML.QBXMLMsgsRs.TemplateQueryRs.TemplateRet).find(template => template.Name == templateName))
    return true;
  return false;

}

const validateSalesTax = async (invoice, taxesFromQB) => {

  const taxesFromInvoice = prepareTaxListForValidation(invoice);

  const onlyActiveItems = taxesFromQB.filter(tax => tax.IsActive == "true");
  const mismatchedTaxes = findMismatchedTaxes(taxesFromInvoice, onlyActiveItems)

  return mismatchedTaxes;

}

const getAllSalesTaxFromQB = async (ticket) => {
  const result = await sendRequestToQBD(xmlPayloads.salesTaxQuery, ticket);
  const resultInJson = convertXmlToJson(result);
  if (resultInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxQueryRs.$.statusCode == STATUS_CODES.ZERO) {
    return ensureArray(resultInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxQueryRs.ItemSalesTaxRet);
  }
  else if (resultInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxQueryRs.$.statusCode == STATUS_CODES.ONE) {
    throw new Error("No Sales Tax found in QuickBooks company");
  }
  throw new Error(`Exception from QuickBooks while fetching sales tax. Error: ${resultInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxQueryRs.$.statusMessage}`)
}

const findMismatchedTaxes = (invoiceTaxes, qbTaxes) => {
  const mismatchedTaxes = [];
  for (const invTax of invoiceTaxes) {
    const qbTax = qbTaxes.find(tax => tax.Name === invTax.code);
    if (!qbTax) {
      mismatchedTaxes.push({
        name: invTax.name,
        code: invTax.code,
        tax: parseFloat(invTax.tax).toFixed(2) + " %",
        description: `${invTax.code} not found in QuickBooks, please create the tax item in QB or correct the Fixy tax header same as existing QB tax item.`,
      });
    } else if (parseFloat(invTax.tax) !== parseFloat(qbTax.TaxRate)) {
      mismatchedTaxes.push({
        name: invTax.name,
        code: invTax.code,
        tax: parseFloat(invTax.tax).toFixed(2) + " %",
        taxInQB: parseFloat(qbTax.TaxRate).toFixed(2) + " %",
        description: "FleetFixy tax rate does not match with QuickBooks tax rate, please correct it and match it appropriately.",
      });
    }
  }
  return mismatchedTaxes;
};

const prepareTaxListForValidation = (invoice) => {
  let taxes = [];
  taxes.push(...invoice.partsTax);
  if (invoice.laborTaxSameAsPart == false && invoice.laborTaxPercentage)
    taxes.push({
      "name": "Labor Tax",
      "code": "Labor Tax",
      "tax": invoice.laborTaxPercentage,
      "taxAmount": invoice.laborTax
    });
  return taxes;
}

const validateOrCreateCustomer = async (invoice, ticket, companyName) => {

  const customerXmlRequest = xmlPayloads.findCustomerByNameQuery.replace("customerName", prepareStringForXML(invoice.to.name))


  const result = await sendRequestToQBD(customerXmlRequest, ticket);
  const resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.CustomerQueryRs.$.statusCode != STATUS_CODES.ZERO) {
    await createCustomer(invoice, ticket, companyName);
    logger.info("Customer created successfully for " + companyName);
  } else {
    logger.info("Customer found successfully for " + companyName);
  }
}

const createCustomer = async (invoice, ticket, companyName) => {

  const xmlRequest = createCustomerPaylod(invoice);
  const result = await sendRequestToQBD(xmlRequest, ticket);
  const resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.CustomerAddRs.$.statusCode != STATUS_CODES.ZERO)
    throw new Error(`Exception while creating customer for ${companyName}. Exception : ${resultInJson.QBXML.QBXMLMsgsRs.CustomerAddRs.$.statusMessage}`);

}

const createCustomerPaylod = (invoice) => {
  let customerPayload = {
    QBXML: {
      QBXMLMsgsRq: {
        $: {
          onError: "stopOnError"
        },
        CustomerAddRq: {
          CustomerAdd: {
            Name: invoice.to.name,
            IsActive: STATUS_CODES.ONE,
            BillAddress: {
              Addr1: invoice.to.address.line1,
              Addr2: invoice.to.address.line2,
              Addr3: invoice.to.address.line3,
              City: invoice.to.address.city,
              State: invoice.to.address.state,
              PostalCode: invoice.to.address.zipcode,
              Country: invoice.to.address.country
            },
            ShipAddress: {
              Addr1: invoice.to.address.line1,
              Addr2: invoice.to.address.line2,
              Addr3: invoice.to.address.line3,
              City: invoice.to.address.city,
              State: invoice.to.address.state,
              PostalCode: invoice.to.address.zipcode,
              Country: invoice.to.address.country
            },
            Phone: invoice.to.mobilePhone,
            Email: invoice.to.email
          },
        },
      }
    }
  }
  return jsonToXml(customerPayload);
}

const getItemAndProcessInvoice = async (invoice, ticket, companyName) => {

  let invTxnIdToDelete;
  let oldInvoiceFound;

  let oldInvoiceRecord = await db.findOneAsync({ workOrderId: invoice.workOrderId, qbCompanyConfigCode: companyName });

  let existingQbInvoiceNumber = oldInvoiceRecord ? oldInvoiceRecord.qbInvoiceNumber : invoice.qbInvoiceNumber;

  if (existingQbInvoiceNumber) {
    logger.info("Invoice creating again.")
    if (oldInvoiceRecord && oldInvoiceRecord.invoiceTxnId) {
      invTxnIdToDelete = oldInvoiceRecord.invoiceTxnId;
      logger.info(`Picked invTxnIdToDelete from db : ${invTxnIdToDelete} for workOrderId : ${invoice.workOrderId} and qbInvoiceNumber : ${existingQbInvoiceNumber}`)
    }
    else {
      const invoiceQueryRq = xmlPayloads.getInvoiceByRefNumberQuery.replace("REF_NUMBER", prepareStringForXML(existingQbInvoiceNumber));
      const invoiceResponse = await sendRequestToQBD(invoiceQueryRq, ticket);
      const invoiceResponseInJson = convertXmlToJson(invoiceResponse);

      if (invoiceResponseInJson.QBXML.QBXMLMsgsRs.InvoiceQueryRs.$.statusCode == STATUS_CODES.ZERO) {
        invTxnIdToDelete = invoiceResponseInJson.QBXML.QBXMLMsgsRs.InvoiceQueryRs.InvoiceRet.TxnID;

        if (!invTxnIdToDelete && Array.isArray(invoiceResponseInJson.QBXML.QBXMLMsgsRs.InvoiceQueryRs.InvoiceRet)) {

          let filteredInvoice = invoiceResponseInJson.QBXML.QBXMLMsgsRs.InvoiceQueryRs.InvoiceRet.filter(inv => inv.FOB == invoice.workOrderId)

          if (filteredInvoice.length > 1) {
            logger.info(`Duplicate invoices found for qbInvoiceNumber : ${existingQbInvoiceNumber}`)
          } else {
            invTxnIdToDelete = filteredInvoice[0].TxnID;
          }
        } else {
          logger.info(`Invoice found for qbInvoiceNumber : ${existingQbInvoiceNumber}, invoice transaction id : ${invTxnIdToDelete}`)
        }
      }
      else {
        logger.error(`Old Invoice not found for qbInvoiceNumber : ${existingQbInvoiceNumber}`);
        oldInvoiceFound = false;
        // Below line is commented for not breaking the process when old invoice is not found for delete.
        // throw new Error(`Invoice not found for qbInvoiceNumber : ${invoice.qbInvoiceNumber}`)
      }
    }

  }

  let { invoiceRefNumber, invoiceTxnId } = await createInvoice(invoice, ticket, companyName);

  let status = "";

  if (invTxnIdToDelete) {
    status = await deleteOldInvoice(invTxnIdToDelete, ticket);
  }
  else if (existingQbInvoiceNumber && !invTxnIdToDelete) {
    status = oldInvoiceFound == false ? "OLD INVOICE NOT FOUND" : "DUPLICATE OLD INVOICES FOUND"
  } else {
    status = "CREATED"
  }

  oldInvoiceRecord = await insertOrUpdateInDBForSuccess(invoice.workOrderId, invoiceRefNumber, status, invoice.invoiceDate, invoiceTxnId, companyName);
  await db.compactDatafileAsync();
  return oldInvoiceRecord;
}

const prepareParts = (parts) => {
  const items = [];
  parts.forEach(element => {
    items.push({
      ItemRef: {
        FullName: qbdConstants.itemConstatnts.FIXY_QB + ":" + qbdConstants.itemConstatnts.PARTS,
      },
      Desc: `${element.name} ($ ${parseFloat(element.sellingPrice).toFixed(2)} * ${element.quantity}${element.unit})`,
      Quantity: element.quantity,
      // UnitOfMeasure: element.unit,
      Rate: parseFloat(element.sellingPrice).toFixed(2),
      SalesTaxCodeRef: {
        // FullName: readConfig.getTaxCodeDetails().taxableItemCode,
        FullName: qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE,
      }
    })
  });
  return items;
}

const prepareMiscCharges = (miscCharges) => {
  const items = [];
  miscCharges.forEach(element => {
    items.push({
      ItemRef: {
        FullName: qbdConstants.itemConstatnts.FIXY_QB + ":" + qbdConstants.itemConstatnts.MISC_CHARGES,
      },
      Desc: `${element.name}`,
      Amount: parseFloat(element.totalAmount).toFixed(2),
      SalesTaxCodeRef: {
        // FullName: readConfig.getTaxCodeDetails().taxableItemCode,
        FullName: qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE,
      }
    })
  });
  return items;
}

const prepareSubtotal = (desc) => {
  return {
    ItemRef: {
      FullName: qbdConstants.subTotalConstants.SUB_TOTAL,
    },
    Desc: desc,
  }
}

const prepareLabor = (labors) => {
  const items = [];
  labors.forEach(element => {
    items.push({
      ItemRef: {
        FullName: qbdConstants.itemConstatnts.FIXY_QB + ":" + qbdConstants.itemConstatnts.LABORS,
      },
      Desc: `${element.name} ($${parseFloat(element.laborPerHour).toFixed(2)} x ${element.hours} hrs.)`,
      Quantity: element.hours,
      // UnitOfMeasure: element.unit,
      Rate: parseFloat(element.laborPerHour).toFixed(2),
      SalesTaxCodeRef: {
        // FullName: readConfig.getTaxCodeDetails().taxableItemCode,
        FullName: qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE,
      }
    })
  });
  return items;
}

const prepareDisposalTaxes = (disposalTaxes) => {
  const items = [];
  disposalTaxes.forEach(element => {
    items.push({
      ItemRef: {
        FullName: qbdConstants.itemConstatnts.FIXY_QB + ":" + qbdConstants.itemConstatnts.DISPOSAL_TAX,
      },
      Desc: `${element.name} ($${parseFloat(element.feeAmount).toFixed(2)} x ${element.quantity} ${element.unit})`,
      Quantity: element.quantity,
      // UnitOfMeasure: element.unit,
      Rate: parseFloat(element.feeAmount).toFixed(2),
      SalesTaxCodeRef: {
        // FullName: readConfig.getTaxCodeDetails().nonTaxableItemCode,
        FullName: qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE,
      }
    })
  });
  return items;
}

const prepareTax = (tax) => {
  return {
    ItemRef: {
      FullName: tax.code,
    },
    Desc: tax.code,
  }
}

const prepareLaborTax = () => {
  return {
    ItemRef: {
      FullName: "Labor Tax",
    },
    Desc: "Labor Tax",
  }
}

const prepareLineItems = (invoice) => {

  const { parts, miscCharges, labors, disposalTaxes } = getItems(invoice);

  const lineItems = [];
  if (parts.length > 0) {
    lineItems.push(...prepareParts(parts));
  }
  if (miscCharges.length > 0) {
    lineItems.push(...prepareMiscCharges(miscCharges));
  }
  if (disposalTaxes.length) {
    lineItems.push(...prepareDisposalTaxes(disposalTaxes));
  }
  if (invoice.laborTaxSameAsPart && labors.length > 0) {
    lineItems.push(...prepareLabor(labors));
  }
  if (lineItems.length > 0) {
    lineItems.push(prepareSubtotal(qbdConstants.subTotalConstants.PARTS_SUB_TOTAL));
    invoice.partsTax.forEach(tax => {
      lineItems.push(prepareTax(tax));
      lineItems.push(prepareSubtotal(tax.code + " " + qbdConstants.subTotalConstants.SUB_TOTAL));
    })
  }
  if (invoice.laborTaxSameAsPart == false && labors.length > 0) {
    lineItems.push(...prepareLabor(labors));
    lineItems.push(prepareSubtotal(qbdConstants.subTotalConstants.LABOR_SUB_TOTAL));
    if (invoice.laborTaxPercentage > 0) {
      lineItems.push(prepareLaborTax());
      lineItems.push(prepareSubtotal(qbdConstants.subTotalConstants.LABOR_TAX_SUB_TOTAL));
    }
  }
  // lineItems.push(prepareSubtotal(qbdConstants.subTotalConstants.DISPOSAL_SUB_TOTAL));
  return lineItems;
}

const prepareInvoice = (lineItems, invoice) => {
  const preparedInvoice = {
    QBXML: {
      QBXMLMsgsRq: {
        $: {
          onError: "stopOnError",
        },
        InvoiceAddRq: {
          InvoiceAdd: {
            CustomerRef: {
              FullName: invoice.to.name,
            },
            // ARAccountRef: {
            //   ListID: "40000-933270541",
            //   FullName: "Accounts Receivable",
            // },
            TemplateRef: {
              FullName: readConfig.getTemplateName(),
            },
            TxnDate: invoice.invoiceDate,
            RefNumber: invoice.workOrderId,
            BillAddress: {
              Addr1: invoice.to.address.line1,
              Addr2: invoice.to.address.line2,
              City: invoice.to.address.city,
              State: invoice.to.address.state,
              PostalCode: invoice.to.address.zipcode,
              Country: invoice.to.address.country,
            },
            ShipAddress: {
              Addr1: invoice.to.address.line1,
              Addr2: invoice.to.address.line2,
              City: invoice.to.address.city,
              State: invoice.to.address.state,
              PostalCode: invoice.to.address.zipcode,
              Country: invoice.to.address.country,
              // Note: "Test Note",
            },
            IsPending: false,
            IsFinanceCharge: "false",
            PONumber: invoice.mileage,
            TermsRef: {
              FullName: readConfig.getTerms()
            },
            FOB: invoice.workOrderId,
            // ItemSalesTaxRef: {
            //   FullName: "Zero Sales Tax",
            // },
            // Memo: "",
            CustomerSalesTaxCodeRef: {
              FullName: qbdConstants.TAX_CODES.ZERO_NON_SALES_TAX_CODE,
            },
            Other: invoice.vehicleInfo ? invoice.vehicleInfo.substring(0, 29) : "",
            InvoiceLineAdd: lineItems,
          },
        },
      },
    },
  }
  if (readConfig.getKeepQBInvoiceNumber() === true) {
    delete preparedInvoice.QBXML.QBXMLMsgsRq.InvoiceAddRq.InvoiceAdd.RefNumber;
  }
  return preparedInvoice;
}

const prepareItemToCreate = (itemName, incomeAccountName, cogsAccountName, assetAccountName, salestaxCodeName) => {

  return {
    "QBXML": {
      "QBXMLMsgsRq": {
        "$": {
          "onError": "stopOnError"
        },
        "ItemInventoryAddRq": {
          "$": {
            "requestID": "2"
          },
          "ItemInventoryAdd": {
            "Name": itemName,
            "SalesTaxCodeRef": {
              "FullName": salestaxCodeName,
            },
            "IncomeAccountRef": {
              "FullName": incomeAccountName
            },
            "COGSAccountRef": {
              "FullName": cogsAccountName,
            },
            "AssetAccountRef": {
              "FullName": assetAccountName
            }
          }
        }
      }
    }
  }
}

const getItems = (invoice) => {
  // Initialize arrays to collect different types of items
  const parts = [];
  const labors = [];
  const miscCharges = [];
  const disposalTaxes = [];

  // Iterate over invoice lines to extract and categorize items
  invoice.lines.forEach(line => {
    // Process parts
    line.parts.forEach(part => {
      part.name = `${line.item} ${qbdConstants.lineItemConstants.PART} - ${part.name}`
      parts.push(part);
    });

    // Process labors
    line.labors.forEach(labor => {
      labor.name = `${line.item} ${qbdConstants.lineItemConstants.LABOR} - ${labor.name}`;
      labors.push(labor);
    })

    // Process misc charges
    line.miscCharges.forEach(miscCharge => {
      miscCharge.name = `${line.item} ${qbdConstants.lineItemConstants.MISC_CHARGES} - ${miscCharge.name}`
      miscCharges.push(miscCharge);
    })

    // Process disposal tax
    line.disposalFees.forEach(disposalTax => {
      disposalTax.name = `${line.item} ${qbdConstants.lineItemConstants.DISPOSAL_TAX} - ${disposalTax.name}`
      disposalTaxes.push(disposalTax);
    })
  });

  const items = {
    parts: parts,
    labors: labors,
    miscCharges: miscCharges,
    disposalTaxes: disposalTaxes
  }
  return items;
}

const checkOrCreateItems = async (ticket) => {

  let findAllItems = xmlPayloads.findAllItemQuery;
  let result = await sendRequestToQBD(findAllItems, ticket);
  let resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.ItemInventoryQueryRs.$.statusCode != STATUS_CODES.ZERO &&
    resultInJson.QBXML.QBXMLMsgsRs.ItemInventoryQueryRs.$.statusCode != STATUS_CODES.ONE)
    throw new Error("Company got connected but exception while finding items. Error : " + resultInJson.QBXML.QBXMLMsgsRs.ItemInventoryQueryRs.$.statusMessage)

  // Extract existing items from the response
  let itemsInQBD = ensureArray(resultInJson.QBXML.QBXMLMsgsRs.ItemInventoryQueryRs.ItemInventoryRet);

  let items = [qbdConstants.itemConstatnts.PARTS, qbdConstants.itemConstatnts.LABORS, qbdConstants.itemConstatnts.MISC_CHARGES, qbdConstants.itemConstatnts.DISPOSAL_TAX];

  let itemsFromSecondList = itemsInQBD?.map(
    (item) => item.Name
  );

  let itemsToCreate = items.filter((item) => !itemsFromSecondList?.includes(item));

  await Promise.all(itemsToCreate.map(async (item) => {
    const accounts = readConfig.getAccounts();
    let itemToCreate = prepareItemToCreate(item, accounts.incomeAccountName, accounts.cogsAccountName, accounts.assetAccountName, item == qbdConstants.itemConstatnts.DISPOSAL_TAX ? qbdConstants.TAX_CODES.ZERO_NON_SALES_TAX_CODE : qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE);
    let itemsToCreateInXML = jsonToXml(itemToCreate);
    result = await sendRequestToQBD(itemsToCreateInXML, ticket);
    resultInJson = convertXmlToJson(result);

    if (resultInJson.QBXML.QBXMLMsgsRs.ItemInventoryAddRs.$.statusCode != STATUS_CODES.ZERO)
      throw new Error("Company got connected but exception while creating item. Error : " + resultInJson.QBXML.QBXMLMsgsRs.ItemInventoryAddRs.$.statusMessage)
    logger.info(item + " created Successfully");
  }))
}

const checkOrCreateNonTax = async (ticket) => {
  // Prepare a request to find the Zero Sales Tax item
  let salesTaxQuery = xmlPayloads.findSalesTaxByNameQuery;
  salesTaxQuery = salesTaxQuery.replace("SALES_TAX_NAME", prepareStringForXML(qbdConstants.ZERO_SALES_TAX));


  let salesTaxResponse = await sendRequestToQBD(salesTaxQuery, ticket);
  let salesTaxResponseJson = convertXmlToJson(salesTaxResponse);

  // Check if the Zero Sales Tax item was not found, and create it if necessary
  if (salesTaxResponseJson.QBXML.QBXMLMsgsRs.ItemSalesTaxQueryRs.$.statusCode == STATUS_CODES.ONE) {
    logger.info("Zero Sales Tax Item not found.")
    logger.info("Creating Zero Sales Tax Item.")
    await createNonSalesTax(ticket);
  }
}

const createNonSalesTax = async (ticket) => {
  let createSalesTaxQuery = xmlPayloads.createSalesTaxQuery;
  let taxVendorName = readConfig.getTaxVendorName();
  let salexTaxReturnLine = readConfig.getSalexTaxReturnLine();

  // if (!salexTaxReturnLine) {
  //   logger.error("Company got connected but exception while creating sales tax item. Error : salexTaxReturnLine is not found in config.ini file.")
  //   throw new Error("Company got connected but exception while creating sales tax item. Error : salexTaxReturnLine is not found in config.ini file.")
  // }

  if (!taxVendorName) {
    logger.error("Company got connected but exception while creating sales tax item. Error : taxVendorName is not found in config.ini file.")
    throw new Error("Company got connected but exception while creating sales tax item. Error : taxVendorName is not found in config.ini file.")
  }

  createSalesTaxQuery = createSalesTaxQuery.replace("SALES_TAX_NAME", prepareStringForXML(qbdConstants.ZERO_SALES_TAX))
    .replace("SALES_TAX_DESC", "Zero Sales Tax for 0 %")
    .replace("SALES_TAX_RATE", STATUS_CODES.ZERO)
    .replace("SALES_TAX_VENDOR_NAME", prepareStringForXML(taxVendorName))
    .replace("SALES_TAX_RETURN_LINE", prepareStringForXML(salexTaxReturnLine));

  let responseXML = await sendRequestToQBD(createSalesTaxQuery, ticket);
  let responseInJson = convertXmlToJson(responseXML);

  if (responseInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxAddRs.$.statusCode != STATUS_CODES.ZERO) {
    logger.error("Exception while creating zero sales tax item. Exception : " + responseInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxAddRs.$.statusMessage)
    throw new Error("Company got connected but exception while creating zero sales tax item. Error : " + responseInJson.QBXML.QBXMLMsgsRs.ItemSalesTaxAddRs.$.statusMessage)
  }
  logger.info("Zero Sales Tax Item created successfully.")
}

const checkOrCreateSubtotalItem = async (ticket) => {
  let subtotalQuery = xmlPayloads.subtotalQuery.replace("SUBTOTAL_ITEM_NAME", prepareStringForXML(qbdConstants.subTotalConstants.SUB_TOTAL));
  let responseXML = await sendRequestToQBD(subtotalQuery, ticket);
  let responseInJson = convertXmlToJson(responseXML);

  // Check if the Subtotal item was not found, and create it if necessary
  if (responseInJson.QBXML.QBXMLMsgsRs.ItemSubtotalQueryRs.$.statusCode != STATUS_CODES.ZERO) {
    logger.info("Creating Subtotal item.")

    // Prepare a request to create the Subtotal item
    let createSubtotalItemQuery = xmlPayloads.createSubtotalItemQuery.replace("SUBTOTAL_ITEM_NAME", prepareStringForXML(qbdConstants.subTotalConstants.SUB_TOTAL));
    let subtotalCreateResp = await sendRequestToQBD(createSubtotalItemQuery, ticket);
    let subtotalCreateRespJson = convertXmlToJson(subtotalCreateResp);

    // Check if the creation was successful
    if (subtotalCreateRespJson.QBXML.QBXMLMsgsRs.ItemSubtotalAddRs.$.statusCode != STATUS_CODES.ZERO) {
      logger.error("Company got connected but exception while creating subtotal item. Error : " + subtotalCreateRespJson.QBXML.QBXMLMsgsRs.ItemSubtotalAddRs.$.statusMessage);
      throw new Error("Company got connected but exception while creating subtotal item. Error : " + subtotalCreateRespJson.QBXML.QBXMLMsgsRs.ItemSubtotalAddRs.$.statusMessage)
    }
    logger.info("Subtotal item creted successfully.")
  }
}

const checkOrCreateZeroSalesTaxCodes = async (ticket) => {
  //check or create zero sales tax code 
  await checkSalesTaxCode(ticket, qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE);

  //check or create zero sales tax code 
  await checkSalesTaxCode(ticket, qbdConstants.TAX_CODES.ZERO_NON_SALES_TAX_CODE);
}

const checkSalesTaxCode = async (ticket, code) => {
  let salesTaxCodeQuery = xmlPayloads.salesTaxCodeQuery;
  let responseXML = await sendRequestToQBD(salesTaxCodeQuery, ticket);
  let responseInJson = convertXmlToJson(responseXML);

  if ((responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeQueryRs.$.statusCode != STATUS_CODES.ZERO) ||
    (responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeQueryRs.$.statusCode == STATUS_CODES.ZERO &&
      ensureArray(responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeQueryRs.SalesTaxCodeRet).find(salestaxCode => salestaxCode.Name == code) == undefined)) {
    logger.info(`Zero Sales Tax code not found: ${code}`)
    logger.info(`Creating Zero Sales tax code :  ${code}`)
    await createZeroSalesTaxCode(ticket, code);
    return;
  }
}

const createZeroSalesTaxCode = async (ticket, code) => {

  // Prepare a request to create the zero sales tax code
  let createSalesTaxCodeQuery = xmlPayloads.createSalesTaxCodeQuery.replace("SALES_TAX_CODE_NAME", prepareStringForXML(code))
    .replace("SALES_TAX_CODE_DESC", code == qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE ? "Zero Sales Tax Code" : "Zero Non Sales Tax Code")
    .replace("IS_TAXABLE", code == qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE ? true : false);

  // Customize the XML payload based on the code type
  if (code == qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE) {
    createSalesTaxCodeQuery = createSalesTaxCodeQuery.replace("ITEM_SALES_TAX_REF_SNIPPET", `<ItemSalesTaxRef>  <FullName >${prepareStringForXML(qbdConstants.ZERO_SALES_TAX)}</FullName> </ItemSalesTaxRef>`)
  }
  else {
    createSalesTaxCodeQuery = createSalesTaxCodeQuery.replace("ITEM_SALES_TAX_REF_SNIPPET", "");
  }

  let responseXML = await sendRequestToQBD(createSalesTaxCodeQuery, ticket);
  let responseInJson = convertXmlToJson(responseXML);

  if (responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeAddRs.$.statusCode != STATUS_CODES.ZERO && responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeAddRs.$.statusCode != "530") {
    logger.error("Company got connected but exception while creating zero sales tax code. Error : " + responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeAddRs.$.statusMessage);
    throw new Error("Company got connected but exception while creating zero sales tax code. Error : " + responseInJson.QBXML.QBXMLMsgsRs.SalesTaxCodeAddRs.$.statusMessage)
  }
  logger.info("Zero Sales tax code created successfully.")
}


const checkOrCreateServiceItems = async (ticket) => {

  let serviceItemList = [qbdConstants.itemConstatnts.FIXY_QB, qbdConstants.itemConstatnts.PARTS, qbdConstants.itemConstatnts.MISC_CHARGES, qbdConstants.itemConstatnts.DISPOSAL_TAX, qbdConstants.itemConstatnts.LABORS];

  let serviceItemQuery = xmlPayloads.serviceItemQuery;
  let responseXML = await sendRequestToQBD(serviceItemQuery, ticket);
  let responseInJson = convertXmlToJson(responseXML);
  let serviceItemToCreate = [];

  if (responseInJson.QBXML.QBXMLMsgsRs.ItemServiceQueryRs.$.statusCode == STATUS_CODES.ZERO) {
    if (Array.isArray(responseInJson.QBXML.QBXMLMsgsRs.ItemServiceQueryRs.ItemServiceRet)) {
      serviceItemToCreate = serviceItemList.filter(serviceItem => {
        return !responseInJson.QBXML.QBXMLMsgsRs.ItemServiceQueryRs.ItemServiceRet.find(sI => (serviceItem != qbdConstants.itemConstatnts.FIXY_QB ? qbdConstants.itemConstatnts.FIXY_QB + ":" + serviceItem : serviceItem) == sI.FullName)
      });
    }
    else {
      serviceItemToCreate = serviceItemList.filter(serviceItem => (serviceItem != qbdConstants.itemConstatnts.FIXY_QB ? qbdConstants.itemConstatnts.FIXY_QB + ":" + serviceItem : serviceItem) != responseInJson.QBXML.QBXMLMsgsRs.ItemServiceQueryRs.ItemServiceRet.FullName);
    }
  } else if (responseInJson.QBXML.QBXMLMsgsRs.ItemServiceQueryRs.$.statusCode == STATUS_CODES.ONE) {
    serviceItemToCreate = serviceItemList
  }

  logger.info(`Service items to create : ${serviceItemToCreate}`,)

  if (serviceItemToCreate.length) {
    await createServiceItems(serviceItemToCreate, ticket);
  }

}


const createServiceItems = async (serviceItemToCreate, ticket) => {
  logger.info("Creating service items")
  await Promise.all(serviceItemToCreate.map(async (item) => {
    let serviceItemPayloadJson = prepareServiceItemToCreate(item, item != qbdConstants.itemConstatnts.LABORS ? qbdConstants.accounts.PARTS_AND_MATERIALS_ACCOUNT : qbdConstants.accounts.SERVICE_INCOME_ACCOUNT, "", item != qbdConstants.itemConstatnts.FIXY_QB ? true : false);
    let serviceItemPayloadXML = jsonToXml(serviceItemPayloadJson);
    let responseXML = await sendRequestToQBD(serviceItemPayloadXML, ticket);
    let responseInJson = convertXmlToJson(responseXML);
    if (responseInJson.QBXML.QBXMLMsgsRs.ItemServiceAddRs.$.statusCode != STATUS_CODES.ZERO) {
      logger.error("Company got connected but exception while creating service items. Error : " + responseInJson.QBXML.QBXMLMsgsRs.ItemServiceAddRs.$.statusMessage);
      throw new Error("Company got connected but exception while creating service items. Error : " + responseInJson.QBXML.QBXMLMsgsRs.ItemServiceAddRs.$.statusMessage)
    }
  }))
  logger.info("Service items created successfully.")
}


const prepareServiceItemToCreate = (itemName, accountName, desc, isChild) => {

  if (!isChild) {
    return {
      "QBXML": {
        "QBXMLMsgsRq": {
          "$": {
            "onError": "stopOnError"
          },
          "ItemServiceAddRq": {
            "$": {
              "requestID": "2"
            },
            "ItemServiceAdd": {
              "Name": itemName,
              "SalesTaxCodeRef": {
                "FullName": qbdConstants.TAX_CODES.ZERO_NON_SALES_TAX_CODE,
              },
              "SalesOrPurchase": {
                "Desc": desc,
                "AccountRef": {
                  "FullName": accountName
                }
              }
            }
          }
        }
      }
    }
  }
  else {
    return {
      "QBXML": {
        "QBXMLMsgsRq": {
          "$": {
            "onError": "stopOnError"
          },
          "ItemServiceAddRq": {
            "$": {
              "requestID": "2"
            },
            "ItemServiceAdd": {
              "Name": itemName,
              "ParentRef": {
                "FullName": qbdConstants.itemConstatnts.FIXY_QB
              },
              "SalesTaxCodeRef": {
                "FullName": qbdConstants.TAX_CODES.ZERO_SALES_TAX_CODE,
              },
              "SalesOrPurchase": {
                "Desc": desc,
                "AccountRef": {
                  "FullName": accountName
                }
              }
            }
          }
        }
      }
    }
  }
}

const checkOrCreateIncomeAccounts = async (ticket) => {
  // List of income accounts to check or create
  let accountsList = [qbdConstants.accounts.PARTS_AND_MATERIALS_ACCOUNT, qbdConstants.accounts.SERVICE_INCOME_ACCOUNT];

  await Promise.all(accountsList.map(async account => {
    let accountQuery = xmlPayloads.findAccountsByNameQuery.replace("ACCOUNT_NAME", prepareStringForXML(account));
    logger.info(`[QBD] Sending AccountQuery for "${account}": ${accountQuery}`);
    let response = await sendRequestToQBD(accountQuery, ticket);
    logger.info(`[QBD] Response for AccountQuery of "${account}": ${response}`);
    let responseInJson = convertXmlToJson(response);
    if (responseInJson.QBXML.QBXMLMsgsRs.AccountQueryRs.$.statusCode != STATUS_CODES.ZERO) {
      await createIncomeAccount(account, ticket)
    }
  }));
}


const createIncomeAccount = async (accountName, ticket) => {
  logger.info(`Creating account : ${accountName}`)

  let createAccountQuery = xmlPayloads.createAccountQuery.replace("ACCOUNT_NAME", prepareStringForXML((accountName))).replace("ACCOUNT_TYPE", "Income");
  // let createAccountQuery = '<?xml version="1.0" encoding="utf-8"?> <?qbxml version="16.0"?> <QBXML> <QBXMLMsgsRq onError="stopOnError"> <AccountAddRq> <AccountAdd> <Name >ACCOUNT_NAME</Name> <AccountType >Expense</AccountType> <Desc ></Desc> </AccountAdd> </AccountAddRq> </QBXMLMsgsRq> </QBXML>';

  let response = await sendRequestToQBD(createAccountQuery, ticket);
  let responseInJson = convertXmlToJson(response);

  if (responseInJson.QBXML.QBXMLMsgsRs.AccountAddRs.$.statusCode != STATUS_CODES.ZERO) {
    logger.error("Company got connected but exception while creating accounts. Error : " + responseInJson.QBXML.QBXMLMsgsRs.ItemServiceAddRs.$.statusMessage);
    throw new Error("Company got connected but exception while creating accounts. Error : " + responseInJson.QBXML.QBXMLMsgsRs.ItemServiceAddRs.$.statusMessage)
  }
  logger.info(`Accounts created successfully :${accountName}`)
}

const prepareStringForXML = (str) => {
  return str.replaceAll('<', '&lt;')
    .replaceAll('&', '&amp;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&apos;')
    .replaceAll('"', '&quot;');
}

const removeOldDBRecords = async () => {

  const currentDate = new Date();

  let nedbDataRetentionDays = readConfig.getNedbDataRetentionDays();
  nedbDataRetentionDays = nedbDataRetentionDays ? nedbDataRetentionDays : neDbConstant.threeSixtyFive;

  let dateOfRetentionData = new Date();
  dateOfRetentionData.setDate(currentDate.getDate() - nedbDataRetentionDays);

  let condition = { qBInvoiceProcessingDate: { $lt: new Date(dateOfRetentionData) } };

  const numRemoved = await db.removeAsync(condition, { multi: true });

  logger.info(`Total no of records deleted from db ${numRemoved}`);
  await db.compactDatafileAsync();

}

const insertOrUpdateInDBForFailure = async (workOrderId, errorMessage, invoiceDate, qbCompanyConfigCode) => {

  let oldInvoiceRecord = await db.findOneAsync({ workOrderId: workOrderId, qbCompanyConfigCode: qbCompanyConfigCode });

  let response;

  if (oldInvoiceRecord) {
    response = await db.updateAsync({ workOrderId: oldInvoiceRecord.workOrderId, qbCompanyConfigCode: qbCompanyConfigCode }, {
      $set: {
        status: "FAILURE",
        invoiceDate: new Date(invoiceDate),
        qBInvoiceProcessingDate: new Date(),
        errorMessage: errorMessage
      }
    }, { returnUpdatedDocs: true })
    logger.info(`Record updated in db for workOrderId : ${workOrderId} , qbCompanyConfigCode : ${qbCompanyConfigCode} and status : "FAILURE" `);

    oldInvoiceRecord = response.affectedDocuments

  }
  else {
    oldInvoiceRecord = await db.insertAsync({
      workOrderId: workOrderId,
      status: "FAILURE",
      invoiceDate: new Date(invoiceDate),
      qBInvoiceProcessingDate: new Date(),
      qbCompanyConfigCode: qbCompanyConfigCode,
      errorMessage: errorMessage
    })
    logger.info(`Record inserted in db for workOrderId : ${workOrderId} , qbCompanyConfigCode : ${qbCompanyConfigCode} and status : "FAILURE" `);
  }
  return oldInvoiceRecord;
}

const insertOrUpdateInDBForSuccess = async (invoiceWorkOrderId, qbInvoiceNumber, status, invoiceDate, invoiceTxnId, qbCompanyConfigCode) => {

  const numRemoved = await db.removeAsync({ workOrderId: invoiceWorkOrderId, qbCompanyConfigCode: qbCompanyConfigCode }, { multi: true })

  logger.info(`Records removed from db : ${numRemoved}`)


  let response = await db.insertAsync({
    workOrderId: invoiceWorkOrderId,
    qbInvoiceNumber: qbInvoiceNumber,
    invoiceTxnId: invoiceTxnId,
    status: status,
    invoiceDate: new Date(invoiceDate),
    qBInvoiceProcessingDate: new Date(),
    qbCompanyConfigCode: qbCompanyConfigCode,
    errorMessage: undefined
  })
  logger.info(`Record inserted in db for workOrderId : ${invoiceWorkOrderId} , qbCompanyConfigCode : ${qbCompanyConfigCode} and status : "${status}" `)
  return response;
}

const deleteOldInvoice = async (invTxnIdToDelete, ticket) => {
  logger.info("Deleting old invoice.")
  let status;
  const invoiceDeleteQuery = xmlPayloads.deleteTransactionQuery
    .replace("TRANSACTION_TYPE", "Invoice")
    .replace("TRANSACTION_ID", invTxnIdToDelete);

  const deleteResponse = await sendRequestToQBD(invoiceDeleteQuery, ticket);
  const deleteResponseInJson = convertXmlToJson(deleteResponse);

  if (deleteResponseInJson.QBXML.QBXMLMsgsRs.TxnDelRs.$.statusCode == STATUS_CODES.ZERO) {
    logger.info(`Old invoice with txnId : ${invTxnIdToDelete} deleted successfully`)
    status = "UPDATED"
  } else {
    logger.info(`Old invoice with txnId : ${invTxnIdToDelete} not deleted.`)
    status = "NOT DELETED"
  }
  return status;
}

const createInvoice = async (invoice, ticket, companyName) => {

  const lineItems = prepareLineItems(invoice);
  logger.info("Successfully found the line items");

  const preparedInvoice = prepareInvoice(lineItems, invoice);
  const invoiceInXML = jsonToXml(preparedInvoice);

  const result = await sendRequestToQBD(invoiceInXML, ticket);
  const resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.InvoiceAddRs.$.statusCode != STATUS_CODES.ZERO) {
    throw new Error(`Exception while creating invoice for ${companyName}. Exception : ${resultInJson.QBXML.QBXMLMsgsRs.InvoiceAddRs.$.statusMessage}`);
  }

  logger.info(`Invoice created successfully with qbInvoiceNumber : ${resultInJson.QBXML.QBXMLMsgsRs.InvoiceAddRs.InvoiceRet.RefNumber}`)

  return {
    invoiceRefNumber: resultInJson.QBXML.QBXMLMsgsRs.InvoiceAddRs.InvoiceRet.RefNumber,
    invoiceTxnId: resultInJson.QBXML.QBXMLMsgsRs.InvoiceAddRs.InvoiceRet.TxnID
  }

}

const processBill = async (bill, ticket, companyName) => {
  let billTxnIdToDelete;
  let oldBillRecord = await db.findOneAsync({ poId: bill.poId, qbCompanyConfigCode: companyName });
  let existingQbBillNumber = oldBillRecord ? oldBillRecord.qbBillNumber : bill.qbBillNumber;
  if (existingQbBillNumber) {
    logger.info("Bill creating again.")
    if (oldBillRecord && oldBillRecord.billTxnId) {
      billTxnIdToDelete = oldBillRecord.billTxnId;
      logger.info(`Picked invTxnIdToDelete from db : ${billTxnIdToDelete} for poId : ${bill.poId} and qbBillNumber : ${existingQbBillNumber}`)
    }
    else {
      logger.info(`Bill txnId not found in db for poId : ${bill.poId} and qbBillNumber : ${existingQbBillNumber}`)
      throw new Error("Bill txnId not found in db for poId : ${bill.poId} and qbBillNumber : ${existingQbBillNumber}");
    }
  }

  if(billTxnIdToDelete){
    await checkIfBillAlreayPaid(billTxnIdToDelete, ticket);
  }
  // let { invoiceRefNumber, invoiceTxnId } = await createInvoice(invoice, ticket, companyName);
  let response = await createBill(bill, ticket, companyName);
  let status = "";
  if (billTxnIdToDelete) {
    status = await deleteOldBill(billTxnIdToDelete, ticket);
  }
  if (existingQbBillNumber && billTxnIdToDelete) {
    status = "BILL UPDATED"
  } else {
    status = "CREATED"
  }
  oldBillRecord = await insertOrUpdateBillInDBForSuccess(bill.poId, response.billRefNumber, status, response.TxnDate, response.billTxnId, companyName);
  delete response.billRefNumber;
  delete response.billTxnId;
  await db.compactDatafileAsync();
  response.status = status;
  return response;
}

const checkIfBillAlreayPaid = async (txnId, ticket) =>{
  const billResponse = await getBillByTxnId(txnId, ticket);
  if (billResponse.IsPaid === true) {
    logger.error("Bill already paid");
    throw new Error("Bill already paid cannot update It");
  }
}

const getBillByTxnId = async (txnId, ticket) => {
  try {
    logger.info(`Fetching bill with TxnID: ${txnId}`);

    const billQuery = xmlPayloads.getBillByTxnIdQuery.replace("BILL_TXN_ID", txnId);
    const billResponse = await sendRequestToQBD(billQuery, ticket);
    const billResponseJson = convertXmlToJson(billResponse);

    const billRs = billResponseJson?.QBXML?.QBXMLMsgsRs?.BillQueryRs;
    const statusCode = billRs?.$?.statusCode;

    if (statusCode == STATUS_CODES.ZERO && billRs.BillRet) {
      logger.info(`Bill with TxnID: ${txnId} fetched successfully`);
      return billRs.BillRet;
    } else {
      logger.info(`No bill found with TxnID: ${txnId}`);
      return null;
    }
  } catch (error) {
    logger.error("Error fetching bill by TxnID:", error);
    throw new Error(`Failed to fetch bill. ${error.message}`);
  }
}


const deleteOldBill = async (billTxnIdToDelete, ticket) => {
  try {
    logger.info(`Attempting to delete bill with txnId: ${billTxnIdToDelete}`);
    const billDeleteQuery = xmlPayloads.deleteTransactionQuery
      .replace("TRANSACTION_TYPE", "Bill")
      .replace("TRANSACTION_ID", billTxnIdToDelete);
    const deleteResponse = await sendRequestToQBD(billDeleteQuery, ticket);
    const deleteResponseInJson = convertXmlToJson(deleteResponse);
    const statusCode = deleteResponseInJson.QBXML.QBXMLMsgsRs.TxnDelRs.$.statusCode;
    if (statusCode == STATUS_CODES.ZERO) {
      logger.info(`Bill with txnId: ${billTxnIdToDelete} deleted successfully`);
      return "DELETE";
    } else {
      logger.info(`Bill with txnId: ${billTxnIdToDelete} could not be deleted`);
      return "NOT DELETED";
    }
  } catch (error) {
    logger.error("Error deleting bill:", error);
    throw new Error(`Failed to delete bill. ${error.message}`);
  }
}

const createBill = async (bill, ticket, companyName) => {

  await validateOrCreateVendor(bill, ticket, companyName);
  logger.info("Successfully validated vendor");
  const expenseLines = await prepareExpenseLines(bill.lines, ticket, companyName);
  logger.info("Successfully found the expence line");

  const preparedBill = prepareBill(expenseLines, bill);
  const billInXML = jsonToXml(preparedBill);
  const result = await sendRequestToQBD(billInXML, ticket);
  const resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.$.statusCode != STATUS_CODES.ZERO) {
    throw new Error(`Exception while creating bill for ${companyName}. Exception : ${resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.$.statusMessage}`);
  }

  logger.info(`Bill created successfully with qbBillNumber  : ${resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.RefNumber}`)
  const response = {
    billRefNumber: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.RefNumber,
    qbBillNumber: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.TxnID,
    billTxnId: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.TxnID,
    PoId: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.RefNumber,
    AmountDue: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.AmountDue,
    IsPaid: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.IsPaid,
    TxnDate: resultInJson.QBXML.QBXMLMsgsRs.BillAddRs.BillRet.TxnDate
  }

  return response;

}

const prepareBill = (expenseLines, billData) => {
  return {
    QBXML: {
      QBXMLMsgsRq: {
        $: {
          onError: "stopOnError",
        },
        BillAddRq: {
          BillAdd: {
            VendorRef: {
              FullName: billData.from.name,
            },
            TxnDate: billData.lines[0].purchaseDate.split("T")[0],
            RefNumber: billData.poId,
            Memo: `PO: ${billData.poId}, Contact: ${billData.to.contactPersonEmail}`,
            ExpenseLineAdd: expenseLines,
          },
        },
      },
    },
  };
};

const prepareExpenseLines = async (lines, ticket, companyName) => {
  const expenseLines = [];

  for (const line of lines) {
    const mainAmount = Number(line.amount).toFixed(2);
    await validateOrCreateExpenseAccount(line.expenseAccount, ticket, companyName);

    expenseLines.push({
      AccountRef: {
        FullName: line.expenseAccount,
      },
      Amount: mainAmount,
      Memo: line.partMemo,
    });

    if (line.taxLine) {
      const taxAmount = Number(line.taxLine.amount).toFixed(2);
      await validateOrCreateExpenseAccount(line.taxLine.expenseAccount, ticket, companyName);

      expenseLines.push({
        AccountRef: {
          FullName: line.taxLine.expenseAccount,
        },
        Amount: taxAmount,
        Memo: `${line.taxLine.description} Rate ${line.taxRate}`,
      });
    }
  }

  return expenseLines;
};


const validateOrCreateVendor = async (vendor, ticket, companyName) => {
  const vendorXmlRequest = xmlPayloads.findVendorByNameQuery.replace("vendorName", prepareStringForXML(vendor.from.name))
  const result = await sendRequestToQBD(vendorXmlRequest, ticket);
  const resultInJson = convertXmlToJson(result);
  if (resultInJson.QBXML.QBXMLMsgsRs.VendorQueryRs.$.statusCode != STATUS_CODES.ZERO) {
    await createVendor(vendor, ticket, companyName);
    logger.info("Vendor created successfully for " + companyName);
  } else {
    logger.info("Vendor found successfully for " + companyName);
  }
}


const createVendor = async (vendor, ticket, companyName) => {
  const xmlRequest = await createVendorPayload(vendor);
  const result = await sendRequestToQBD(xmlRequest, ticket);
  const resultInJson = convertXmlToJson(result);
  logger.info("Vendor found successfully with name : " + vendor.from.name);
  if (resultInJson.QBXML.QBXMLMsgsRs.VendorAddRs.$.statusCode != STATUS_CODES.ZERO) {
    throw new Error(`Exception while creating vendor for ${companyName}. Exception: ${resultInJson.QBXML.QBXMLMsgsRs.VendorAddRs.$.statusMessage}`);
  }
}

const createVendorPayload = async (po) => {
  const jsonPayload = {
    QBXML: {
      QBXMLMsgsRq: {
        $: { onError: "stopOnError" },
        VendorAddRq: {
          VendorAdd: {
            Name: po.from.name,
            IsActive: "1",
            CompanyName: po.from.name,
            VendorAddress: {
              Addr1: po.from.address.line1,
              Addr2: po.from.address.line2 || "",
              City: po.from.address.city,
              State: po.from.address.state,
              PostalCode: po.from.address.zipcode,
              Country: po.from.address.country
            },
            ShipAddress: {
              Addr1: po.from.address.line1,
              Addr2: po.from.address.line2 || "",
              City: po.from.address.city,
              State: po.from.address.state,
              PostalCode: po.from.address.zipcode,
              Country: po.from.address.country
            },
            Phone: po.from.contactPersonMobile || "",
            Email: po.from.contactPersonEmail || "",
            AccountNumber: "",
            VendorTaxIdent: "",
            IsVendorEligibleFor1099: "0"
          }
        }
      }
    }
  };
  const doc = jsonToXml(jsonPayload);
  return doc;
};


const validateOrCreateExpenseAccount = async (accountName, ticket, companyName) => {
  const accountXmlRequest = xmlPayloads.findAccountsByNameQuery.replace("ACCOUNT_NAME", prepareStringForXML(accountName));
  const result = await sendRequestToQBD(accountXmlRequest, ticket);
  const resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.AccountQueryRs.$.statusCode != STATUS_CODES.ZERO) {
    await createExpenseAccount(accountName, ticket, companyName);
    logger.info(`Expense account "${accountName}" created successfully for ${companyName}`);
  } else {
    logger.info(`Expense account "${accountName}" found successfully for ${companyName}`);
  }
};

const createExpenseAccount = async (accountName, ticket, companyName) => {
  const xmlRequest = await createExpenseAccountPayload(accountName);
  const result = await sendRequestToQBD(xmlRequest, ticket);
  const resultInJson = convertXmlToJson(result);

  if (resultInJson.QBXML.QBXMLMsgsRs.AccountAddRs.$.statusCode != STATUS_CODES.ZERO) {
    throw new Error(`Exception while creating expense account "${accountName}" for ${companyName}. Exception: ${resultInJson.QBXML.QBXMLMsgsRs.AccountAddRs.$.statusMessage}`);
  }

  logger.info(`Expense account "${accountName}" successfully created for ${companyName}`);
};

const createExpenseAccountPayload = async (accountName) => {
  const jsonPayload = {
    QBXML: {
      QBXMLMsgsRq: {
        $: { onError: "stopOnError" },
        AccountAddRq: {
          AccountAdd: {
            Name: accountName,
            AccountType: "Expense"
          }
        }
      }
    }
  };

  return jsonToXml(jsonPayload);
};


const insertOrUpdateBillInDBForSuccess = async (poId, qbBillNumber, status, billDate, billTxnId, qbCompanyConfigCode) => {

  const numRemoved = await db.removeAsync({ poId: poId, qbCompanyConfigCode: qbCompanyConfigCode }, { multi: true })

  logger.info(`Records removed from db : ${numRemoved}`)


  let response = await db.insertAsync({
    poId: poId,
    qbBillNumber: qbBillNumber,
    billTxnId: billTxnId,
    status: status,
    billDate: new Date(billDate),
    qBillProcessingDate: new Date(),
    qbCompanyConfigCode: qbCompanyConfigCode,
    errorMessage: undefined
  })
  logger.info(`Record inserted in db for poId : ${poId} , qbCompanyConfigCode : ${qbCompanyConfigCode} and status : "${status}" `)
  return response;
}

const insertOrUpdateBillInDBForFailure = async (poId, errorMessage, billDate, qbCompanyConfigCode) => {

  let oldbillRecord = await db.findOneAsync({ poId: poId, qbCompanyConfigCode: qbCompanyConfigCode });

  let response;

  if (oldbillRecord) {
    response = await db.updateAsync({ poId: oldbillRecord.poId, qbCompanyConfigCode: qbCompanyConfigCode }, {
      $set: {
        status: "FAILURE",
        billDate: new Date(billDate),
        qBBillProcessingDate: new Date(),
        errorMessage: errorMessage
      }
    }, { returnUpdatedDocs: true })
    logger.info(`Record updated in db for poId : ${poId} , qbCompanyConfigCode : ${qbCompanyConfigCode} and status : "FAILURE" `);

    oldbillRecord = response.affectedDocuments

  }
  else {
    oldbillRecord = await db.insertAsync({
      poId: poId,
      status: "FAILURE",
      billDate: new Date(billDate),
      qBBillProcessingDate: new Date(),
      qbCompanyConfigCode: qbCompanyConfigCode,
      errorMessage: errorMessage
    })
    logger.info(`Record inserted in db for poId : ${poId} , qbCompanyConfigCode : ${qbCompanyConfigCode} and status : "FAILURE" `);
  }
  return oldbillRecord;
}

module.exports = { insertOrUpdateBillInDBForFailure, sendRequestToQBD, checkTemplate, prepareTaxListForValidation, validateOrCreateCustomer, getItemAndProcessInvoice, validateSalesTax, checkOrCreateNonTax, checkOrCreateItems, checkOrCreateSubtotalItem, checkOrCreateZeroSalesTaxCodes, checkOrCreateServiceItems, checkOrCreateIncomeAccounts, removeOldDBRecords, insertOrUpdateInDBForFailure, getAllSalesTaxFromQB, processBill };
