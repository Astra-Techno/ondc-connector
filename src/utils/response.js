const success = (res, data, message = 'Success', code = 200) => {
  return res.status(code).json({ success: true, message, data });
};

const error = (res, message = 'Error', code = 500, errors = null) => {
  return res.status(code).json({ success: false, message, errors });
};

const ack = (res, status = 'ACK') => {
  return res.status(200).json({ message: { ack: { status } } });
};

const nack = (res, message = 'NACK') => {
  return res.status(200).json({ message: { ack: { status: 'NACK' }, error: { message } } });
};

module.exports = { success, error, ack, nack };
