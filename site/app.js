// SPDX-License-Identifier: Apache-2.0
const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
function selectTab(selected, focus = false) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (focus) selected.focus();
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    let index = tabs.indexOf(tab);
    if (event.key === 'ArrowDown') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowUp') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    selectTab(tabs[index], true);
  });
}
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const command = document.getElementById(button.dataset.copy);
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(command.textContent.trim());
      button.textContent = status.dataset.copied;
      status.textContent = status.dataset.success;
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = status.dataset.selected;
      status.textContent = status.dataset.failure;
    }
    window.setTimeout(() => { button.textContent = status.dataset.idle; }, 2200);
  });
}

// A direct client link must reveal its panel, including after changing language.
function selectLinkedClient() {
  const linked = tabs.find((tab) => '#' + tab.getAttribute('aria-controls') === window.location.hash);
  if (linked) {
    selectTab(linked);
    document.getElementById(linked.getAttribute('aria-controls')).scrollIntoView({ block: 'start' });
  }
}
selectLinkedClient();

// Real links keep language switching available without JavaScript.
for (const link of document.querySelectorAll('[data-language]')) {
  const target = new URL(link.href);
  target.search = window.location.search;
  target.hash = window.location.hash;
  link.href = target.href;
  link.addEventListener('click', () => {
    try { window.localStorage.setItem('frely-cli-language', link.dataset.language); } catch { /* Storage may be disabled. */ }
  });
}
window.addEventListener('hashchange', () => {
  selectLinkedClient();
  for (const link of document.querySelectorAll('[data-language]')) {
    const target = new URL(link.href);
    target.hash = window.location.hash;
    link.href = target.href;
  }
});


// Microsoft Clarity analytics. The project id is public by design because it is shipped to browsers.
(() => {
  const projectId = 'ykc2prmxm6';
  const storageKey = 'frely_clarity_consent_v1';
  const surface = 'frely-cli-landing';
  let consent = null;
  try { consent = window.localStorage.getItem(storageKey); } catch {}

  const loadClarity = () => {
    if (window.clarity) return;
    window.clarity = function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.clarity.ms/tag/' + projectId;
    document.head.appendChild(script);
    window.clarity('consentv2', { analytics_Storage: 'granted', ad_Storage: 'denied' });
    window.clarity('set', 'surface', surface);
    window.clarity('set', 'locale', document.documentElement.lang || 'unknown');
  };

  if (consent === 'granted') {
    loadClarity();
    return;
  }
  if (consent === 'denied') return;

  if (!document.documentElement || !document.body || typeof document.createElement !== 'function') return;
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const panel = document.createElement('section');
  panel.className = 'clarity-consent';
  panel.setAttribute('aria-label', zh ? '分析偏好' : 'Analytics preferences');
  panel.innerHTML = '<div><strong>' + (zh ? '分析偏好' : 'Analytics preferences') + '</strong><p>' +
    (zh ? '我们使用 Microsoft Clarity 分析站点使用情况。广告存储保持关闭。' : 'We use Microsoft Clarity to understand site usage. Advertising storage stays disabled.') +
    '</p></div><div class="clarity-consent-actions"><button type="button" data-clarity="deny">' +
    (zh ? '拒绝' : 'Reject') + '</button><button type="button" class="clarity-consent-accept" data-clarity="grant">' +
    (zh ? '接受分析' : 'Accept analytics') + '</button></div>';
  document.body.appendChild(panel);

  panel.addEventListener('click', (event) => {
    const action = event.target instanceof Element ? event.target.getAttribute('data-clarity') : null;
    if (!action) return;
    try { window.localStorage.setItem(storageKey, action === 'grant' ? 'granted' : 'denied'); } catch {}
    panel.remove();
    if (action === 'grant') loadClarity();
  });
})();
