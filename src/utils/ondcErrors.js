/**
 * ONDC Protocol Error Codes (RFC-001)
 * Reference: https://github.com/ONDC-Official/developer-docs/blob/main/protocol-network-extension/error-codes.md
 *
 * Ranges:
 *   10000–10999  Gateway
 *   20000–29999  Buyer NP (BNP / BAP)
 *   30000–59999  Seller NP (SNP / BPP)
 *   60000–66999  Logistics (LSP)
 */

// ─── Error Types ────────────────────────────────────────────────────────────
const TYPES = {
  CONTEXT: 'CONTEXT-ERROR',
  CORE:    'CORE-ERROR',
  DOMAIN:  'DOMAIN-ERROR',
  POLICY:  'POLICY-ERROR',
  JSON:    'JSON-SCHEMA-ERROR',
};

// ─── Gateway Errors (10000–10999) ───────────────────────────────────────────
const GATEWAY = {
  BAD_REQUEST:       { type: TYPES.CONTEXT, code: '10000', message: 'Bad or Invalid request error' },
  INVALID_SIGNATURE: { type: TYPES.CONTEXT, code: '10001', message: 'Invalid Signature' },
  INVALID_CITY_CODE: { type: TYPES.CONTEXT, code: '10002', message: 'Invalid City Code' },
};

// ─── Seller NP (BPP) Errors (30000–59999) ───────────────────────────────────
const SELLER = {
  // Basic (30000–30023)
  INVALID_REQUEST:            { type: TYPES.DOMAIN, code: '30000', message: 'Invalid request error' },
  PROVIDER_NOT_FOUND:         { type: TYPES.DOMAIN, code: '30001', message: 'Provider not found' },
  PROVIDER_LOCATION_NOT_FOUND:{ type: TYPES.DOMAIN, code: '30002', message: 'Provider location not found' },
  PROVIDER_CATEGORY_NOT_FOUND:{ type: TYPES.DOMAIN, code: '30003', message: 'Provider category not found' },
  ITEM_NOT_FOUND:             { type: TYPES.DOMAIN, code: '30004', message: 'Item not found' },
  INVALID_RETURN_REQUEST:     { type: TYPES.DOMAIN, code: '30005', message: 'Invalid return request' },
  OFFER_CODE_INVALID:         { type: TYPES.DOMAIN, code: '30006', message: 'Offer code invalid' },
  OFFER_FULFILLMENT_ERROR:    { type: TYPES.DOMAIN, code: '30007', message: 'Offer fulfillment error' },
  PICKUP_NOT_SERVICEABLE:     { type: TYPES.DOMAIN, code: '30008', message: 'Pickup location not serviceable' },
  DROPOFF_NOT_SERVICEABLE:    { type: TYPES.DOMAIN, code: '30009', message: 'Dropoff location not serviceable' },
  MAX_DISTANCE_EXCEEDED:      { type: TYPES.DOMAIN, code: '30010', message: 'Exceeds maximum serviceability distance' },
  DELIVERY_PARTNERS_UNAVAIL:  { type: TYPES.DOMAIN, code: '30011', message: 'Delivery Partners not available' },
  INVALID_CANCEL_REASON:      { type: TYPES.DOMAIN, code: '30012', message: 'Invalid cancellation reason' },
  INVALID_FULFILLMENT_TAT:    { type: TYPES.DOMAIN, code: '30013', message: 'Invalid Fulfillment TAT' },
  CANCEL_TAT_NOT_BREACHED:    { type: TYPES.DOMAIN, code: '30014', message: 'Cancellation not possible, TAT not breached' },
  INVALID_RATING:             { type: TYPES.DOMAIN, code: '30015', message: 'Invalid rating value' },
  INVALID_SIGNATURE:          { type: TYPES.DOMAIN, code: '30016', message: 'Invalid Signature' },
  MERCHANT_UNAVAILABLE:       { type: TYPES.DOMAIN, code: '30017', message: 'Merchant unavailable' },
  ORDER_NOT_FOUND:            { type: TYPES.DOMAIN, code: '30018', message: 'Invalid Order — not found' },
  ORDER_CONFIRM_ERROR:        { type: TYPES.DOMAIN, code: '30019', message: 'Seller unable to confirm order' },
  ORDER_CONFIRM_FAILURE:      { type: TYPES.DOMAIN, code: '30020', message: 'Order Confirm Failure — no response from Buyer App' },
  MERCHANT_INACTIVE:          { type: TYPES.DOMAIN, code: '30021', message: 'Merchant Inactive' },
  STALE_REQUEST:              { type: TYPES.DOMAIN, code: '30022', message: 'Stale Request' },
  MIN_ORDER_VALUE:            { type: TYPES.DOMAIN, code: '30023', message: 'Cart value less than minimum order value' },

  // Processing (31001–31003)
  INTERNAL_ERROR:             { type: TYPES.CORE, code: '31001', message: 'Cannot process request due to internal error' },
  ORDER_VALIDATION_FAILURE:   { type: TYPES.CORE, code: '31002', message: 'Order validation failure' },
  ORDER_PROCESSING:           { type: TYPES.CORE, code: '31003', message: 'Order processing in progress' },

  // Business (40000–40012)
  BUSINESS_ERROR:             { type: TYPES.DOMAIN, code: '40000', message: 'Business Error' },
  FEATURE_NOT_SUPPORTED:      { type: TYPES.DOMAIN, code: '40001', message: 'Feature not supported' },
  ITEM_QTY_UNAVAILABLE:       { type: TYPES.DOMAIN, code: '40002', message: 'Item quantity unavailable' },
  QUOTE_UNAVAILABLE:          { type: TYPES.DOMAIN, code: '40003', message: 'Quote unavailable' },
  PAYMENT_TYPE_NOT_SUPPORTED: { type: TYPES.DOMAIN, code: '40004', message: 'Payment type not supported' },
  TRACKING_NOT_ENABLED:       { type: TYPES.DOMAIN, code: '40005', message: 'Tracking not enabled' },
  AGENT_UNAVAILABLE:          { type: TYPES.DOMAIN, code: '40006', message: 'Fulfilment agent unavailable' },
  ITEM_QTY_CHANGED:           { type: TYPES.DOMAIN, code: '40007', message: 'Change in item quantity' },
  QUOTE_CHANGED:              { type: TYPES.DOMAIN, code: '40008', message: 'Change in quote' },
  MAX_ORDER_QTY_EXCEEDED:     { type: TYPES.DOMAIN, code: '40009', message: 'Maximum order quantity exceeded' },
  EXPIRED_AUTH:               { type: TYPES.DOMAIN, code: '40010', message: 'Authorization code has expired' },
  INVALID_AUTH:               { type: TYPES.DOMAIN, code: '40011', message: 'Authorization code is invalid' },
  MIN_ORDER_QTY:              { type: TYPES.DOMAIN, code: '40012', message: 'Minimum order quantity required' },
  FINDER_FEE_NOT_ACCEPTABLE:  { type: TYPES.DOMAIN, code: '41001', message: 'Finder fee not acceptable' },
  WEIGHT_CHARGES_REJECTED:    { type: TYPES.DOMAIN, code: '41002', message: 'Differential weight charges rejected' },

  // Policy (50000–50008)
  POLICY_ERROR:               { type: TYPES.POLICY, code: '50000', message: 'Policy Error' },
  CANCEL_NOT_POSSIBLE:        { type: TYPES.POLICY, code: '50001', message: 'Cancellation not possible' },
  UPDATE_NOT_POSSIBLE:        { type: TYPES.POLICY, code: '50002', message: 'Updation not possible' },
  UNSUPPORTED_RATING_CAT:     { type: TYPES.POLICY, code: '50003', message: 'Unsupported rating category' },
  SUPPORT_UNAVAILABLE:        { type: TYPES.POLICY, code: '50004', message: 'Support unavailable' },
  TERMS_NOT_ACCEPTABLE:       { type: TYPES.POLICY, code: '50005', message: 'Terms and Conditions not acceptable' },
  ORDER_TERMINATED:           { type: TYPES.POLICY, code: '50006', message: 'Order terminated' },
  FULFILLMENT_NOT_FOUND:      { type: TYPES.POLICY, code: '50007', message: 'Fulfillment not found' },
  FULFILLMENT_TERMINAL:       { type: TYPES.POLICY, code: '50008', message: 'Fulfillment cannot be updated — reached terminal state' },
};

// Helper: build an ONDC error object from a constant (optionally override message)
const makeError = (errConst, customMessage) => ({
  type:    errConst.type,
  code:    errConst.code,
  message: customMessage || errConst.message,
});

module.exports = { TYPES, GATEWAY, SELLER, makeError };
