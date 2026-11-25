(function() {
  var btn = document.getElementById('mobileMenuBtn');
  var sidebar = document.getElementById('sidebar');

  function closeSidebar() {
    if (!sidebar) return;
    sidebar.classList.remove('open');
    toggleBackdrop(false);
    document.body.style.overflow = '';
  }

  function openSidebar() {
    if (!sidebar) return;
    sidebar.classList.add('open');
    toggleBackdrop(true);
    document.body.style.overflow = 'hidden';
  }

  if (btn && sidebar) {
    btn.addEventListener('click', function() {
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    });

    // Sluit sidebar bij klik op nav link of buiten de nav (mobiel)
    sidebar.addEventListener('click', function(e) {
      if (window.innerWidth <= 1024) {
        var link = e.target.closest('a');
        if (link || e.target === sidebar) closeSidebar();
      }
    });

    // Sluit met Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeSidebar();
    });
  }

  function toggleBackdrop(show) {
    var existing = document.querySelector('.sidebar-backdrop');
    if (!show) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    var backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.addEventListener('click', closeSidebar);
    document.body.appendChild(backdrop);
  }

  // Sluit menu bij venster resize naar desktop
  window.addEventListener('resize', function() {
    if (window.innerWidth > 1024 && sidebar && sidebar.classList.contains('open')) {
      closeSidebar();
    }
  });

  // --- CSRF helper voor fetch-API calls ---------------------------------
  function getCsrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.getAttribute('content') || '' : '';
  }

  function patchFetchHeaders(input, init) {
    init = init || {};
    var token = getCsrfToken();
    if (!token) return init;

    var method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return init;

    if (init.headers instanceof Headers) {
      if (!init.headers.has('X-CSRF-Token')) init.headers.set('X-CSRF-Token', token);
      return init;
    }

    var headers = new Headers();
    if (typeof input === 'object' && input && input.headers) {
      if (typeof input.headers.forEach === 'function') {
        input.headers.forEach(function(value, key) { headers.set(key, value); });
      } else {
        Object.keys(input.headers).forEach(function(key) { headers.set(key, input.headers[key]); });
      }
    }
    if (init.headers && typeof init.headers === 'object') {
      Object.keys(init.headers).forEach(function(key) { headers.set(key, init.headers[key]); });
    }
    if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);

    init.headers = headers;
    return init;
  }

  var originalFetch = window.fetch;
  if (originalFetch) {
    window.fetch = function(input, init) {
      return originalFetch.call(this, input, patchFetchHeaders(input, init));
    };
  }

  if (typeof window.CsrfUtil === 'undefined') {
    window.CsrfUtil = { token: getCsrfToken };
  }
})();
