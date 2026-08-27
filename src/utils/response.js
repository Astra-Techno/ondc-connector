const { pushSyncTxnLogs } = require('../services/ondc/logPublisher.service');
const logger = require('./logger');

const success = (res, data, message = 'Success', code = 200) => {
  return res.status(code).json({ success: true, message, data });
};

const error = (res, message = 'Error', code = 500, errors = null) => {
  return res.status(code).json({ success: false, message, errors });
};

// Actions Pramaan verifies via Network Observability
const PRAMAAN_SYNC_ACTIONS = new Set(['select', 'init', 'confirm']);

// Build an ONDC-compliant synchronous ACK body.
//
// A synchronous ACK acknowledges *this* request, so its context must retain the
// participant identities supplied by the caller.  Replacing bpp_id/bpp_uri here
// makes Workbench associate the request with a different BPP than the one it
// uses for the rest of the lifecycle.  Our identity is set only on asynchronous
// on_* callbacks by sendCallback/sendOnSearch.
const buildAckBody = (context = null, status = 'ACK') => {
  if (!context) return { message: { ack: { status } } };

  const enrichedContext = {
    ...context,
    timestamp: new Date().toISOString(),
  };

  return { context: enrichedContext, message: { ack: { status } } };
};

// Wait up to ~2.5s for N.O. logs (parallel), then return sync ACK; push continues in background if needed
const ack = async (res, context = null, status = 'ACK') => {
  const body = buildAckBody(context, status);
  const action = body.context?.action;

  if (action && PRAMAAN_SYNC_ACTIONS.has(action)) {
    const result = await pushSyncTxnLogs(action, res.req?.body, body);

    res.locals = res.locals || {};
    res.locals.analyticsPush = result;

    if (result.ok) {
      logger.info(`N.O. ${result.type} pushed OK`, { txn: context?.transaction_id });
    } else if (!result.deferred) {
      logger.error(`N.O. ${result.type} push failed`, result);
    }
  }

  return res.status(200).json(body);
};

const nack = (res, context = null, errorOrMessage = 'Order cannot be cancelled at this stage') => {
  const body = buildAckBody(context, 'NACK');
  if (typeof errorOrMessage === 'object' && errorOrMessage.code) {
    body.message.error = { type: errorOrMessage.type, code: errorOrMessage.code, message: errorOrMessage.message };
  } else {
    body.message.error = { type: 'DOMAIN-ERROR', code: '30000', message: String(errorOrMessage) };
  }
  return res.status(200).json(body);
};

module.exports = { success, error, ack, nack, buildAckBody };
