const DeliveryAddress = require('../models/DeliveryAddress');
const db = require('../db');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

exports.list = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.status(401).json({ success: false, message: 'Not authenticated' });
  DeliveryAddress.findByUser(userId, (err, rows) => {
    if (err) return next(err);
    res.json({ success: true, addresses: rows || [] });
  });
};

exports.create = (req, res, next) => {
  const userId = uid(req);
  if (!userId) {
    if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(401).json({ success: false, message: 'Not authenticated' });
    return res.redirect('/login');
  }

  // Debug: log incoming payload and user id for troubleshooting
  try { console.log('[DeliveryAddress.create] userId=', userId, 'body=', req.body); } catch (e) { /* ignore logging errors */ }

  const payload = {
    recipient_name: req.body.recipient_name || req.body.recipientName,
    contact_number: req.body.contact_number || req.body.contactNumber,
    block_number: req.body.block_number || req.body.blockNumber,
    street_name: req.body.street_name || req.body.streetName,
    unit_number: req.body.unit_number || req.body.unitNumber,
    postal_code: req.body.postal_code || req.body.postalCode,
    country: req.body.country || 'Singapore',
    is_default: req.body.is_default === '1' || req.body.is_default === 1 || req.body.set_default === 'on'
  };

  // Server-side validation
  const errors = [];
  const contactRe = /^\d{8}$/;
  const blockRe = /^(?:\d{3}[A-Za-z]?|[A-Za-z]{3})$/;
  const unitRe = /^#?\d{2}-\d{2}$/;
  const postalRe = /^\d{6}$/;
  if (!payload.recipient_name || String(payload.recipient_name).trim().length < 1) errors.push('Recipient name is required');
  if (!contactRe.test(String(payload.contact_number || '').replace(/\s+/g, ''))) errors.push('Contact number must be exactly 8 digits');
  if (!blockRe.test(String(payload.block_number || '').trim())) errors.push('Block number must be 3 digits optionally followed by 1 letter, or 3 letters');
  if (!payload.street_name || String(payload.street_name).trim().length < 1) errors.push('Street name is required');
  if (!unitRe.test(String(payload.unit_number || '').trim())) errors.push('Unit number must follow format 12-34 (dash required)');
  if (!postalRe.test(String(payload.postal_code || '').replace(/\s+/g, ''))) errors.push('Postal code must be exactly 6 digits');
  if (String(payload.country || '').trim() !== 'Singapore') errors.push('Country must be Singapore');

  if (errors.length) {
    const msg = errors.join('; ');
    try { console.warn('[DeliveryAddress.create] validation failed for user', userId, 'errors=', errors); } catch (e) {}
    if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(400).json({ success: false, message: msg, errors });
    if (req.flash) req.flash('error', msg);
    return res.redirect('/cart/checkout');
  }
  DeliveryAddress.createForUser(userId, payload, (err, created) => {
    if (err) {
      try { console.error('[DeliveryAddress.create] DB error for user', userId, err && err.message); } catch (e) {}
      if (req.xhr || (req.headers.accept || '').includes('application/json')) return res.status(400).json({ success: false, message: err.message });
      if (req.flash) req.flash('error', err.message || 'Failed to save address');
      return res.redirect('/cart/checkout');
    }
    if (req.xhr || (req.headers.accept || '').includes('application/json')) {
      return res.json({ success: true, address: created || null });
    }
    if (req.flash) req.flash('success', 'Address saved');
    res.redirect('/cart/checkout');
  });
};

exports.setDefault = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');
  const addressId = Number(req.params.id || req.body.id);
  if (!addressId) return res.redirect('/cart/checkout');

  DeliveryAddress.setDefaultForUser(userId, addressId, (err) => {
    if (err) return next(err);
    if (req.flash) req.flash('success', 'Default address updated');
    res.redirect('/cart/checkout');
  });
};

exports.select = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');
  const addressId = Number(req.body.address_id || req.body.addressId || req.body.id);
  if (!addressId) return res.redirect('/cart/checkout');

  db.query('SELECT id FROM delivery_addresses WHERE id = ? AND user_id = ? LIMIT 1', [addressId, userId], (err, rows) => {
    if (err) return next(err);
    if (!rows || !rows[0]) {
      if (req.flash) req.flash('error', 'Address not found');
      return res.redirect('/cart/checkout');
    }
    req.session.selectedAddressId = addressId;
    if (req.flash) req.flash('success', 'Address selected');
    res.redirect('/cart/checkout');
  });
};
