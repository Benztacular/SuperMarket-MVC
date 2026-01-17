const LoyaltyPoints = require('../models/LoyaltyPoints');
const db = require('../db');

function uid(req) {
  const u = req.session?.user;
  return (req.session?.userId) || (u && (u.id || u.user_id || u.userId)) || null;
}

const LoyaltyPointsController = {
  /**
   * GET /api/loyalty/account - Get user's loyalty account with progress
   */
  getAccount(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    LoyaltyPoints.getAccountWithProgress(userId, (err, account) => {
      if (err) return res.status(500).json({ success: false, error: 'Failed to load loyalty account' });
      return res.json({ success: true, account: account || null });
    });
  },

  /**
   * GET /api/loyalty/rewards - Get rewards catalog with user's points
   */
  getRewards(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    // Get user's current points
    LoyaltyPoints.getOrCreateAccount(userId, (aErr, account) => {
      if (aErr) return res.status(500).json({ success: false, error: 'Failed to load loyalty account' });
      
      const points = (account && Number(account.points)) || 0;
      const tier = (account && account.tier) || 'Bronze';

      // Load active rewards
      LoyaltyPoints.getActiveRewards((rErr, rewards) => {
        if (rErr) return res.status(500).json({ success: false, error: 'Failed to load rewards' });
        return res.json({ success: true, points, tier, rewards: rewards || [] });
      });
    });
  },

  /**
   * POST /api/loyalty/redeem - Redeem a reward
   */
  redeemReward(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });
    
    const rewardId = Number(req.body.rewardId || req.body.id || 0);
    if (!rewardId) return res.status(400).json({ success: false, error: 'Invalid reward id' });

    // Use transaction for atomic redemption
    const conn = db;
    conn.beginTransaction((txErr) => {
      if (txErr) return res.status(500).json({ success: false, error: 'Transaction begin failed' });

      // Lock user's loyalty row
      conn.query('SELECT points FROM loyalty_accounts WHERE user_id = ? FOR UPDATE', [userId], (aErr, aRows = []) => {
        if (aErr) {
          conn.rollback(() => {});
          return res.status(500).json({ success: false, error: 'Failed to lock loyalty account' });
        }
        if (!aRows || !aRows.length) {
          conn.rollback(() => {});
          return res.status(404).json({ success: false, error: 'Loyalty account not found' });
        }
        
        const currentPoints = Number(aRows[0].points || 0);

        // Load reward
        LoyaltyPoints.getRewardById(rewardId, (rErr, reward) => {
          if (rErr) {
            conn.rollback(() => {});
            return res.status(500).json({ success: false, error: 'Failed to load reward' });
          }
          if (!reward) {
            conn.rollback(() => {});
            return res.status(404).json({ success: false, error: 'Reward not found' });
          }

          const cost = Number(reward.points_cost || 0);
          if (currentPoints < cost) {
            conn.rollback(() => {});
            return res.status(400).json({ success: false, error: 'Insufficient points', message: 'Insufficient points' });
          }

          // Deduct points
          conn.query('UPDATE loyalty_accounts SET points = points - ?, updatedAt = NOW() WHERE user_id = ?', [cost, userId], (uErr) => {
            if (uErr) {
              conn.rollback(() => {});
              return res.status(500).json({ success: false, error: 'Failed to update points' });
            }

            // Create redemption record
            LoyaltyPoints.createRedemption(userId, reward, (crErr, redemption) => {
              if (crErr) {
                conn.rollback(() => {});
                return res.status(500).json({ success: false, error: 'Failed to create redemption' });
              }

              // Insert points transaction (SPEND)
              const txSql = `
                INSERT INTO loyalty_points_transactions (user_id, order_id, type, points, description, createdAt)
                VALUES (?, NULL, 'SPEND', ?, ?, NOW())
              `;
              conn.query(txSql, [userId, cost, `Redeemed ${reward.title} (id:${reward.id})`], (txInsErr) => {
                if (txInsErr) {
                  conn.rollback(() => {});
                  return res.status(500).json({ success: false, error: 'Failed to record points transaction' });
                }

                // Commit
                conn.commit((cErr) => {
                  if (cErr) {
                    conn.rollback(() => {});
                    return res.status(500).json({ success: false, error: 'Commit failed' });
                  }
                  
                  const newPoints = currentPoints - cost;
                  return res.json({ 
                    success: true, 
                    redemptionId: redemption.redemptionId,
                    pointsSpent: cost,
                    points: newPoints,
                    newPoints: newPoints,
                    message: 'Reward claimed successfully!'
                  });
                });
              });
            });
          });
        });
      });
    });
  },

  /**
   * GET /api/loyalty/redemptions - Get user's active redemptions
   */
  getUserRedemptions(req, res, next) {
    const userId = uid(req);
    if (!userId) return res.status(401).json({ success: false, error: 'Not authenticated' });

    LoyaltyPoints.getUserRedemptions(userId, (err, redemptions) => {
      if (err) return res.status(500).json({ success: false, error: 'Failed to load redemptions' });
      return res.json({ success: true, redemptions: redemptions || [] });
    });
  },

  /**
   * Helper: Award points for an order (called from OrderController)
   */
  awardPointsForOrder(userId, orderId, orderTotal, cb) {
    if (typeof cb !== 'function') cb = () => {};

    // Check if points already awarded for this order
    const checkSql = 'SELECT id FROM loyalty_points_transactions WHERE user_id = ? AND order_id = ? AND type = "EARN" LIMIT 1';
    db.query(checkSql, [userId, orderId], (checkErr, checkRows) => {
      if (checkErr) return cb(checkErr);
      if (checkRows && checkRows.length > 0) {
        // Already awarded
        return cb(null, { alreadyAwarded: true, points: 0 });
      }

      // Get user's membership points multiplier
      const memberSql = `
        SELECT mp.points_multiplier
        FROM user_memberships um
        JOIN membership_plans mp ON um.plan_id = mp.id
        WHERE um.user_id = ? AND um.status = 'ACTIVE'
        LIMIT 1
      `;
      
      db.query(memberSql, [userId], (mErr, mRows = []) => {
        if (mErr) return cb(mErr);
        
        const multiplier = (mRows && mRows[0] && Number(mRows[0].points_multiplier)) || 0.25;
        const pointsEarned = Math.round(Number(orderTotal) * multiplier);

        if (pointsEarned <= 0) return cb(null, { points: 0 });

        // Award points
        const description = `Order #${orderId} - Earned ${pointsEarned} points`;
        LoyaltyPoints.addPoints(userId, pointsEarned, orderId, description, (err, result) => {
          if (err) return cb(err);
          cb(null, { points: pointsEarned, ...result });
        });
      });
    });
  },

  /**
   * Helper: Get points earned for a specific order
   */
  getPointsForOrder(userId, orderId, cb) {
    LoyaltyPoints.getPointsForOrder(userId, orderId, cb);
  }
};

module.exports = LoyaltyPointsController;
