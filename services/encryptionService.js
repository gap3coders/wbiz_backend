const CryptoJS = require('crypto-js');
const config = require('../config');

const encrypt = (text) => {
  return CryptoJS.AES.encrypt(text, config.encryptionKey).toString();
};

const decrypt = (ciphertext) => {
  const bytes = CryptoJS.AES.decrypt(ciphertext, config.encryptionKey);
  return bytes.toString(CryptoJS.enc.Utf8);
};

module.exports = { encrypt, decrypt };
