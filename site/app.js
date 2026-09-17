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
  for (const link of document.querySelectorAll('[data-language]')) {
    const target = new URL(link.href);
    target.hash = window.location.hash;
    link.href = target.href;
  }
});
