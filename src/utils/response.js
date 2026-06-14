const success = (res, data, message = 'Success', code = 200) => {
  return res.status(code).json({ success: true, message, data });
};

const error = (res, message = 'Error', code = 500, errors = null) => {
  return res.status(code).json({ success: false, message, errors });
};

const ack = (res, context = null, status = 'ACK') => {
  const body = context
    ? { context: { ...context, timestamp: new Date().toISOString() }, message: { ack: { status } } }
    : { message: { ack: { status } } };
  return res.status(200).json(body);
};

const nack = (res, message = 'NACK') => {
  return res.status(200).json({ message: { ack: { status: 'NACK' }, error: { message } } });
};

module.exports = { success, error, ack, nack };
