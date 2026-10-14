// Certification decisions are local configuration, never inferred from an ACK.
const FLOWS = new Set(['prepaid', 'igm', 'igm-no-action', 'igm-rejection', 'merchant-rto']);
const getWorkflowProfile = (order) => {
  const configured = order?.workflowProfile || process.env.ONDC_WORKBENCH_FLOW || 'prepaid';
  return FLOWS.has(configured) ? configured : 'prepaid';
};
const isMerchantRto = (order) => getWorkflowProfile(order) === 'merchant-rto';
const isCertificationContext = context => context?.bap_id === (process.env.WORKBENCH_BAP_ID || 'workbench.ondc.tech')
  || /^pramaan\.ondc\.org(?:\/|$)/.test(context?.bap_id || '');
module.exports = { FLOWS, getWorkflowProfile, isMerchantRto, isCertificationContext };
