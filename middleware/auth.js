const assymetricCryptography = require("../util/cryptographyUtil");
const {logger} = require("../config/winstonConfig");
const cryptographyConstants = require("../constant/cryptographyContstant");

exports.verifyRequest = (req, res, next) => {
    try {
        const cypherText = req.headers.token;
        const decryptedText = assymetricCryptography.decryptText(cypherText);
        const secretKey = cryptographyConstants.secretKey;
        if (secretKey == decryptedText) {
            next();
        } else {
            logger.error(`Unauthorized access attempt: ${req.method} ${req.path}`);
            return res.status(401).send({"error":"Unauthorized Request"});
        }
    }
    catch (err) {
        logger.error(err);
        return res.status(401).send({"error":"Unauthorized Request"});
    }
}
