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

const Membership = {
  /**
   * Get all active membership plans
   */
  getAllPlans(cb) {
    cb = safeCb(cb);
    const sql = 'SELECT * FROM membership_plans WHERE is_active = 1 ORDER BY tier_level ASC, billing_period ASC';
    query(sql, [], (err, rows) => {
      if (err) return cb(err);
      cb(null, rows || []);
    });
  },

  /**
   * Get a specific plan by ID
   */
  getPlanById(planId, cb) {
    cb = safeCb(cb);
    const sql = 'SELECT * FROM membership_plans WHERE id = ? LIMIT 1';
    query(sql, [Number(planId)], (err, rows) => {
      if (err) return cb(err);
      cb(null, (rows && rows[0]) || null);
    });
  },

  /**
   * Get user's active membership
   */
  getUserMembership(userId, cb) {
    cb = safeCb(cb);
    const sql = `
      SELECT um.*, mp.plan_name, mp.tier_level, mp.billing_period, mp.price, mp.duration_days,
             mp.free_standard_delivery, mp.priority_delivery_discount, mp.points_multiplier,
             mp.free_delivery_threshold, mp.discount_threshold, mp.discount_percent
      FROM user_memberships um
      JOIN membership_plans mp ON um.plan_id = mp.id
      WHERE um.user_id = ?
      ORDER BY um.start_date DESC LIMIT 1
    `;
    query(sql, [Number(userId)], (err, rows) => {
      if (err) return cb(err);
      const row = (rows && rows[0]) || null;
      if (row && row.plan_name) {
        // Normalize plan name and apply policy overrides for discounts
        const norm = String(row.plan_name).replace(/\s*\(.*?\)\s*$/, '').toLowerCase();
        if (norm.includes('standard')) {
          row.discount_percent = 5;
        } else if (norm.includes('freshplus') || norm.includes('fresh plus')) {
          row.discount_percent = 15;
        }
      }
      cb(null, row);
    });
  },

  /**
   * Get normalized membership name (without billing suffix)
   */
  getNormalizedMembershipName(userId, cb) {
    cb = safeCb(cb);
    Membership.getUserMembership(userId, (err, membership) => {
      if (err) return cb(err);
      if (!membership || !membership.plan_name) return cb(null, 'Free');
      
      // Remove billing suffix like " (Monthly)" or " (Yearly)"
      let name = String(membership.plan_name).replace(/\s*\(.*?\)\s*$/, '');
      cb(null, name);
    });
  },

  /**
   * Create or update user membership
   */
  setUserMembership(userId, planId, cb) {
    cb = safeCb(cb);
    
    // Get plan details to calculate end_date
    Membership.getPlanById(planId, (err, plan) => {
      if (err) return cb(err);
      if (!plan) return cb(new Error('Plan not found'));

      const endDate = plan.duration_days 
        ? new Date(Date.now() + (plan.duration_days * 24 * 60 * 60 * 1000))
        : null;

      // Determine stored status: free plans are 'FREE', paid plans are 'ACTIVE'
      const statusToSet = (Number(plan.price) === 0) ? 'FREE' : 'ACTIVE';

      // Check if user already has a membership
      const checkSql = 'SELECT id FROM user_memberships WHERE user_id = ? LIMIT 1';
      query(checkSql, [Number(userId)], (checkErr, rows) => {
        if (checkErr) return cb(checkErr);

        if (rows && rows.length > 0) {
          // Update existing
          const updateSql = `
            UPDATE user_memberships 
            SET plan_id = ?, start_date = NOW(), end_date = ?, status = ?, updated_at = NOW()
            WHERE user_id = ?
          `;
          query(updateSql, [Number(planId), endDate, statusToSet, Number(userId)], (updateErr) => {
            if (updateErr) return cb(updateErr);
            Membership.getUserMembership(userId, cb);
          });
        } else {
          // Insert new
          const insertSql = `
            INSERT INTO user_memberships (user_id, plan_id, start_date, end_date, status, created_at)
            VALUES (?, ?, NOW(), ?, ?, NOW())
          `;
          query(insertSql, [Number(userId), Number(planId), endDate, statusToSet], (insertErr) => {
            if (insertErr) return cb(insertErr);
            Membership.getUserMembership(userId, cb);
          });
        }
      });
    });
  },

  /**
   * Cancel user membership (set to Free plan)
   */
  cancelUserMembership(userId, cb) {
    cb = safeCb(cb);
    
    // Get Free plan ID
    const freePlanSql = 'SELECT id FROM membership_plans WHERE plan_name = "Free" LIMIT 1';
    query(freePlanSql, [], (err, rows) => {
      if (err) return cb(err);
      if (!rows || !rows.length) return cb(new Error('Free plan not found'));
      
      const freePlanId = rows[0].id;
      Membership.setUserMembership(userId, freePlanId, cb);
    });
  },

  /**
   * Schedule cancellation at end_date (mark membership as CANCELLED but keep benefits
   * until the configured end_date; expireOldMemberships will migrate to Free when end_date passes)
   */
  scheduleCancelUserMembership(userId, cb) {
    cb = safeCb(cb);
    const sql = `
      UPDATE user_memberships
      SET status = 'CANCELLED', updated_at = NOW()
      WHERE user_id = ?
        AND (status = 'MEMBERSHIP ACTIVE' OR status = 'ACTIVE')
    `;
    query(sql, [Number(userId)], (err, result) => {
      if (err) return cb(err);
      // Return the current membership row for feedback
      Membership.getUserMembership(userId, cb);
    });
  },

  /**
   * Check and expire memberships (for cron jobs)
   */
  expireOldMemberships(cb) {
    cb = safeCb(cb);
    // Revert expired paid memberships back to the Free plan and mark as FREE
    const sql = `
      UPDATE user_memberships um
      JOIN membership_plans mp_free ON mp_free.plan_name = 'Free'
        SET um.plan_id = 1,
          um.provider = 'system',
          um.provider_subscription_id = NULL,
          um.amount = mp_free.price,
          um.period = mp_free.billing_period,
          um.start_date = NOW(),
          um.end_date = NULL,
          um.status = 'FREE',
          um.raw_response = NULL,
          um.updated_at = NOW()
      WHERE um.end_date IS NOT NULL
        AND um.end_date <= NOW()
        AND (um.status = 'ACTIVE' OR um.status = 'CANCELLED');
    `;
    query(sql, [], (err, result) => {
      if (err) return cb(err);
      cb(null, result);
    });
  }
};

module.exports = Membership;
