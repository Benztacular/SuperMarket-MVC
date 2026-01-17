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
};

module.exports = MembershipController;
