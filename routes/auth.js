'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { DEFAULT_LANG, isSupportedLang } = require('../lib/i18n');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login');
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    req.flash('error', 'Vul gebruikersnaam en wachtwoord in.');
    return res.redirect('/login');
  }

  try {
    const rows = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows && rows.length ? rows[0] : null;

    // Timing veilig: altijd hash vergelijken om username enumeration tegen te gaan
    const dummyHash = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.5z6J1l4n9QjQ4nQ4nQ4nQ4nQ4nQ';
    const valid = user ? await bcrypt.compare(password, user.password) : await bcrypt.compare(password, dummyHash);

    if (!user || !valid) {
      req.flash('error', 'Ongeldige inloggegevens.');
      return res.redirect('/login');
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      language: isSupportedLang(user.language) ? user.language : DEFAULT_LANG,
    };
    req.flash('success', 'Welkom terug, ' + user.username + '!');
    res.redirect('/dashboard');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Login error:', err);
    req.flash('error', 'Er ging iets mis bij het inloggen. Probeer het later opnieuw.');
    res.redirect('/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

module.exports = router;