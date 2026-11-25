'use strict';

const csrf = require('csrf');
const tokens = new csrf();

/**
 * Middleware: maak een CSRF-token aan in de sessie en exponseer het via res.locals.
 * Moet NA express-session worden gemonteerd.
 */
function csrfMiddleware() {
  return (req, res, next) => {
    if (!req.session) return next();

    if (!req.session.csrfSecret) {
      req.session.csrfSecret = tokens.secretSync();
    }
    // Deterministic per sessie: het token eenmalig genereren en hergebruiken,
    // zodat de meta-tag, de XSRF-TOKEN-cookie en de JS-variabele ALTIJD gelijk
    // blijven, ook na /refresh-polls. Anders ontstaat er drift tussen de
    // cookie (elke response opnieuw gezet via timestamp) en de al-geladen
    // meta-tag -> double-submit check faalt.
    if (!req.session.csrfToken) {
      req.session.csrfToken = tokens.create(req.session.csrfSecret);
    }
    res.locals.csrfToken = req.session.csrfToken;
    res.locals.csrfInput = `<input type="hidden" name="_csrf" value="${res.locals.csrfToken}">`;
    next();
  };
}

// Lees een specifieke cookie waarde uit de raw Cookie header (zonder cookie-parser dependency).
function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/**
 * Verify een CSRF-token voor POST/PUT/DELETE requests.
 * Dubbele bescherming (double-submit): het verzonden token moet én geldig
 * zijn t.o.v. de session-secret, én (indien aanwezig) overeenkomen met de
 * XSRF-TOKEN-cookie. Zo kan een aanvaller zonder cookie-rechten geen geldig
 * tokenmaterial vervalsen.
 */
function verifyCsrf(req) {
  if (!req.session || !req.session.csrfSecret) return false;
  const token = (req.body && req.body._csrf)
    || (req.headers && (req.headers['x-csrf-token'] || req.headers['x-xsrf-token']));
  if (!token) return false;
  try {
    if (!tokens.verify(req.session.csrfSecret, token)) return false;
  } catch {
    return false;
  }
  // Double-submit: het verzonden token moet ook met de XSRF-TOKEN-cookie matchen.
  const cookie = readCookie(req.headers['cookie'], 'XSRF-TOKEN');
  if (cookie && cookie !== token) return false;
  return true;
}

/**
 * Express middleware die CSRF afdwingt voor alle niet-GET requests
 * (behalve de door `skipPaths` genoemde uitzonderingen).
 */
function enforceCsrf(skipPaths) {
  const skip = new Set((skipPaths || []).map((p) => p.toLowerCase()));
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (skip.has(req.path.toLowerCase())) return next();
    if (!verifyCsrf(req)) {
      req.flash && req.flash('error', 'CSRF-token ongeldig of verlopen. Probeer opnieuw.');
      return res.status(403).redirect('back');
    }
    next();
  };
}

module.exports = { csrfMiddleware, verifyCsrf, enforceCsrf };