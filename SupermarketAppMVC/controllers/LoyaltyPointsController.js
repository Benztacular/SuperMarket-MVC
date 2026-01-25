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

                // Handle reward type specific actions
                const rewardType = (reward.reward_type || '').toString().toUpperCase();
                
                if (rewardType === 'WALLET_CREDIT') {
                  // Automatically add wallet credit
                  const creditAmount = Number(reward.wallet_credit || 0);
                  if (creditAmount > 0) {
                    // Get wallet ID
                    conn.query('SELECT id FROM user_wallets WHERE user_id = ? LIMIT 1', [userId], (wErr, wRows = []) => {
                      if (wErr || !wRows.length) {
                        conn.rollback(() => {});
                        return res.status(500).json({ success: false, error: 'Wallet not found' });
                      }
                      const walletId = wRows[0].id;
                      
                      // Add balance
                      conn.query('UPDATE user_wallets SET balance = balance + ?, updatedAt = NOW() WHERE id = ?', [creditAmount, walletId], (uErr) => {
                        if (uErr) {
                          conn.rollback(() => {});
                          return res.status(500).json({ success: false, error: 'Failed to update wallet' });
                        }
                        
                        // Record transaction
                        const wtSql = `INSERT INTO wallet_transactions (wallet_id, user_id, type, amount, reference_type, reference_id, description, createdAt) VALUES (?, ?, 'TOP_UP', ?, 'LOYALTY_REWARD', ?, ?, NOW())`;
                        conn.query(wtSql, [walletId, userId, creditAmount, String(redemption.redemptionId), `Loyalty Reward: ${reward.title}`], (wtErr) => {
                          if (wtErr) {
                            conn.rollback(() => {});
                            return res.status(500).json({ success: false, error: 'Failed to record wallet transaction' });
                          }
                          
                          // Commit
                          conn.commit((cErr) => {
                            if (cErr) {
                              conn.rollback(() => {});
                              return res.status(500).json({ success: false, error: 'Commit failed' });
                            }
                            const newPoints = currentPoints - cost;
                            return res.json({ success: true, redemptionId: redemption.redemptionId, pointsSpent: cost, points: newPoints, newPoints: newPoints, message: `Reward claimed! $${creditAmount.toFixed(2)} added to your wallet.` });
                          });
                        });
                      });
                    });
                  } else {
                    conn.commit((cErr) => {
                      if (cErr) { conn.rollback(() => {}); return res.status(500).json({ success: false, error: 'Commit failed' }); }
                      const newPoints = currentPoints - cost;
                      return res.json({ success: true, redemptionId: redemption.redemptionId, pointsSpent: cost, points: newPoints, newPoints: newPoints, message: 'Reward claimed successfully!' });
                    });
                  }
                } else if (rewardType === 'DISCOUNT' || rewardType === 'FREE_DELIVERY_VOUCHER') {
                  // Generate unique coupon code
                  const prefix = rewardType === 'FREE_DELIVERY_VOUCHER' ? 'FREESHIP' : 'DISCOUNT';
                  const randomPart = Math.random().toString(36).substring(2, 8).toUpperCase();
                  const couponCode = `${prefix}-${randomPart}`;
                  
                  // Calculate expiration
                  const validDays = Number(reward.valid_days || 30);
                  const expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000);
                  
                  // Determine coupon parameters
                  let discountType = 'FIXED';
                  let discountValue = 0;
                  let minSpend = Number(reward.min_spend || 0);
                  
                  if (rewardType === 'FREE_DELIVERY_VOUCHER') {
                    // Free delivery coupon: represents 100% off shipping
                    discountType = 'PERCENTAGE';
                    discountValue = 100.00;
                    minSpend = 0;
                  } else {
                    // Discount coupon
                    if (reward.discount_percent && Number(reward.discount_percent) > 0) {
                      discountType = 'PERCENTAGE';
                      discountValue = Number(reward.discount_percent);
                    } else {
                      discountType = 'FIXED';
                      discountValue = Number(reward.discount_amount || 0);
                    }
                  }
                  
                  // Insert into coupons table
                  const isFreeDelivery = (rewardType === 'FREE_DELIVERY_VOUCHER') ? 1 : 0;
                  const couponSql = `
                    INSERT INTO coupons (coupon_code, description, discount_type, discount_value, valid_from, valid_until, is_global, is_active, min_spend, max_uses_per_user, total_usage_limit, current_total_uses, is_free_delivery)
                    VALUES (?, ?, ?, ?, NOW(), ?, 0, 1, ?, 1, 1, 0, ?)
                  `;
                  const couponDesc = rewardType === 'FREE_DELIVERY_VOUCHER' ? `Free Delivery Voucher (${reward.title})` : reward.title || 'Discount Coupon';
                  
                  conn.query(couponSql, [couponCode, couponDesc, discountType, discountValue, expiresAt, minSpend, isFreeDelivery], (cInsErr, cResult) => {
                    if (cInsErr) {
                      conn.rollback(() => {});
                      return res.status(500).json({ success: false, error: 'Failed to create coupon' });
                    }
                    
                    const couponId = cResult.insertId;
                    
                    // Link coupon to user in user_coupons
                    const ucSql = `INSERT INTO user_coupons (user_id, coupon_id, coupon_code, assigned_at, times_used, status) VALUES (?, ?, ?, NOW(), 0, 'ASSIGNED')`;
                    conn.query(ucSql, [userId, couponId, couponCode], (ucErr) => {
                      if (ucErr) {
                        conn.rollback(() => {});
                        return res.status(500).json({ success: false, error: 'Failed to assign coupon to user' });
                      }
                      
                      // Commit
                      conn.commit((cErr) => {
                        if (cErr) {
                          conn.rollback(() => {});
                          return res.status(500).json({ success: false, error: 'Commit failed' });
                        }
                        const newPoints = currentPoints - cost;
                        return res.json({ success: true, redemptionId: redemption.redemptionId, pointsSpent: cost, points: newPoints, newPoints: newPoints, couponCode: couponCode, message: `Reward claimed! Your code: ${couponCode}` });
                      });
                    });
                  });
                } else {
                  // Unknown reward type, just commit
                  conn.commit((cErr) => {
                    if (cErr) { conn.rollback(() => {}); return res.status(500).json({ success: false, error: 'Commit failed' }); }
                    const newPoints = currentPoints - cost;
                    return res.json({ success: true, redemptionId: redemption.redemptionId, pointsSpent: cost, points: newPoints, newPoints: newPoints, message: 'Reward claimed successfully!' });
                  });
                }
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
