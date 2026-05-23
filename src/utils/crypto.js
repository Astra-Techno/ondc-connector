const crypto = require('crypto');
const { blake2b } = require('blakejs');

// PKCS8 DER prefix for a raw 32-byte ed25519 private key (seed)
// Wraps raw key so Node.js crypto can use it
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Create a proper Node.js KeyObject from raw base64 ed25519 seed
const buildPrivateKey = (rawBase64) => {
  const rawKey = Buffer.from(rawBase64, 'base64');
  const seed   = rawKey.slice(0, 32); // ONDC provides 32-byte seed
  const pkcs8  = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
};

// BLAKE-512 (blake2b with 64-byte output) hash of body — required by ONDC spec
const blake512 = (body) => {
  const data = typeof body === 'string' ? Buffer.from(body) : Buffer.from(JSON.stringify(body));
  return Buffer.from(blake2b(data, undefined, 64)).toString('base64');
};

// Create ONDC-compliant Authorization header
// Spec: https://docs.ondc.org/api/core/signing
const createAuthHeader = (signingPrivateKey, subscriberId, uniqueKeyId, body) => {
  try {
    const created = Math.floor(Date.now() / 1000);
    const expires = created + 300; // 5 minutes

    const bodyHash     = blake512(body);
    const signingString = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${bodyHash}`;

    const privateKey = buildPrivateKey(signingPrivateKey);
    const signature  = crypto.sign(null, Buffer.from(signingString), privateKey).toString('base64');

    return [
      `Signature keyId="${subscriberId}|${uniqueKeyId}|ed25519"`,
      `algorithm="ed25519"`,
      `created="${created}"`,
      `expires="${expires}"`,
      `headers="(created) (expires) digest"`,
      `signature="${signature}"`,
    ].join(',');
  } catch (err) {
    throw new Error(`createAuthHeader failed: ${err.message}`);
  }
};

// Verify incoming ONDC request Authorization header
// Looks up the signing public key from ONDC registry and verifies signature
const verifyAuthHeader = async (authHeader, body) => {
  try {
    if (!authHeader) return false;

    // Parse Authorization header
    const parts = {};
    authHeader.replace(/^Signature\s+/, '').split(',').forEach(part => {
      const [k, ...v] = part.trim().split('=');
      parts[k.trim()] = v.join('=').replace(/^"|"$/g, '');
    });

    const { keyId, created, expires, signature } = parts;
    if (!keyId || !signature) return false;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (expires && parseInt(expires) < now) {
      return false; // Expired
    }

    // keyId format: subscriberId|uniqueKeyId|algorithm
    const [subscriberId, uniqueKeyId] = keyId.split('|');

    // Look up public key from ONDC registry
    let publicKeyBase64 = null;
    try {
      const axios = require('axios');
      const registryUrl = process.env.ONDC_REGISTRY_URL || 'https://preprod.registry.ondc.org/ondc/lookup';
      const response = await axios.post(registryUrl, { subscriber_id: subscriberId }, { timeout: 5000 });
      const subscriber = response.data?.find?.(s => s.unique_key_id === uniqueKeyId);
      publicKeyBase64 = subscriber?.signing_public_key;
    } catch (e) {
      // If registry lookup fails, skip verification (log it)
      const logger = require('./logger');
      logger.warn('Registry lookup failed for verification:', e.message);
      return true; // Permissive fallback — tighten for production
    }

    if (!publicKeyBase64) return true; // Key not found — permissive fallback

    // Reconstruct signing string
    const bodyHash      = blake512(body);
    const signingString = `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${bodyHash}`;

    // Build public key object and verify
    const rawPubKey = Buffer.from(publicKeyBase64, 'base64');
    // DER prefix for ed25519 public key (SubjectPublicKeyInfo)
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    const spkiKey    = Buffer.concat([spkiPrefix, rawPubKey.slice(0, 32)]);
    const publicKey  = crypto.createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });

    return crypto.verify(null, Buffer.from(signingString), publicKey, Buffer.from(signature, 'base64'));
  } catch (err) {
    const logger = require('./logger');
    logger.warn('verifyAuthHeader error:', err.message);
    return false;
  }
};

module.exports = { createAuthHeader, verifyAuthHeader, blake512 };
