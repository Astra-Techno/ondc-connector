// Map CloudKart product to ONDC item schema
const mapProductToONDC = (product, vendorInfo) => {
  return {
    id: String(product.id),
    descriptor: {
      name: product.name,
      short_desc: product.description || product.name,
      long_desc: product.description || product.name,
      images: product.image_url ? [{ url: product.image_url }] : []
    },
    price: {
      currency: 'INR',
      value: String(product.price),
      maximum_value: String(product.mrp || product.price)
    },
    quantity: {
      available: { count: String(product.stock || 0) },
      maximum: { count: '10' }
    },
    category_id: product.category_slug || 'grocery',
    fulfillment_id: 'f1',
    location_id: 'l1',
    '@ondc/org/returnable': false,
    '@ondc/org/cancellable': true,
    '@ondc/org/return_window': 'P1D',
    '@ondc/org/seller_pickup_return': false,
    '@ondc/org/time_to_ship': 'PT24H',
    '@ondc/org/available_on_cod': true,
    '@ondc/org/contact_details_consumer_care': vendorInfo.contact || '',
    '@ondc/org/statutory_reqs_packaged_commodities': {
      manufacturer_or_packer_name: vendorInfo.business_name || '',
      manufacturer_or_packer_address: vendorInfo.address || '',
      common_or_generic_name_of_commodity: product.name,
      net_quantity_or_measure_of_commodity_in_pkg: '1',
      month_year_of_manufacture_packing_import: new Date().toISOString().substring(0, 7)
    }
  };
};

// Map ONDC order to CloudKart order
const mapONDCOrderToCloudKart = (ondcOrder) => {
  return {
    ondc_order_id: ondcOrder.id,
    items: ondcOrder.items?.map(item => ({
      product_id: item.id,
      quantity: item.quantity?.count || 1,
      price: item.price?.value
    })),
    billing: ondcOrder.billing,
    fulfillment: ondcOrder.fulfillments?.[0],
    payment: ondcOrder.payment,
    total: ondcOrder.quote?.price?.value
  };
};

module.exports = { mapProductToONDC, mapONDCOrderToCloudKart };
