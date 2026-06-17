const { pushTxnLog } = require('../services/ondc/logPublisher.service');

const success = (res, data, message = 'Success', code = 200) => {
  return res.status(code).json({ success: true, message, data });
};

const error = (res, message = 'Error', code = 500, errors = null) => {
  return res.status(code).json({ success: false, message, errors });
};

// Actions Pramaan verifies via Network Observability before scoring the flow
const PRAMAAN_SYNC_ACTIONS = new Set(['select', 'init', 'confirm']);

// Build ONDC-compliant sync ACK body and publish to Network Observability.
// Pramaan requires select_response / init_response / confirm_response log entries.
const buildAckBody = (context = null, status = 'ACK') => {
  if (!context) return { message: { ack: { status } } };

  const enrichedContext = {
    ...context,
    bpp_id:  context.bpp_id  || process.env.ONDC_SUBSCRIBER_ID,
    bpp_uri: context.bpp_uri || process.env.ONDC_SUBSCRIBER_URL,
    timestamp: new Date().toISOString(),
  };

  return { context: enrichedContext, message: { ack: { status } } };
};

// Await analytics push for select/init/confirm so Pramaan finds the log before scoring
const ack = async (res, context = null, status = 'ACK') => {
  const body = buildAckBody(context, status);

  if (body.context?.action) {
    const logType = `${body.context.action}_response`;
    if (PRAMAAN_SYNC_ACTIONS.has(body.context.action)) {
      await pushTxnLog(logType, body);
    } else {
      pushTxnLog(logType, body).catch(() => {});
    }
  }

  return res.status(200).json(body);
};

const nack = (res, message = 'NACK') => {
  return res.status(200).json({ message: { ack: { status: 'NACK' }, error: { message } } });
};

module.exports = { success, error, ack, nack, buildAckBody };
