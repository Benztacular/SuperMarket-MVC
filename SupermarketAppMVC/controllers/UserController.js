const db = require('../db');
const crypto = require('crypto');
const User = require('../models/User');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const path = require('path');

const AdminController = require('./AdminController');

function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

function unwrap(row) {
  if (!row) return null;
  if (Array.isArray(row)) return Array.isArray(row[0]) ? row[0][0] : row[0];
  return row;
}

function pick(obj, ...names) {
  for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj);
  return null;
}

const createUser = pick(User, 'create', 'register', 'add', 'insert');
const getByEmail = pick(User, 'getByEmail', 'findByEmail', 'getUserByEmail', 'findOneByEmail');
const updatePassByEmail = pick(User, 'updatePasswordByEmail', 'setPasswordByEmail', 'updatePassword');

// --------------------------------------------------
// PAGES
// --------------------------------------------------

function loginPage(_req, res) {
  res.render('login', { errors: [], messages: [], formData: {} });
}

function registerPage(_req, res) {
  res.render('register', { errors: [], messages: [], formData: {} });
}

// --------------------------------------------------
// 2FA QR GENERATION PAGE
// --------------------------------------------------

function renderTwoFactorSetup(req, res, user, secret) {
  qrcode.toDataURL(secret.otpauth_url, (err, dataUrl) => {
    if (err) return res.status(500).send('Failed to generate QR');

    // store pending 2FA info in session until user verifies OTP
    req.session._pending2fa = {
      userId: user.id,
      secret: secret.base32,
      otpauth_url: secret.otpauth_url
    };

    if (req.session?.save) {
      return req.session.save(() => {
        res.render('twoFactorSetup', { qrDataUrl: dataUrl, secret: secret.base32, user });
      });
    }

    res.render('twoFactorSetup', {
      qrDataUrl: dataUrl,
      secret: secret.base32,
      user,
      errors: req.flash?.('error') || [],
      messages: req.flash?.('success') || []
    });
  });
}

// --------------------------------------------------
// REGISTER
// --------------------------------------------------

function register(req, res) {
  const { username, email, password, address, contact, enable2fa } = req.body || {};

  const errors = [];
  if (!username) errors.push('Username is required');
  if (!email) errors.push('Email is required');
  if (!password) errors.push('Password is required');

  if (errors.length) {
    return res.render('register', { errors, messages: [], formData: req.body || {} });
  }

  const role = req.body.role ? String(req.body.role) : 'user';

  createUser({ username, email, password: sha1(password), address, contact, role }, (err) => {
    if (err) {
      return res.render('register', {
        errors: [err.message || 'Registration failed'],
        messages: [],
        formData: req.body
      });
    }

    function fetchUser(cb) {
      if (getByEmail) {
        return getByEmail(email, (gErr, row) => {
          if (!gErr) {
            const user = unwrap(row);
            if (user) return cb(null, user);
          }
          db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email], (qErr, rows) => {
            if (qErr) return cb(qErr);
            cb(null, rows[0] || null);
          });
        });
      }

      db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email], (qErr, rows) => {
        if (qErr) return cb(qErr);
        cb(null, rows[0] || null);
      });
    }

    if (enable2fa) {
      fetchUser((fErr, user) => {
        if (fErr || !user) {
          return res.render('register', {
            errors: ['Registration OK but failed to set up 2FA'],
            messages: [],
            formData: {}
          });
        }
        const secret = speakeasy.generateSecret({ name: `SuperMarketApp (${email})` });
        return renderTwoFactorSetup(req, res, user, secret);
      });
    } else {
      return res.redirect('/login');
    }
  });
}

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

function login(req, res) {
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');

  getByEmail(email, (err, row) => {
    if (err) {
      return res.render('login', { errors: ['Login failed'], messages: [], formData: { email } });
    }

    const user = unwrap(row);
    if (!user) {
      return res.render('login', { errors: ['Invalid email or password'], messages: [], formData: { email } });
    }

    const stored = String(user.password || '');
    const ok = /^[a-f0-9]{40}$/i.test(stored)
      ? stored === sha1(password)
      : stored === password;

    if (!ok) {
      return res.render('login', { errors: ['Invalid email or password'], messages: [], formData: { email } });
    }

    // If 2FA enabled
    if (user.twoFactorEnabled) {
      req.session._pendingLogin = { userId: user.id, email: user.email };

      if (req.session?.save) {
        return req.session.save(() => {
          res.render('login', { errors: [], messages: [], formData: { email }, show2fa: true });
        });
      }

      return res.render('login', { errors: [], messages: [], formData: { email }, show2fa: true });
    }

    // Normal login
    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      profileImage: user.profileImage || null,
      avatarVersion: Date.now()
    };

    req.session.userId = user.id;

    const redirectTo = req.session.redirectTo || '/shopping';
    delete req.session.redirectTo;

    return res.redirect(redirectTo);
  });
}

// --------------------------------------------------
// VERIFY LOGIN 2FA
// --------------------------------------------------

function verifyLogin2fa(req, res, next) {
  const raw = String(req.body.code || req.body.token || req.body.otp || '').trim();
  const code = raw.replace(/\D/g, '').slice(-6);

  if (!code || code.length !== 6) {
    return res.render('twoFactorVerify', {
      email: req.session?._pendingLogin?.email || '',
      errors: ['Please enter a 6-digit 2FA code'],
      info: []
    });
  }

  const pending = req.session._pendingLogin || req.session.tempUser;
  if (!pending) return res.redirect('/login');

  const userId = pending.userId || pending.id;

  db.query('SELECT id, username, email, role, twoFactorSecret FROM users WHERE id = ?', [userId], (err, rows) => {
    if (err) return next(err);

    const user = rows[0];
    if (!user) return res.redirect('/login');

    const secret = String(user.twoFactorSecret || '').trim().replace(/[^A-Z2-7=]/gi, '').toUpperCase();

    let verified = false;

    try {
      verified = speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token: code,
        window: 2
      });
    } catch (_) {}

    if (!verified) {
      return res.render('twoFactorVerify', {
        email: user.email,
        errors: ['Invalid 2FA code'],
        info: []
      });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      twoFactorEnabled: 1
    };

    req.session.userId = user.id;

    delete req.session._pendingLogin;
    delete req.session.tempUser;

    const redirectTo = req.session.redirectTo || '/';
    delete req.session.redirectTo;

    res.redirect(redirectTo);
  });
}

// --------------------------------------------------
// VERIFY CURRENT PASSWORD (AJAX from /profile modal)
// --------------------------------------------------

function verifyCurrentPassword(req, res) {
  const uid = req.session?.userId || req.session?.user?.id;
  if (!uid) {
    return res.status(401).json({ success: false, valid: false, message: 'Login required' });
  }

  const current = String(
    req.body.currentPassword ??
    req.body.current ??
    req.body.password ??
    req.body['current-password'] ??
    ''
  ).trim();

  if (!current) {
    return res.status(400).json({ success: false, valid: false, message: 'Current password is required' });
  }

  db.query('SELECT password FROM users WHERE id = ? LIMIT 1', [uid], (err, rows) => {
    if (err) {
      console.error('verifyCurrentPassword - db select error', err);
      return res.status(500).json({ success: false, valid: false, message: 'Server error' });
    }

    const row = rows && rows[0];
    if (!row) {
      return res.status(404).json({ success: false, valid: false, message: 'User not found' });
    }

    const stored = String(row.password || '').trim();
    const hashedCurrent = sha1(current).toLowerCase();

    let matches = false;
    if (/^[a-f0-9]{40}$/i.test(stored)) {
      matches = hashedCurrent === stored.toLowerCase();
    } else {
      matches = current === stored;
    }

    if (!matches) {
      return res.json({ success: false, valid: false, message: 'Incorrect password' });
    }

    return res.json({ success: true, valid: true, message: 'Password verified' });
  });
}

// --------------------------------------------------
// VERIFY SETUP 2FA
// --------------------------------------------------

function verifySetup2fa(req, res) {
  const token = String(req.body.token || '').trim();
  const pending = req.session._pending2fa;

  if (!pending) return res.redirect('/login');

  const verified = speakeasy.totp.verify({
    secret: pending.secret,
    encoding: 'base32',
    token,
    window: 1
  });

  if (!verified) {
    return res.render('twoFactorSetup', {
      qrDataUrl: null,
      secret: pending.secret,
      user: null,
      errors: ['Invalid or expired code']
    });
  }

  if (User.setTwoFactorById) {
    User.setTwoFactorById(pending.userId, pending.secret, 1, () => {
      req.session._pending2fa = null;
      res.render('login', { errors: [], messages: ['2FA enabled. Please log in.'], formData: {} });
    });
  } else {
    res.status(501).send('Model does not support saving 2FA settings');
  }
}

// --------------------------------------------------
// PROFILE
// --------------------------------------------------

function profilePage(req, res, next) {
  const uid = req.session?.userId;
  if (!uid) return res.redirect('/login');

  db.query(
    'SELECT id, username, email, address, contact, profileImage, twoFactorSecret, twoFactorEnabled FROM users WHERE id = ? LIMIT 1',
    [uid],
    (err, rows) => {
      if (err) return next(err);
      const profileUser = rows?.[0] || req.session.user;

      const flashErrors = typeof req.flash === 'function' ? req.flash('error') : [];
      const flashSuccess = typeof req.flash === 'function' ? req.flash('success') : [];

      // merge session user + DB user for this view
      const viewUser = Object.assign({}, req.session.user || {}, profileUser || {});

      res.render('profile', {
        profileUser,
        user: viewUser,
        error: flashErrors,
        success: flashSuccess
      });
    }
  );
}

function updateProfile(req, res, next) {
  const uid = req.session?.user?.id || req.session?.userId;
  if (!uid) return res.redirect('/login');

  const { username = '', email = '', address = '', contact = '' } = req.body || {};
  const uploadedAvatar = req.file?.filename || null;

  const setters = ['username = ?', 'email = ?', 'address = ?', 'contact = ?'];
  const params = [username.trim(), email.trim(), address.trim(), contact.trim()];

  if (uploadedAvatar) {
    setters.push('profileImage = ?');
    params.push(uploadedAvatar);
  }

  params.push(uid);

  db.query(`UPDATE users SET ${setters.join(', ')} WHERE id = ?`, params, (err) => {
    if (err) return next(err);

    if (req.session?.user) {
      req.session.user.username = username;
      req.session.user.email = email;
      req.session.user.address = address;
      req.session.user.contact = contact;
      if (uploadedAvatar) {
        req.session.user.profileImage = uploadedAvatar;
        req.session.user.avatarVersion = Date.now();
      }
    }

    req.flash?.('success', 'Profile updated');
    res.redirect('/profile');
  });
}

// --------------------------------------------------
// CHANGE PASSWORD
// --------------------------------------------------

function changePassword(req, res) {
  const uid =
    req.session?.user?.id ||
    req.session?.userId ||
    req.session?.passport?.user ||
    null;

  if (!uid) {
    return res.json({ success: false, message: "Login required" });
  }

  const nextPass = String(req.body.newPassword || '').trim();
  const confirm = String(req.body.confirmPassword || '').trim();

  if (!nextPass || !confirm) {
    return res.json({ success: false, message: "All fields are required" });
  }

  if (nextPass !== confirm) {
    return res.json({ success: false, message: "New password and confirmation do not match" });
  }

  const newHash = sha1(nextPass);

  db.query('UPDATE users SET password = ? WHERE id = ?', [newHash, uid], (uErr) => {
    if (uErr) {
      console.error('Password update failed:', uErr);
      return res.json({ success: false, message: "Failed to change password" });
    }

    return res.json({ success: true, message: "Password updated successfully" });
  });
}

// --------------------------------------------------
// 2FA ENABLE / DISABLE FROM PROFILE
// --------------------------------------------------

function enable2fa(req, res, next) {
  const uid = req.session?.userId;
  if (!uid) return res.redirect('/login');

  db.query('SELECT id, email FROM users WHERE id = ?', [uid], (err, rows) => {
    if (err || !rows[0]) return next(err);

    const user = rows[0];

    const secret = speakeasy.generateSecret({
      name: `SuperMarketApp (${user.email})`
    });

    renderTwoFactorSetup(req, res, user, secret);
  });
}

function disableTwoFactor(req, res) {
  const uid = req.session?.userId;
  if (!uid) return res.redirect('/login');

  const raw = String(req.body.otpCode || '').trim();
  const code = raw.replace(/\D/g, '').slice(-6);

  if (code.length !== 6) {
    req.flash?.('error', 'Enter a valid 6-digit authenticator code.');
    return res.redirect('/profile');
  }

  db.query('SELECT twoFactorSecret FROM users WHERE id = ? LIMIT 1', [uid], (err, rows) => {
    if (err || !rows?.length) {
      req.flash?.('error', 'Unable to fetch 2FA settings.');
      return res.redirect('/profile');
    }

    const secret = String(rows[0].twoFactorSecret || '').trim();
    if (!secret) {
      req.flash?.('error', 'Two-factor authentication is not enabled.');
      return res.redirect('/profile');
    }

    let verified = false;
    try {
      verified = speakeasy.totp.verify({
        secret: secret.replace(/[^A-Z2-7=]/gi, '').toUpperCase(),
        encoding: 'base32',
        token: code,
        window: 1
      });
    } catch (_) {}

    if (!verified) {
      req.flash?.('error', 'Incorrect authenticator code.');
      return res.redirect('/profile');
    }

    db.query(
      'UPDATE users SET twoFactorEnabled = 0, twoFactorSecret = NULL WHERE id = ?',
      [uid],
      (updateErr) => {
        if (updateErr) {
          console.error('Failed to disable 2FA', updateErr);
          req.flash?.('error', 'Failed to disable two-factor authentication.');
          return res.redirect('/profile');
        }

        if (req.session.user) {
          req.session.user.twoFactorEnabled = 0;
          req.session.user.twoFactorSecret = null;
        }

        req.flash?.('success', 'Two-factor authentication disabled.');
        res.redirect('/profile');
      }
    );
  });
}

// --------------------------------------------------
// ADMIN PAGES
// --------------------------------------------------

function adminUsersPage(_req, res) {
  User.getAll((err, users) => {
    if (err) return res.status(500).send('Error loading users');
    res.render('users', { users });
  });
}

function adminEditUserPage(req, res, next) {
  const id = req.params.id;

  // Fetch the user being edited
  User.getById(id, (err, targetUser) => {
    if (err || !targetUser) {
      req.flash("error_msg", "User not found");
      return res.redirect("/admin/users");
    }

    // Logged-in user (admin) from session
    const loggedInUser = req.session.user;

    return res.render("editUser", {
      targetUser,            // user being edited
      loggedInUser,          // navbar user
      sessionUser: loggedInUser
    });
  });
}


function adminUpdateUser(req, res) {
  const id = req.params.id;

  User.updateById(id, req.body, () => {
    req.flash('success', 'User updated successfully');

    // Stay on the same edit page after saving
    res.redirect(`/admin/users/${id}/edit`);
  });
}


function adminDeleteUser(req, res) {
  if (req.session.user.id == req.params.id) {
    return res.status(400).send('You cannot delete yourself');
  }

  User.deleteById(req.params.id, () => {
    res.redirect('/admin/users');
  });
}

// --------------------------------------------------
// LOGOUT
// --------------------------------------------------

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
}

// --------------------------------------------------
// SHOPPING
// --------------------------------------------------

function shopping(req, res, next) {
  if (AdminController?.shopping) return AdminController.shopping(req, res, next);
  res.render('shopping', { user: req.session.user });
}

// --------------------------------------------------
// EXPORTS
// --------------------------------------------------

module.exports = {
  loginPage,
  login,
  logout,
  registerPage,
  register,
  profilePage,
  updateProfile,
  changePassword,
  verifyCurrentPassword,
  enable2fa,
  disableTwoFactor,
  verifySetup2fa,
  verifyLogin2fa,
  shopping,
  adminUsersPage,
  adminEditUserPage,
  adminUpdateUser,
  adminDeleteUser
};
