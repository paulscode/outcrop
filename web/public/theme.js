// Applies the saved theme before the first paint (an external file: the CSP allows no inline script).  Dark until you
// pick another in Settings or the header.
(function () {
  var t = 'dark'
  try { t = localStorage.getItem('outcrop.theme') || 'dark' } catch (e) {}
  var light = t === 'light' || (t === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches)
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark')
})()
