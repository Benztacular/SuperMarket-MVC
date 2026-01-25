// --------------------------------------------------
// ADMIN CONTROLLER (FULLY FIXED)
// --------------------------------------------------

const crypto = require('crypto');
const User = require('../models/User');
const db = require('../db');

// Helpers
function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}
function unwrap(row) {
  if (!row) return null;
  if (Array.isArray(row)) return Array.isArray(row[0]) ? row[0][0] : row[0];
  return row;
}

// --------------------------------------------------
// LIST USERS
// --------------------------------------------------
function adminUsersPage(req, res) {
  const fn = User.getAll || User.findAll || User.list || User.all;

  fn.call(User, (err, users) => {
    if (err) {
      console.error(err);
      return res.status(500).send("Failed to load users");
    }

    mergeUserImages(users || [], (hydrated) => {
      res.render("users", {
        users: hydrated,
        user: req.session.user || null,
        error: null,
        success: null,
      });
    });
  });
}

function mergeUserImages(list, done) {
  if (!Array.isArray(list) || !list.length) return done(list);
  const ids = list.map((u) => u.id).filter(Boolean);
  if (!ids.length) return done(list);

  const placeholders = ids.map(() => '?').join(',');
  const sql = `SELECT id, profileImage, avatar, updated_at FROM users WHERE id IN (${placeholders})`;

  db.query(sql, ids, (err, rows = []) => {
    if (err) {
      console.error('hydrateUserImages error:', err);
      return done(list);
    }
    const byId = rows.reduce((acc, row) => {
      acc[row.id] = row;
      return acc;
    }, {});

    const merged = list.map((u) => {
      const extras = byId[u.id] || {};
      return {
        ...u,
        profileImage: extras.profileImage ?? u.profileImage ?? '',
        avatar: extras.avatar ?? u.avatar ?? '',
        updated_at: extras.updated_at ?? u.updated_at ?? null,
      };
    });
    done(merged);
  });
}

// --------------------------------------------------
// EDIT USER PAGE
// --------------------------------------------------
function adminEditUserPage(req, res) {
  const uid = req.params.id;
  const fn = User.getById || User.findById || User.getUserById || User.findOne;

  fn.call(User, uid, (err, row) => {
    if (err) {
      console.error("adminEditUserPage error:", err);
      return res.status(500).send("Failed to load user");
    }

    const editingTarget = unwrap(row);
    if (!editingTarget) return res.status(404).send("User not found");

    res.render("editUser", {
      editingUser: editingTarget,
      sessionUser: req.session.user || null,
      loggedInUser: req.session.user || null,
      error: null,
      success: null,
    });
  });
}

// --------------------------------------------------
// UPDATE USER
// --------------------------------------------------
function adminUpdateUser(req, res) {
  const targetId = Number(req.params.id);
  const { username, email, address, contact, role } = req.body;

  const findFn = User.getById || User.findById || User.getUserById || User.findOne;
  const updateFn =
    User.updateById ||
    User.updateUser ||
    User.update ||
    User.edit ||
    User.save;

  findFn.call(User, targetId, (findErr, row) => {
    if (findErr) {
      console.error("adminUpdateUser find error:", findErr);
      return res.status(500).send("Failed to update user");
    }

    const existing = unwrap(row);
    if (!existing) return res.status(404).send("User not found");

    const loggedInId = req.session.user?.id;
    const tryingToDemote = existing.role === "admin" && role !== "admin";

    if (tryingToDemote) {
      const msg =
        loggedInId === targetId
          ? "Admins cannot demote themselves."
          : "Admins cannot demote other admins.";
      req.flash?.("error", msg);
      return res.redirect(`/admin/users/${targetId}/edit`);
    }

    updateFn.call(
      User,
      targetId,
      { username, email, address, contact, role },
      (err) => {
        if (err) {
          console.error("adminUpdateUser error:", err);
          return res.status(500).send("Failed to update user");
        }

        if (req.session.user && req.session.user.id === targetId) {
          req.session.user.username = username;
          req.session.user.email = email;
          req.session.user.role = role;
        }

        res.redirect("/admin/users");
      }
    );
  });
}

// --------------------------------------------------
// DELETE USER
// --------------------------------------------------
function adminDeleteUser(req, res) {
  const targetId = Number(req.params.id);

  // Prevent deleting yourself
  if (req.session.user && req.session.user.id === targetId) {
    return res.status(400).send("You cannot delete your own account.");
  }

  const fn =
    User.deleteById ||
    User.remove ||
    User.delete ||
    User.deleteUser ||
    User.removeUser;

  fn.call(User, targetId, (err) => {
    if (err) {
      console.error("adminDeleteUser error:", err);
      return res.status(500).send("Failed to delete user");
    }

    res.redirect("/admin/users");
  });
}

module.exports = {
  adminUsersPage,
  adminEditUserPage,
  adminUpdateUser,
  adminDeleteUser,
  // landing/dashboard
  dashboard: function (req, res, next) {
    // gather some quick stats for the admin landing page
    const stats = {};
    const queries = [
      { key: 'users', sql: 'SELECT COUNT(*) AS cnt FROM users' },
      { key: 'products', sql: 'SELECT COUNT(*) AS cnt FROM products' },
      { key: 'orders', sql: 'SELECT COUNT(*) AS cnt FROM orders' }
    ];

    let i = 0;
    function nextQuery(err) {
      if (err) return next(err);
      if (i >= queries.length) {
          // After basic counts, compute revenue and recent orders for real data on dashboard
          db.query('SELECT COALESCE(SUM(totalAmount),0) AS revenue FROM orders', (revErr, revRows = []) => {
            if (revErr) console.error('adminDashboard - revenue query error', revErr);
            stats.revenue = Number((revRows && revRows[0] && revRows[0].revenue) || 0);

            const recentSql = `
              SELECT o.id, o.totalAmount, o.status, o.orderDate, u.username
              FROM orders o
              LEFT JOIN users u ON u.id = o.user_id
              ORDER BY o.createdAt DESC
              LIMIT 6
            `;
            db.query(recentSql, (roErr, roRows = []) => {
              if (roErr) console.error('adminDashboard - recent orders query error', roErr);
              const recentOrders = (roRows || []).map(r => ({ id: r.id, totalAmount: Number(r.totalAmount || 0), status: r.status || '', orderDate: r.orderDate || null, username: r.username || '' }));
              return res.render('adminDashboard', { stats, recentOrders, user: req.session.user || null });
            });
          });
          return;
        }
      const q = queries[i++];
      db.query(q.sql, (qErr, rows) => {
        if (qErr) return nextQuery(qErr);
        stats[q.key] = (rows && rows[0] && (rows[0].cnt || rows[0].COUNT || Object.values(rows[0])[0])) ? Number(rows[0].cnt || Object.values(rows[0])[0]) : 0;
        nextQuery();
      });
    }
    nextQuery();
  }
};
