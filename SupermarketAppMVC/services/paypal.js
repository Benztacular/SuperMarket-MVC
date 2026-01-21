const fetch = require('node-fetch');
require('dotenv').config();

const PAYPAL_CLIENT = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = process.env.PAYPAL_API;

async function getAccessToken() {
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(PAYPAL_CLIENT + ':' + PAYPAL_SECRET).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await response.json();
  return data.access_token;
}

// createOrder now accepts optional returnUrl and cancelUrl so PayPal can redirect back
async function createOrder(amount, returnUrl = null, cancelUrl = null) {
  const accessToken = await getAccessToken();
  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      amount: {
        currency_code: 'SGD',
        value: amount
      }
    }]
  };

  if (returnUrl || cancelUrl) {
    body.application_context = {};
    // allow overriding the brand shown in PayPal checkout via env var
    body.application_context.brand_name = process.env.PAYPAL_BRAND_NAME || 'FreshMart';
    if (returnUrl) body.application_context.return_url = returnUrl;
    if (cancelUrl) body.application_context.cancel_url = cancelUrl;
  }

  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function captureOrder(orderId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    }
  });
  const data = await response.json();
  console.log('PayPal captureOrder response:', data);
  return data;
}

async function refundCapture(captureId, amount, note = '') {
  const accessToken = await getAccessToken();
  const body = {
    amount: {
      currency_code: 'SGD',
      value: String(amount)
    }
  };
  if (note) body.note_to_payer = note;

  const response = await fetch(`${PAYPAL_API}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  console.log('PayPal refund response:', data);
  return data;
}

module.exports = { createOrder, captureOrder, refundCapture };

// Subscription helpers
async function createProduct(name) {
  const accessToken = await getAccessToken();
  const body = { name: String(name || 'Membership Product').substring(0, 127) };
  const response = await fetch(`${PAYPAL_API}/v1/catalogs/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function createPlan(productId, planName, amount, interval) {
  const accessToken = await getAccessToken();
  const body = {
    product_id: productId,
    name: String(planName || 'Membership Plan').substring(0, 127),
    billing_cycles: [
      {
        frequency: { interval_unit: (String(interval || 'MONTH').toUpperCase() === 'YEAR' ? 'YEAR' : 'MONTH'), interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: String(Number(amount || 0).toFixed(2)), currency_code: 'SGD' } }
      }
    ],
    payment_preferences: { auto_bill_outstanding: true, setup_fee: { value: '0', currency_code: 'SGD' }, setup_fee_failure_action: 'CONTINUE', payment_failure_threshold: 3 }
  };

  const response = await fetch(`${PAYPAL_API}/v1/billing/plans`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

// createSubscription: create a product -> plan -> subscription and return subscription object
async function createSubscription(amount, planName, interval, returnUrl = null, cancelUrl = null, customId = null) {
  const prod = await createProduct(planName);
  const productId = prod && prod.id;
  if (!productId) throw new Error('Failed to create PayPal product');
  const plan = await createPlan(productId, planName, amount, interval);
  const planId = plan && plan.id;
  if (!planId) throw new Error('Failed to create PayPal plan');

  const accessToken = await getAccessToken();
  const body = { plan_id: planId };
  if (customId) body.custom_id = String(customId).substring(0,127);
  body.application_context = {};
  // show configured brand name in subscription approval page
  body.application_context.brand_name = process.env.PAYPAL_BRAND_NAME || 'FreshMart';
  if (returnUrl) body.application_context.return_url = returnUrl;
  if (cancelUrl) body.application_context.cancel_url = cancelUrl;

  const response = await fetch(`${PAYPAL_API}/v1/billing/subscriptions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify(body)
  });
  return await response.json();
}

async function getSubscription(subscriptionId) {
  const accessToken = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}/v1/billing/subscriptions/${subscriptionId}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }
  });
  return await response.json();
}

module.exports = { createOrder, captureOrder, refundCapture, createSubscription, getSubscription };