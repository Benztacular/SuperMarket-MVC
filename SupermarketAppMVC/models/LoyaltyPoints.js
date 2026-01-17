const db = require('../db');

function safeCb(cb) { return typeof cb === 'function' ? cb : () => {}; }

function query(sql, params, cb) {
  cb = safeCb(cb);
  try {
    if (typeof db.query === 'function') return db.query(sql, params, cb);
    if (db && db.pool && typeof db.pool.query === 'function') return db.pool.query(sql, params, cb);
    throw new Error('DB client has no query method');
  } catch (err) { cb(err); }
}

// Tier thresholds
const BRONZE_TO_SILVER = 5000;
const SILVER_TO_GOLD = 25000;

const LoyaltyPoints = {
  /**
   * Get or create loyalty account for user
   */
  getOrCreateAccount(userId, cb) {
    cb = safeCb(cb);
    const sql = 'SELECT * FROM loyalty_accounts WHERE user_id = ? LIMIT 1';
    query(sql, [Number(userId)], (err, rows) => {
      if (err) return cb(err);
      if (rows && rows.length > 0) return cb(null, rows[0]);

      // Create account
      const insertSql = 'INSERT INTO loyalty_accounts (user_id, points, tier, createdAt) VALUES (?, 0, "Bronze", NOW())';
      query(insertSql, [Number(userId)], (insertErr) => {
        if (insertErr) return cb(insertErr);
        query(sql, [Number(userId)], (err2, rows2) => {
          if (err2) return cb(err2);
          cb(null, (rows2 && rows2[0]) || null);
        });
      });
    });
  },

  /**
   * Get loyalty account with progress calculation
   */
  getAccountWithProgress(userId, cb) {
    cb = safeCb(cb);
    LoyaltyPoints.getOrCreateAccount(userId, (err, account) => {
      if (err) return cb(err);
      if (!account) return cb(new Error('Failed to create loyalty account'));

      const points = Number(account.points) || 0;
      const tier = String(account.tier || 'Bronze').toLowerCase();
      
      let progress = 0;
      let nextThreshold = BRONZE_TO_SILVER;

      if (tier === 'bronze') {
        nextThreshold = BRONZE_TO_SILVER;
        progress = Math.min(100, Math.round((points / BRONZE_TO_SILVER) * 100));
      } else if (tier === 'silver') {
        nextThreshold = SILVER_TO_GOLD;
        progress = Math.min(100, Math.round(((points - BRONZE_TO_SILVER) / (SILVER_TO_GOLD - BRONZE_TO_SILVER)) * 100));
      } else {
        // Gold
        nextThreshold = points;
        progress = 100;
      }

      cb(null, {
        ...account,
        points,
        tier: account.tier || 'Bronze',
        progress,
        nextThreshold
      });
    });
  },

  /**
   * Add points to user account (EARN transaction)
   */
  addPoints(userId, points, orderId, description, cb) {
    cb = safeCb(cb);
    const pointsInt = Math.round(Number(points) || 0);
    if (pointsInt <= 0) return cb(new Error('Points must be positive'));

    // Update loyalty account
    const updateSql = 'UPDATE loyalty_accounts SET points = points + ?, updatedAt = NOW() WHERE user_id = ?';
    query(updateSql, [pointsInt, Number(userId)], (err) => {
      if (err) return cb(err);

      // Insert transaction
      const insertSql = `
        INSERT INTO loyalty_points_transactions (user_id, order_id, type, points, description, createdAt)
        VALUES (?, ?, 'EARN', ?, ?, NOW())
      `;
      query(insertSql, [Number(userId), orderId || null, pointsInt, description || 'Points earned'], (txErr, result) => {
        if (txErr) return cb(txErr);

        // Auto-upgrade tier if thresholds met
        LoyaltyPoints.updateTier(userId, (tierErr) => {
          if (tierErr) console.error('Tier update error:', tierErr);
          cb(null, { pointsAdded: pointsInt, transactionId: result && result.insertId });
        });
      });
    });
  },

  /**
   * Deduct points from user account (SPEND transaction)
   */
  deductPoints(userId, points, description, cb) {
    cb = safeCb(cb);
    const pointsInt = Math.round(Number(points) || 0);
    if (pointsInt <= 0) return cb(new Error('Points must be positive'));

    // Check if user has enough points (SELECT FOR UPDATE should be done in controller transaction)
    const checkSql = 'SELECT points FROM loyalty_accounts WHERE user_id = ? LIMIT 1';
    query(checkSql, [Number(userId)], (checkErr, rows) => {
      if (checkErr) return cb(checkErr);
      if (!rows || !rows.length) return cb(new Error('Loyalty account not found'));
      
      const currentPoints = Number(rows[0].points || 0);
      if (currentPoints < pointsInt) return cb(new Error('Insufficient points'));

      // Deduct points
      const updateSql = 'UPDATE loyalty_accounts SET points = points - ?, updatedAt = NOW() WHERE user_id = ?';
      query(updateSql, [pointsInt, Number(userId)], (err) => {
        if (err) return cb(err);

        // Insert transaction
        const insertSql = `
          INSERT INTO loyalty_points_transactions (user_id, order_id, type, points, description, createdAt)
          VALUES (?, NULL, 'SPEND', ?, ?, NOW())
        `;
        query(insertSql, [Number(userId), pointsInt, description || 'Points redeemed'], (txErr, result) => {
          if (txErr) return cb(txErr);
          cb(null, { pointsDeducted: pointsInt, transactionId: result && result.insertId });
        });
      });
    });
  },

  /**
   * Update user's tier based on current points
   */
  updateTier(userId, cb) {
    cb = safeCb(cb);
    const sql = 'SELECT points, tier FROM loyalty_accounts WHERE user_id = ? LIMIT 1';
    query(sql, [Number(userId)], (err, rows) => {
      if (err) return cb(err);
      if (!rows || !rows.length) return cb(null);

      const points = Number(rows[0].points || 0);
      const currentTier = String(rows[0].tier || 'Bronze');
      let newTier = 'Bronze';

      if (points >= SILVER_TO_GOLD) {
        newTier = 'Gold';
      } else if (points >= BRONZE_TO_SILVER) {
        newTier = 'Silver';
      }

      if (newTier === currentTier) return cb(null); // No change

      const updateSql = 'UPDATE loyalty_accounts SET tier = ?, updatedAt = NOW() WHERE user_id = ?';
      query(updateSql, [newTier, Number(userId)], cb);
    });
  },

  /**
   * Get all active rewards
   */
  getActiveRewards(cb) {
    cb = safeCb(cb);
    const sql = `
      SELECT id, title, description, reward_type, points_cost, min_spend, 
             discount_amount, discount_percent, valid_days, wallet_credit
      FROM loyalty_rewards 
      WHERE is_active = 1 
      ORDER BY points_cost ASC
    `;
    query(sql, [], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows || []);
    });
  },

  /**
   * Get reward by ID
   */
  getRewardById(rewardId, cb) {
    cb = safeCb(cb);
    const sql = `
      SELECT id, title, description, reward_type, points_cost, min_spend,
             discount_amount, discount_percent, valid_days, wallet_credit
      FROM loyalty_rewards 
      WHERE id = ? AND is_active = 1 
      LIMIT 1
    `;
    query(sql, [Number(rewardId)], (err, rows) => {
      if (err) return cb(err);
      cb(null, (rows && rows[0]) || null);
    });
  },

  /**
   * Create redemption record
   */
  createRedemption(userId, reward, cb) {
    cb = safeCb(cb);
    const expiresAt = reward.valid_days 
      ? new Date(Date.now() + (Number(reward.valid_days) * 24 * 60 * 60 * 1000))
      : null;

    const sql = `
      INSERT INTO loyalty_redemptions 
      (user_id, reward_id, status, redeemedAt, expiresAt, points_cost, reward_type, 
       discount_amount, discount_percent, min_spend, wallet_credit)
      VALUES (?, ?, 'ACTIVE', NOW(), ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const params = [
      Number(userId),
      Number(reward.id),
      expiresAt,
      Number(reward.points_cost || 0),
      reward.reward_type,
      reward.discount_amount || null,
      reward.discount_percent || null,
      reward.min_spend || null,
      reward.wallet_credit || null
    ];

    query(sql, params, (err, result) => {
      if (err) return cb(err);
      cb(null, { redemptionId: result && result.insertId });
    });
  },

  /**
   * Get user's active redemptions
   */
  getUserRedemptions(userId, cb) {
    cb = safeCb(cb);
    const sql = `
      SELECT lr.*, lrw.title, lrw.description
      FROM loyalty_redemptions lr
      LEFT JOIN loyalty_rewards lrw ON lr.reward_id = lrw.id
      WHERE lr.user_id = ? AND lr.status = 'ACTIVE'
      ORDER BY lr.redeemedAt DESC
    `;
    query(sql, [Number(userId)], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows || []);
    });
  },

  /**
   * Get points transactions for a specific order
   */
  getPointsForOrder(userId, orderId, cb) {
    cb = safeCb(cb);
    const sql = `
      SELECT SUM(points) as total_points 
      FROM loyalty_points_transactions 
      WHERE user_id = ? AND order_id = ? AND type = 'EARN'
    `;
    query(sql, [Number(userId), Number(orderId)], (err, rows) => {
      if (err) return cb(err);
      const total = (rows && rows[0] && Number(rows[0].total_points)) || 0;
      cb(null, total);
    });
  }
};

module.exports = LoyaltyPoints;
