const fs = require("fs");
const ini = require("ini");
const path = require("path");
const { logger } = require("../config/winstonConfig");
const filePath = path.join(process.cwd(), "config.ini");

exports.getCompanyPath = (companyName) => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        const companyPath = config.companyDetail[companyName];
        return companyPath;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getAccounts = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.accountDetails;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getTaxVendorName = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.taxAgencyDetails.salesTaxAgency;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getSalexTaxReturnLine = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.taxAgencyDetails.salexTaxReturnLine;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getTaxCodeDetails = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.taxCodeDetails;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getTerms = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.otherDetails.terms;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.writeInConfig = (companyDetail, otherDetails,taxAgencyDetails) => {
    let config = {};
    if (fs.existsSync(filePath)) {
        // If the file exists, rename it with a timestamp
        const date = new Date();
        const timestamp = date.getFullYear() + ("0" + (date.getMonth() + 1)).slice(-2) + ("0" + date.getDate()).slice(-2) + ("0" + date.getHours()).slice(-2) + ("0" + date.getMinutes()).slice(-2) + ("0" + date.getSeconds()).slice(-2)
        const backupFileName = `config-${timestamp}.ini`;

        // Rename the existing config file
        fs.renameSync(filePath, backupFileName);

        const files = fs.readdirSync(path.dirname(filePath));

        // Filter backup files (files matching the pattern "config-*.ini")
        const backupFiles = files.filter(file => /^config-\d{14}\.ini$/.test(file));

        // Sort backup files by creation time (oldest to newest)
        const sortedBackupFiles = backupFiles.sort((a, b) => fs.statSync(path.join(path.dirname(filePath), a)).ctime.getTime() - fs.statSync(path.join(path.dirname(filePath), b)).ctime.getTime());

        // Keep only the last 5 backup files
        const filesToDelete = sortedBackupFiles.slice(0, -5);

        // Delete the older backup files
        filesToDelete.forEach(file => {
            const fileToDeletePath = path.join(path.dirname(filePath), file);
            fs.unlinkSync(fileToDeletePath);
            logger.info(`Deleted old backup file: ${fileToDeletePath}`);
        });
    }

    config.companyDetail = companyDetail;
    // config.accountDetails = accountDetails;
    config.taxAgencyDetails = taxAgencyDetails;
    config.otherDetails = otherDetails;


    const configData = ini.stringify(config);
    fs.writeFileSync(filePath, configData, 'utf-8');
}

exports.getKeepQBInvoiceNumber = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.otherDetails.keepQBInvoiceNumber;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getTemplateName = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.otherDetails.templateName;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getMultiUserMode = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.otherDetails.multiUserMode;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}

exports.getNedbDataRetentionDays = () => {
    try {
        const iniData = fs.readFileSync(filePath, 'utf-8');
        const config = ini.parse(iniData);
        return config.otherDetails.nedbDataRetentionDays;
    } catch (err) {
        console.error(err.message);
        return undefined;
    }
}