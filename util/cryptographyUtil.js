const crypto = require("crypto"); 
const cryptographyConstant = require("../constant/cryptographyContstant");

exports.decryptText  = (encryptedText) =>{
  const key = cryptographyConstant.privateKey;
    return crypto.privateDecrypt(
        {
          key: key,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256'
        },
        Buffer.from(encryptedText, 'base64')
      ).toString('utf-8');
  }

exports.encryptText =  (plainText) => {
  const key = cryptographyConstant.publicKey;
    return crypto.publicEncrypt({
        key: key,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256'
      },
      Buffer.from(plainText)).toString('base64');
  }