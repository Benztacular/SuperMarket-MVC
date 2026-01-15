require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('WARNING: STRIPE_SECRET_KEY not configured in .env file');
}

/**
 * Create a Stripe Payment Intent
 * @param {number} amount - Amount in SGD
 * @param {object} metadata - Additional metadata for the payment
 * @returns {Promise<object>} - Stripe PaymentIntent object
 */
async function createPaymentIntent(amount, metadata = {}) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured. Please add STRIPE_SECRET_KEY to your .env file');
  }
  
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency: 'sgd',
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: metadata
    });
    
    console.log('Stripe createPaymentIntent:', paymentIntent.id);
    return paymentIntent;
  } catch (error) {
    console.error('Stripe createPaymentIntent error:', error);
    throw error;
  }
}

/**
 * Retrieve a Payment Intent by ID
 * @param {string} paymentIntentId - The Stripe Payment Intent ID
 * @returns {Promise<object>} - Stripe PaymentIntent object
 */
async function retrievePaymentIntent(paymentIntentId) {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured. Please add STRIPE_SECRET_KEY to your .env file');
  }
  
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    console.log('Stripe retrievePaymentIntent:', paymentIntent.id, paymentIntent.status);
    return paymentIntent;
  } catch (error) {
    console.error('Stripe retrievePaymentIntent error:', error);
    throw error;
  }
}

/**
 * Create a refund for a Stripe payment
 * @param {string} paymentIntentId - The payment intent to refund
 * @param {number} amount - Amount to refund in SGD (optional, defaults to full refund)
 * @param {string} reason - Reason for refund
 * @returns {Promise<object>} - Stripe Refund object
 */
async function createRefund(paymentIntentId, amount = null, reason = '') {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured. Please add STRIPE_SECRET_KEY to your .env file');
  }
  
  try {
    const refundData = {
      payment_intent: paymentIntentId,
    };
    
    if (amount !== null) {
      refundData.amount = Math.round(amount * 100); // Convert to cents
    }
    
    if (reason) {
      refundData.metadata = { reason };
    }
    
    const refund = await stripe.refunds.create(refundData);
    console.log('Stripe refund created:', refund.id, refund.status);
    return refund;
  } catch (error) {
    console.error('Stripe createRefund error:', error);
    throw error;
  }
}

module.exports = {
  createPaymentIntent,
  retrievePaymentIntent,
  createRefund
};
