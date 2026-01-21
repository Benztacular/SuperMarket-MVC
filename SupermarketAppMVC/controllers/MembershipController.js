const Membership = require('../models/Membership');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

const MembershipController = {
  /**
   * GET /api/membership/plans - Get all available plans
   */
  getPlans(req, res, next) {
    Membership.getAllPlans((err, plans) => {
      if (err) return res.status(500).json({ success: false, error: 'Failed to load plans' });
      return res.json({ success: true, plans: plans || [] });
    });
  },

  /**
   * GET /api/membership/current - Get user's current membership
   */
  getCurrentMembership(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    Membership.getUserMembership(userId, (err, membership) => {
      if (err) return res.status(500).json({ success: false, error: 'Failed to load membership' });
      return res.json({ success: true, membership: membership || null });
    });
  },

  /**
   * POST /api/membership/upgrade - Upgrade user membership
   */
  upgradeMembership(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    const planId = Number(req.body.planId || req.body.plan_id || 0);
    if (!planId) return res.status(400).json({ success: false, error: 'Invalid plan ID' });

    Membership.setUserMembership(userId, planId, (err, membership) => {
      if (err) {
        console.error('Upgrade membership error:', err);
        return res.status(500).json({ success: false, error: err.message || 'Failed to upgrade membership' });
      }

      // Update session
      if (req.session && req.session.user) {
        req.session.user.membership = membership.plan_name;
      }

      return res.json({ success: true, membership, message: 'Membership upgraded successfully' });
    });
  },

  /**
   * POST /api/membership/cancel - Cancel membership (revert to Free)
   */
  cancelMembership(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    Membership.cancelUserMembership(userId, (err, membership) => {
      if (err) {
        console.error('Cancel membership error:', err);
        return res.status(500).json({ success: false, error: 'Failed to cancel membership' });
      }

      // Update session
      if (req.session && req.session.user) {
        req.session.user.membership = 'Free';
      }

      return res.json({ success: true, membership, message: 'Membership cancelled' });
    });
  },

  /**
   * Helper: Get normalized membership name for views
   */
  getNormalizedName(userId, cb) {
    Membership.getNormalizedMembershipName(userId, cb);
  }
,

  /**
   * Renders the membership page with available plans and the user's current membership (if logged in)
   */
  membershipPage(req, res, next) {
    try {
      console.log('[MembershipController] membershipPage called; session.userId=', req.session && (req.session.userId || (req.session.user && (req.session.user.id || req.session.user.user_id))) );
      Membership.getAllPlans((err, plans) => {
        if (err) return next(err);
        const userId = (req.session && (req.session.userId || (req.session.user && (req.session.user.id || req.session.user.user_id)))) || null;
        if (!userId) return res.render('membership', { plans: plans || [], membership: null });
        Membership.getUserMembership(userId, (mErr, membership) => {
          if (mErr) return next(mErr);
          return res.render('membership', { plans: plans || [], membership: membership || null });
        });
      });
    } catch (e) { return next(e); }
  }
,

  /**
   * GET /membership/checkout - render membership payment page for a selected plan
   */
  checkoutPage(req, res, next) {
    try {
      const planId = Number(req.query.planId || req.body.planId || 0);
      if (!planId) return res.redirect('/membership');
      Membership.getPlanById(planId, (err, plan) => {
        if (err) return next(err);
        if (!plan) return res.redirect('/membership');
        // Normalize period
        const period = String(plan.billing_period || 'MONTHLY').toLowerCase();
        return res.render('membership_payment', { plan: plan, period: period });
      });
    } catch (e) { return next(e); }
  }
  ,

  // POST /membership/pay/paypal
  payWithPaypal(req, res, next) {
    try {
      const userId = uid(req);
      if (!userId) return res.redirect('/login');
      const planId = Number(req.body.planId || 0);
      if (!planId) return res.redirect('/membership');
      Membership.getPlanById(planId, async (err, plan) => {
        if (err) return next(err);
        if (!plan) return res.redirect('/membership');
        const amount = Number(plan.price || 0);
        const returnUrl = `${req.protocol}://${req.get('host')}/membership/paypal/return?planId=${planId}`;
        const cancelUrl = `${req.protocol}://${req.get('host')}/membership`;
        const paypalService = require('../services/paypal');
        const period = String(req.body.period || plan.billing_period || '').toLowerCase();

        // If this plan represents a recurring billing period, create a PayPal subscription
        if (period === 'monthly' || period === 'yearly' || String(plan.billing_period || '').toUpperCase().includes('MONTH') || String(plan.billing_period || '').toUpperCase().includes('YEAR')) {
          try {
            const customId = `u:${userId}|p:${planId}`;
            const sub = await paypalService.createSubscription(amount.toFixed(2), plan.plan_name || 'Membership', (period === 'yearly' ? 'YEAR' : 'MONTH'), returnUrl, cancelUrl, customId);
            const approve = (sub && sub.links && sub.links.find(l => l.rel === 'approve')) || null;
            if (approve && approve.href) return res.redirect(approve.href);
            return res.redirect('/membership');
          } catch (ex) {
            console.error('paypal subscription create error', ex);
            // fallback to one-time order
          }
        }

        // fallback: create one-time order (non-recurring)
        const order = await paypalService.createOrder(amount.toFixed(2), returnUrl, cancelUrl);
        const approve = (order && order.links && order.links.find(l => l.rel === 'approve')) || null;
        if (approve && approve.href) return res.redirect(approve.href);
        return res.redirect('/membership');
      });
    } catch (e) { next(e); }
  },

  // GET /membership/paypal/return
  paypalReturn(req, res, next) {
    try {
      // PayPal may return a one-time order token or a subscription id after approval
      const orderID = req.query.token || req.query.orderID || req.query.orderId || req.query.orderID;
      const subscriptionId = req.query.subscription_id || req.query.subscriptionId || req.query.subscription;
      const planId = Number(req.query.planId || req.body.planId || 0);
      const paypalService = require('../services/paypal');

      if (subscriptionId) {
        // subscription flow: verify subscription status and apply membership
        paypalService.getSubscription(subscriptionId).then((sub) => {
          const status = sub && sub.status;
          const userId = uid(req);
          if (!userId) return res.redirect('/login');
          // For safety, try to parse custom_id if planId not provided
          let resolvedPlanId = planId || 0;
          try {
            const custom = sub.custom_id || '';
            if (!resolvedPlanId && custom) {
              const m = String(custom).match(/p:(\d+)/);
              if (m) resolvedPlanId = Number(m[1]);
            }
          } catch (e) { /* ignore */ }
          if (status && (String(status).toUpperCase() === 'ACTIVE' || String(status).toUpperCase() === 'APPROVED')) {
            if (resolvedPlanId) {
              // fetch plan, set membership, then render success
              Membership.getPlanById(resolvedPlanId, (gpErr, planObj) => {
                Membership.setUserMembership(userId, resolvedPlanId, (err) => {
                  if (err) console.error('membership set after paypal subscription', err);
                  const period = (planObj && planObj.billing_period) ? String(planObj.billing_period).toLowerCase() : 'monthly';
                  const amount = (planObj && planObj.price) ? planObj.price : 0;
                  return res.render('membership_success', { plan: planObj || {}, period: period, amount: amount, subscriptionId: subscriptionId });
                });
              });
            } else {
              return res.redirect('/membership');
            }
          } else {
            return res.redirect('/membership');
          }
        }).catch((ex) => { console.error('paypal get subscription error', ex); return res.redirect('/membership'); });
        return;
      }

      // fallback: handle one-time order capture
      if (!orderID || !planId) return res.redirect('/membership');
      paypalService.captureOrder(orderID).then((capture) => {
        const payerStatus = capture && capture.status;
        if (!payerStatus) return res.redirect('/membership');
        const userId = uid(req);
        if (!userId) return res.redirect('/login');
        // fetch plan, set membership, then render success
        Membership.getPlanById(planId, (gpErr, planObj) => {
          Membership.setUserMembership(userId, planId, (err, membership) => {
            if (err) console.error('membership set after paypal', err);
            const period = (planObj && planObj.billing_period) ? String(planObj.billing_period).toLowerCase() : 'monthly';
            const amount = (planObj && planObj.price) ? planObj.price : 0;
            return res.render('membership_success', { plan: planObj || {}, period: period, amount: amount, subscriptionId: null });
          });
        });
      }).catch((ex) => { console.error('paypal capture error', ex); return res.redirect('/membership'); });
    } catch (e) { next(e); }
  },

  // POST /membership/pay/stripe - create Stripe Checkout session and redirect
  payWithStripe(req, res, next) {
    try {
      const userId = uid(req);
      if (!userId) return res.redirect('/login');
      const planId = Number(req.body.planId || 0);
      if (!planId) return res.redirect('/membership');
      Membership.getPlanById(planId, async (err, plan) => {
        if (err) return next(err);
        if (!plan) return res.redirect('/membership');
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
        const amount = Math.round((Number(plan.price || 0) || 0) * 100);
        const period = String(req.body.period || plan.billing_period || '').toLowerCase();

        if (period === 'monthly' || period === 'yearly' || String(plan.billing_period || '').toUpperCase().includes('MONTH') || String(plan.billing_period || '').toUpperCase().includes('YEAR')) {
          // create subscription via Checkout
          const interval = (period === 'yearly' ? 'year' : 'month');
          const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{
              price_data: {
                currency: 'sgd',
                product_data: { name: plan.plan_name },
                unit_amount: amount,
                recurring: { interval: interval }
              }, quantity: 1
            }],
            subscription_data: { metadata: { userId: String(userId), planId: String(planId) } },
            success_url: `${req.protocol}://${req.get('host')}/membership/stripe/success?planId=${planId}&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/membership`
          });
          return res.redirect(303, session.url);
        }

        // fallback to one-time payment
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'payment',
          line_items: [{ price_data: { currency: 'sgd', product_data: { name: plan.plan_name }, unit_amount: amount }, quantity: 1 }],
          success_url: `${req.protocol}://${req.get('host')}/membership/stripe/success?planId=${planId}&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${req.protocol}://${req.get('host')}/membership`
        });
        return res.redirect(303, session.url);
      });
    } catch (e) { next(e); }
  },

  // GET /membership/stripe/success
  stripeSuccess(req, res, next) {
    try {
      const sessionId = req.query.session_id;
      const planId = Number(req.query.planId || 0);
      if (!sessionId || !planId) return res.redirect('/membership');
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
      stripe.checkout.sessions.retrieve(sessionId).then((session) => {
        // If this was a subscription checkout, look up subscription metadata
          if (session && (session.payment_status === 'paid' || session.status === 'complete' || session.mode === 'subscription')) {
          const userId = uid(req);
          if (!userId) return res.redirect('/login');
          // If subscription, try to retrieve metadata from the subscription
          if (session.subscription) {
            stripe.subscriptions.retrieve(session.subscription).then((sub) => {
              const metadata = sub && sub.metadata ? sub.metadata : {};
              const resolvedPlan = Number(metadata.planId || planId);
              const resolvedUser = Number(metadata.userId || userId);
              // fetch plan details then set membership and render success
              Membership.getPlanById(resolvedPlan, (gpErr, planObj) => {
                Membership.setUserMembership(resolvedUser, resolvedPlan, (err) => {
                  if (err) console.error('set membership after stripe sub', err);
                  const period = (planObj && planObj.billing_period) ? String(planObj.billing_period).toLowerCase() : 'monthly';
                  const amount = (planObj && planObj.price) ? planObj.price : 0;
                  return res.render('membership_success', { plan: planObj || {}, period: period, amount: amount, subscriptionId: sub && sub.id });
                });
              });
            }).catch((ex) => { console.error('stripe sub retrieve err', ex); return res.redirect('/membership'); });
          } else {
            // one-time payment
            Membership.getPlanById(planId, (gpErr, planObj) => {
              Membership.setUserMembership(userId, planId, (err) => {
                if (err) console.error('set membership after stripe', err);
                const period = (planObj && planObj.billing_period) ? String(planObj.billing_period).toLowerCase() : 'monthly';
                const amount = (planObj && planObj.price) ? planObj.price : 0;
                return res.render('membership_success', { plan: planObj || {}, period: period, amount: amount, subscriptionId: null });
              });
            });
          }
        } else {
          return res.redirect('/membership');
        }
      }).catch((ex) => { console.error('stripe session retrieve err', ex); return res.redirect('/membership'); });
    } catch (e) { next(e); }
  },

  // Stripe webhook endpoint to handle recurring invoice payments
  stripeWebhook(req, res, next) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
      const sig = req.headers['stripe-signature'];
      let event;
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
      } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === 'invoice.payment_succeeded') {
        const invoice = event.data.object;
        const subscriptionId = invoice.subscription;
        if (subscriptionId) {
          stripe.subscriptions.retrieve(subscriptionId).then((sub) => {
            const metadata = sub && sub.metadata ? sub.metadata : {};
            const userId = Number(metadata.userId || 0);
            const planId = Number(metadata.planId || 0);
            if (userId && planId) {
              Membership.setUserMembership(userId, planId, (err) => { if (err) console.error('stripe webhook set membership', err); });
            }
          }).catch(err => console.error('stripe sub retrieve webhook err', err));
        }
      }
      return res.json({ received: true });
    } catch (e) { next(e); }
  },

  // PayPal webhook endpoint: verify subscription events and apply membership
  paypalWebhook(req, res, next) {
    try {
      const body = req.body || {};
      const event = body.event_type || '';
      if (!event) return res.status(400).send('No event');
      const paypalService = require('../services/paypal');
      // interested in subscription activated / payment succeeded events
      if (event === 'BILLING.SUBSCRIPTION.ACTIVATED' || event === 'PAYMENT.SALE.COMPLETED' || event === 'BILLING.SUBSCRIPTION.PAYMENT.SUCCEEDED') {
        const resource = body.resource || {};
        const subscriptionId = resource.id || resource.subscription_id || (resource.billing_agreement_id) || null;
        if (subscriptionId) {
          paypalService.getSubscription(subscriptionId).then((sub) => {
            try {
              const custom = sub && sub.custom_id || '';
              let userId = null, planId = null;
              if (custom) {
                const mu = String(custom).match(/u:(\d+)/);
                const mp = String(custom).match(/p:(\d+)/);
                if (mu) userId = Number(mu[1]);
                if (mp) planId = Number(mp[1]);
              }
              if (userId && planId) {
                Membership.setUserMembership(userId, planId, (err) => { if (err) console.error('paypal webhook set membership', err); });
              }
            } catch (e) { console.error('paypal webhook processing error', e); }
          }).catch(err => console.error('paypal get subscription webhook err', err));
        }
      }
      return res.json({ received: true });
    } catch (e) { next(e); }
  },

  // POST /membership/pay/nets - set session and forward to nets-qr generator
  payWithNets(req, res, next) {
    try {
      const userId = uid(req);
      if (!userId) return res.redirect('/login');
      const planId = Number(req.body.planId || 0);
      const total = Number(req.body.cartTotal || 0);
      const period = String(req.body.period || 'monthly').toLowerCase();
      if (!planId || total <= 0) return res.redirect('/membership');
      // store pending membership in session so Nets success handler can apply it
      req.session.pendingMembership = { planId: planId, period: period }; 
      // delegate to NETS service to render QR view directly
      const netsService = require('../services/nets');
      req.body = req.body || {};
      req.body.cartTotal = total;
      return netsService.generateQrCode(req, res, next);
    } catch (e) { next(e); }
  }
};

module.exports = MembershipController;
