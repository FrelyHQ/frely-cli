// SPDX-License-Identifier: Apache-2.0
// Only the root page negotiates language. It is the English page, so it redirects only to Chinese. Explicit URLs always win.
(() => {
  if (document.documentElement.dataset.localeEntry !== 'true') return;
  let language;
  try { language = window.localStorage.getItem('frely-cli-language'); } catch { /* Storage may be disabled. */ }
  if (language !== 'en' && language !== 'zh') {
    const preferred = navigator.languages?.length ? navigator.languages : [navigator.language];
    language = preferred.map((value) => String(value).toLowerCase().split('-')[0])
      .find((value) => value === 'en' || value === 'zh') || 'en';
  }
  if (language !== 'zh') return;
  const target = new URL('zh/', window.location.href);
  target.search = window.location.search;
  target.hash = window.location.hash;
  window.location.replace(target.href);
})();
