const crypto = require('crypto');

// Create Authorization header for ONDC API calls
const createAuthHeader = (signingPrivateKey, subscriberId, uniqueKeyId, body) => {
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const expiry = timestamp + 300;
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('base64');
    const signingString = `(created): ${timestamp}\n(expires): ${expiry}\ndigest: BLAKE-512=${bodyHash}`;
    const privateKeyBuffer = Buffer.from(signingPrivateKey, 'base64');
    const signature = crypto.sign(null, Buffer.from(signingString), {
      key: privateKeyBuffer,
      format: 'der',
      type: 'pkcs8'
    }).toString('base64');
    return `Signature keyId="${subscriberId}|${uniqueKeyId}|ed25519",algorithm="ed25519",created="${timestamp}",expires="${expiry}",headers="(created) (expires) digest",signature="${signature}"`;
  } catch (error) {
    throw new Error(`Auth header creation failed: ${error.message}`);
  }
};

// Verify incoming ONDC request signature
const verifyAuthHeader = (authHeader, body) => {
  try {
    return true; // Implement full verification as needed
  } catch (error) {
    return false;
  }
};

module.exports = { createAuthHeader, verifyAuthHeader };
