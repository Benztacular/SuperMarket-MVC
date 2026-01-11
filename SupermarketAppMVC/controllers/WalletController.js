const Wallet = require('../models/Wallet');
const db = require('../db');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

exports.page = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');
  Wallet.findByUserId(userId, (err, wallet) => {
    if (err) return next(err);
    const ensureWallet = (cb) => {
      if (wallet) return cb(null, wallet);
      Wallet.createForUser(userId, (cErr) => {
        if (cErr) return cb(cErr);
        Wallet.findByUserId(userId, cb);
      });
    };

    ensureWallet((e, w) => {
      if (e) return next(e);
      Wallet.getTransactionsByUserId(userId, (tErr, txs) => {
        if (tErr) return next(tErr);
        const flashErrors = typeof req.flash === 'function' ? req.flash('error') : [];
        const flashSuccess = typeof req.flash === 'function' ? req.flash('success') : [];
        res.render('wallet', {
          wallet: w || { balance: 0.00 },
          transactions: txs || [],
          error: flashErrors,
          success: flashSuccess
        });
      });
    });
  });
};

exports.topUp = (req, res, next) => {
  const userId = uid(req);
  if (!userId) return res.redirect('/login');

  const raw = req.body.amount || req.body.topup || req.body.value;
  const amount = Number(String(raw || '').replace(/[,$\s]/g, '')) || 0;
  if (!amount || amount <= 0) {
    if (req.flash) req.flash('error', 'Invalid top-up amount');
    return res.redirect('/wallet');
  }

  // ensure wallet exists, then update balance and add a transaction
  Wallet.findByUserId(userId, (err, wallet) => {
    if (err) return next(err);
    const ensureAndTop = (cb) => {
      if (wallet) return cb(null, wallet);
      Wallet.createForUser(userId, (cErr) => {
        if (cErr) return cb(cErr);
        Wallet.findByUserId(userId, cb);
      });
    };

    ensureAndTop((e, w) => {
      if (e) return next(e);
      Wallet.updateBalanceByUserId(userId, amount, (uErr, updated) => {
        if (uErr) return next(uErr);
        // add transaction record
        const walletId = (updated && updated.id) || (w && w.id) || null;
        Wallet.addTransaction({
          wallet_id: walletId,
          user_id: userId,
          type: 'TOP_UP',
          amount: amount,
          reference_type: 'MANUAL',
          reference_id: null,
          description: `Top-up ${amount.toFixed(2)}`
        }, (tErr) => {
          if (tErr) return next(tErr);
          if (req.flash) req.flash('success', 'Wallet topped up');
          res.redirect('/wallet');
        });
      });
    });
  });
};
