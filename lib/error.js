'use strict';

/**
 * Exposeer een veilige, generieke error-handler middleware.
 * Geen interne DB-foutmeldingen naar de gebruiker lekken.
 */
function notFound(req, res) {
  res.status(404).render('error', {
    statusCode: 404,
    message: 'Pagina niet gevonden.',
  });
}

function errorHandler(err, req, res, _next) {
  // eslint-disable-next-line no-console
  console.error('[ERROR]', err && err.stack ? err.stack : err);
  const status = err && err.status ? err.status : 500;
  if (req.accepts('json')) {
    return res.status(status).json({ error: 'Interne serverfout.' });
  }
  res.status(status).render('error', {
    statusCode: status,
    message: status === 404 ? 'Pagina niet gevonden.' : 'Er ging iets mis op de server.',
  });
}

module.exports = { notFound, errorHandler };