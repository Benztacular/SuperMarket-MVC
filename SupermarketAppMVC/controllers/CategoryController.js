const db = require('../db');

exports.apiList = (req, res) => {
  db.query('SELECT categoryName FROM categories ORDER BY categoryName', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    // return array of names for client /api/categories
    const names = (rows || []).map(r => r.categoryName);
    res.json(names);
  });
};

exports.adminList = (req, res) => {
  db.query('SELECT id, categoryName FROM categories ORDER BY categoryName', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json(rows || []);
  });
};

exports.create = (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });

  db.query('INSERT INTO categories (categoryName) VALUES (?)', [name], (err, result) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ id: result.insertId, categoryName: name });
  });
};

exports.update = (req, res) => {
  const id = req.params.id;
  const name = (req.body.name || '').trim();
  if (!id || !name) return res.status(400).json({ error: 'Id and name required' });

  db.query('UPDATE categories SET categoryName = ? WHERE id = ?', [name, id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ updated: result.changedRows > 0 });
  });
};

exports.remove = (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'Id required' });

  db.query('DELETE FROM categories WHERE id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ deleted: result.affectedRows > 0 });
  });
};