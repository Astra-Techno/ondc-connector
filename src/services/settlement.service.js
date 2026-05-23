const axios = require('axios');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const PLATFORM_COMMISSION_PERCENT = parseFloat(process.env.PLATFORM_COMMISSION || '2');
const CASHFREE_API_URL    = process.env.CASHFREE_API_URL    || 'https://payout-gamma.cashfree.com';
const CASHFREE_CLIENT_ID  = process.env.CASHFREE_CLIENT_ID;
const CASHFREE_SECRET     = process.env.CASHFREE_CLIENT_SECRET;

// Calculate and persist settlement for one delivered order
const calculateSettlement = async (order) => {
  const total          = parseFloat(order.total_amount);
  const finderFeePct   = parseFloat(order.finder_fee_percent || 3);
  const buyerAppFee    = parseFloat((total * finderFeePct    / 100).toFixed(2));
  const platformFee    = parseFloat((total * PLATFORM_COMMISSION_PERCENT / 100).toFixed(2));
  const sellerPayout   = parseFloat((total - buyerAppFee - platformFee).toFixed(2));

  const [result] = await pool.query(`
    INSERT INTO settlements
      (tenant_id, vendor_id, order_id, ondc_order_id,
       total_amount, buyer_app_fee, platform_commission, seller_payout,
       status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())
    ON DUPLICATE KEY UPDATE updated_at = NOW()
  `, [
    order.tenant_id, order.vendor_id,
    order.id, order.ondc_order_id,
    total, buyerAppFee, platformFee, sellerPayout,
  ]);

  return { id: result.insertId, total_amount: total, buyer_app_fee: buyerAppFee, platform_commission: platformFee, seller_payout: sellerPayout };
};

// Get Cashfree auth token
const getCashfreeToken = async () => {
  const response = await axios.post(`${CASHFREE_API_URL}/payout/v1/authorize`, {}, {
    headers: { 'X-Client-Id': CASHFREE_CLIENT_ID, 'X-Client-Secret': CASHFREE_SECRET },
    timeout: 10000,
  });
  return response.data?.data?.token;
};

// Trigger Cashfree payout for a settlement
const processPayoutViaCashfree = async (settlement) => {
  if (!CASHFREE_CLIENT_ID || !CASHFREE_SECRET) {
    logger.warn('Cashfree not configured — skipping payout');
    return null;
  }

  const [vendorRows] = await pool.query(`SELECT * FROM vendors WHERE id = ?`, [settlement.vendor_id]);
  const vendor = vendorRows[0];
  if (!vendor?.bank_account || !vendor?.bank_ifsc) {
    logger.warn(`Vendor ${settlement.vendor_id} has no bank details`);
    return null;
  }

  try {
    const token    = await getCashfreeToken();
    const response = await axios.post(`${CASHFREE_API_URL}/payout/v1/directTransfer`, {
      amount:       settlement.seller_payout,
      transferId:   `ONDC-${settlement.id}`,
      transferMode: 'IMPS',
      account:      vendor.bank_account,
      ifsc:         vendor.bank_ifsc,
      name:         vendor.business_name,
      remarks:      `ONDC Settlement ${settlement.ondc_order_id}`,
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });

    const utr = response.data?.data?.utr;
    await pool.query(
      `UPDATE settlements SET status = 'processed', utr_number = ?, processed_at = NOW() WHERE id = ?`,
      [utr, settlement.id]
    );
    logger.info(`Settlement ${settlement.id} processed — UTR: ${utr}`);
    return { utr };
  } catch (err) {
    await pool.query(
      `UPDATE settlements SET status = 'failed', updated_at = NOW() WHERE id = ?`,
      [settlement.id]
    ).catch(() => {});
    logger.error(`Cashfree payout failed for settlement ${settlement.id}:`, err.message);
    throw err;
  }
};

// Run once daily: create settlement entries for all delivered orders from yesterday
const generateDailySettlements = async () => {
  logger.info('[Settlement] Generating daily settlements');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  try {
    const [orders] = await pool.query(`
      SELECT o.*,
        JSON_UNQUOTE(JSON_EXTRACT(o.payment, '$."@ondc/org/buyer_app_finder_fee_amount"')) as finder_fee_percent
      FROM ondc_orders o
      LEFT JOIN settlements s ON s.order_id = o.id
      WHERE o.status = 'delivered'
        AND DATE(o.delivered_at) = ?
        AND s.id IS NULL
    `, [dateStr]);

    for (const order of orders) {
      try {
        await calculateSettlement(order);
      } catch (e) {
        logger.error(`Settlement failed for order ${order.id}:`, e.message);
      }
    }
    logger.info(`[Settlement] ${orders.length} settlements generated for ${dateStr}`);
  } catch (err) {
    logger.error('[Settlement] generateDailySettlements failed:', err.message);
  }
};

module.exports = { calculateSettlement, processPayoutViaCashfree, generateDailySettlements };
