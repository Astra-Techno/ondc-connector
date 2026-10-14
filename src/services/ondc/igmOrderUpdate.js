// Apply the selected IGM outcome to the affected item, preserving unrelated items.
const affectedItem = (issue, order) => {
  const ref = issue.refs?.find(r => r.ref_type === 'ITEM');
  const item = order.items?.find(i => i.id === ref?.ref_id);
  if (!item) throw new Error('IGM item reference does not match the order');
  const count = ref.tags?.flatMap(t => t.list || [])
    .find(t => t.descriptor?.code === 'quantity.selected.count')?.value;
  const quantity = Number(count || item.quantity?.count || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(item.quantity?.count || 1)) {
    throw new Error('Invalid IGM item quantity');
  }
  const line = order.quote?.breakup?.find(b => b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === item.id);
  const price = Number(line?.item?.price?.value ?? (Number(line?.price?.value) / Number(item.quantity?.count || 1)));
  if (!Number.isFinite(price) || price < 0) throw new Error('IGM item price is unavailable');
  return { item, quantity, amount: Number((price * quantity).toFixed(2)) };
};

const buildIgmOrderUpdate = (issue, order, selected) => {
  const outcome = selected.descriptor.code;
  if (outcome === 'NO_ACTION') return structuredClone(order);
  if (!['REFUND', 'REPLACEMENT'].includes(outcome)) throw new Error('Unsupported IGM order outcome');
  const { item, quantity, amount } = affectedItem(issue, order);
  const updated = structuredClone(order);
  const returnId = `igm-${issue.id}`;
  const tag = (code, entries) => ({ code, list: entries.map(([code, value]) => ({ code, value: String(value) })) });
  updated.fulfillments = [...(updated.fulfillments || []), {
    id: returnId, type: 'Return', state: { descriptor: { code: 'Liquidated' } },
    '@ondc/org/provider_name': order.fulfillments?.[0]?.['@ondc/org/provider_name'] || 'Store',
    tags: [
      tag('return_request', [['id', returnId], ['item_id', item.id], ['item_quantity', quantity],
        ['reason_id', '003'], ['reason_desc', issue.descriptor?.short_desc || 'IGM resolution'],
        ['ttl_approval', 'PT24H'], ['ttl_reverseqc', 'P3D'], ['initiated_by', issue.complainant_id]]),
      tag('igm_request', [['id', issue.id]]),
      tag('quote_trail', [['type', 'item'], ['id', item.id],
        ['currency', 'INR'], ['value', outcome === 'REFUND' ? (-amount).toFixed(2) : '0.00']]),
      tag('quote_trail', [['type', 'tax'], ['id', item.id], ['currency', 'INR'], ['value', '0.00']]),
    ],
  }];
  updated.items = [...updated.items, { id: item.id, fulfillment_id: returnId, quantity: { count: quantity } }];
  if (outcome === 'REFUND') {
    const total = Number(updated.quote?.price?.value);
    if (!Number.isFinite(total) || amount > total) throw new Error('Invalid IGM refund amount');
    updated.quote.price.value = (total - amount).toFixed(2);
    const line = updated.quote.breakup.find(b => b['@ondc/org/title_type'] === 'item' && b['@ondc/org/item_id'] === item.id);
    line.price.value = (Number(line.price.value) - amount).toFixed(2);
    if (line['@ondc/org/item_quantity']) line['@ondc/org/item_quantity'].count -= quantity;
    updated.items.find(i => i.id === item.id).quantity.count -= quantity;
  }
  updated.updated_at = new Date().toISOString();
  return updated;
};
module.exports = { affectedItem, buildIgmOrderUpdate };
