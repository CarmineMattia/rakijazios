(() => {
  if (!location.pathname.startsWith('/app')) return;
  const base = '/api/group-sharing/groups';
  let chat = null, timer = null, version = 0;
  const style = document.createElement('style');
  style.textContent = `.rk-group-activity{font-size:12px;color:#aaa;font-style:italic}#rk-invite-root .rk-card{max-height:90vh;overflow:auto}.rk-group-row{display:flex;gap:8px;align-items:center;margin:8px 0}.rk-group-row span{flex:1}.rk-group-hint{font-size:12px;color:#aaa}#rk-group-dialog{position:fixed;inset:0;z-index:100005;background:#0009;display:flex;align-items:center;justify-content:center;padding:16px;color:#eee;font:14px/1.45 system-ui}#rk-group-dialog .rk-group-card{background:#171719;border:1px solid #38383d;border-radius:16px;padding:20px;width:min(720px,100%);max-height:90vh;display:flex;flex-direction:column;gap:12px}#rk-group-dialog button{border:1px solid #555;border-radius:10px;background:#29292d;color:#eee;padding:8px 12px;cursor:pointer}#rk-group-dialog button:disabled{opacity:.5;cursor:default}#rk-group-dialog h2,#rk-group-dialog p{margin:0}#rk-group-dialog .rk-group-history{overflow:auto;min-height:100px;flex:1;max-height:55vh}.rk-group-message{padding:10px 12px;margin:8px 0;background:#252529;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}.rk-group-message strong{display:block;color:#6cd8bd;font-size:12px;margin-bottom:5px}#rk-group-dialog form{display:flex;gap:8px}#rk-group-dialog textarea{flex:1;min-width:0;background:#111;color:#eee;border:1px solid #555;border-radius:10px;padding:10px;resize:vertical}#rk-group-dialog [role=status]{color:#bbb;font-size:12px}#rk-group-dialog [role=alert]{color:#fca5a5}`;
  document.head.appendChild(style);
  function el(tag, text, props = {}) { const node = document.createElement(tag); if (text) node.textContent = text; Object.assign(node, props); return node; }
  async function api(path, body) {
    const headers = { 'content-type': 'application/json' };
    const spaceId = localStorage.getItem('rakazo:space-id');
    if (spaceId) headers['x-rakazo-space-id'] = spaceId;
    const response = await fetch(path, { credentials: 'include', headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error || 'Request failed'); error.status = response.status; throw error; }
    return data;
  }
  function close() { version++; clearTimeout(timer); chat?.remove(); chat = null; }
  function dialog(title) {
    close(); chat = el('div', '', { id: 'rk-group-dialog' });
    const card = el('section', '', { className: 'rk-group-card' }); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-label', title);
    const header = el('div', '', { className: 'rk-group-row' }); header.append(el('h2', title));
    const exit = el('button', 'Close', { type: 'button' }); exit.addEventListener('click', close); header.append(exit); card.append(header); chat.append(card); document.body.append(chat);
    chat.addEventListener('click', event => { if (event.target === chat) close(); }); exit.focus(); return card;
  }
  async function manage(group) {
    const card = dialog(`Share ${group.name}`), epoch = version;
    card.append(el('p', 'Shared people can read the entire group history and send messages to its bots. Bots use your models, integrations and computer access; usage is charged to your configuration. Private bot chats and settings stay private.', { className: 'rk-group-hint' }));
    const list = el('div'), status = el('p', 'Loading people…'); status.setAttribute('role', 'status'); card.append(list, status);
    try {
      const data = await api(`${base}/${encodeURIComponent(group.id)}/people`);
      if (version !== epoch) return;
      status.textContent = data.people.length ? 'Choose who can read and write.' : 'Invite a person to the space first.';
      for (const person of data.people) {
        const row = el('div', '', { className: 'rk-group-row' }), button = el('button', person.shared ? 'Revoke access' : 'Share group', { type: 'button' });
        row.append(el('span', person.name), button); list.append(row);
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await api(`${base}/${encodeURIComponent(group.id)}/people`, { userId: person.userId, shared: !person.shared }); person.shared = !person.shared; button.textContent = person.shared ? 'Revoke access' : 'Share group'; status.textContent = person.shared ? `Shared with ${person.name}` : `Access revoked for ${person.name}`; }
          catch (error) { status.textContent = error.message; }
          finally { button.disabled = false; }
        });
      }
    } catch (error) { status.textContent = error.message; }
    if (version === epoch) void localGrants(card, group, epoch);
  }
  // Rakijazios M2c: bots that run on the owner's computer need an explicit grant per shared group.
  async function localGrants(card, group, epoch) {
    let data;
    try { data = await api(`/api/local-runners/groups/${encodeURIComponent(group.id)}/grants`); } catch { return; }
    if (version !== epoch || !data.bots.length) return;
    const box = el('div'); box.setAttribute('data-rk-local-grants', '1');
    box.append(el('h3', 'Bots on your computer', { style: 'margin:8px 0 0;font-size:15px' }));
    const missing = data.bots.filter(b => !b.granted);
    if (data.shared && missing.length) box.append(el('p', `${missing.map(b => b.name).join(', ')} won't answer people in this group until you allow it.`, { className: 'rk-group-hint', style: 'color:#f59e0b' }));
    for (const bot of data.bots) {
      const row = el('div', '', { className: 'rk-group-row' }); row.setAttribute('data-rk-grant', bot.botId);
      const label = el('span'); label.append(el('div', `Let ${bot.name} answer for people in this group`), el('div', 'Their messages in this group will be sent to the model on your computer.', { className: 'rk-group-hint' }));
      const button = el('button', bot.granted ? 'Turn off' : 'Allow', { type: 'button' });
      row.append(label, button); box.append(row);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await api(`/api/local-runners/groups/${encodeURIComponent(group.id)}/grants`, { botId: bot.botId, allowed: !bot.granted }); bot.granted = !bot.granted; button.textContent = bot.granted ? 'Turn off' : 'Allow'; }
        catch (error) { button.textContent = error.message; }
        finally { button.disabled = false; }
      });
    }
    card.append(box);
  }
  async function runsOnBadge(hint, group, epoch) {
    let data;
    try { data = await api(`/api/local-runners/groups/${encodeURIComponent(group.id)}/runs-on`); } catch { return; }
    if (version !== epoch || !data.bots.length) return;
    const badge = el('div', data.bots.map(b => `${b.name} runs on ${b.runsOn}${b.online ? '' : ' (offline)'}${b.enabledHere ? '' : ' · not enabled here'}`).join(' · '), { className: 'rk-group-hint' });
    badge.setAttribute('data-rk-runs-on', '1');
    hint.after(badge);
  }
  async function conversation(group) {
    const card = dialog(group.name), epoch = version;
    const hint = el('p', `Shared conversation · ${group.bots.join(', ')}. Bot requests for approval must be handled by the owner.`, { className: 'rk-group-hint' });
    card.append(hint); void runsOnBadge(hint, group, epoch);
    const history = el('div', '', { className: 'rk-group-history' }), status = el('p', 'Loading…'); status.setAttribute('role', 'status');
    const earlier = el('button', 'Load earlier messages', { type: 'button' });
    const form = el('form'), input = el('textarea', '', { placeholder: 'Message the group bots', maxLength: 16000, required: true }); input.setAttribute('aria-label', 'Message the group bots');
    const send = el('button', 'Send', { type: 'submit' }); form.append(input, send); card.append(earlier, history, status, form);
    let signature = '', sending = false, retry = null, accessLost = false, olderMessages = [], oldestSeq = null;
    earlier.addEventListener('click', async () => {
      if (oldestSeq === null) return; earlier.disabled = true;
      try { const data = await api(`${base}/${encodeURIComponent(group.id)}/messages?before=${oldestSeq}`); if (version !== epoch) return; olderMessages = [...data.messages, ...olderMessages]; oldestSeq = data.messages[0]?.seq ?? oldestSeq; earlier.hidden = data.messages.length < 100 || oldestSeq === 0; signature = ''; await refresh(); }
      catch (error) { status.textContent = error.message; }
      finally { earlier.disabled = false; }
    });
    async function refresh() {
      clearTimeout(timer);
      try {
        const data = await api(`${base}/${encodeURIComponent(group.id)}/messages`);
        if (version !== epoch) return;
        if (!data.messages.length) olderMessages = [];
        const messages = [...olderMessages.filter(m => m.seq < (data.messages[0]?.seq ?? 0)), ...data.messages];
        oldestSeq = messages[0]?.seq ?? null;
        if (!olderMessages.length) earlier.hidden = data.messages.length < 100 || oldestSeq === 0;
        const next = JSON.stringify(messages);
        if (signature !== next) {
          const atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 80;
          history.replaceChildren();
          for (const message of messages) {
            const row = el('div', '', { className: 'rk-group-message' }); row.append(el('strong', message.author));
            const activity = Array.isArray(message.activity) ? message.activity : [];
            if (message.text) row.append(el('div', message.text));
            for (const line of activity) row.append(el('div', line, { className: 'rk-group-activity' }));
            // Only the owner can open the original group; members just get a neutral note.
            if (!message.text && !activity.length) row.append(el('div', group.owned ? 'No text in this turn. Open the group from your chat list for details.' : 'No text in this turn.', { className: 'rk-group-activity' }));
            history.append(row);
          }
          if (atBottom || !signature) history.scrollTop = history.scrollHeight;
          signature = next;
        }
        status.textContent = data.failed ? 'A bot run failed. Ask the owner to check its model setup.' : data.active.some(s => s.startsWith('waiting_')) ? 'Waiting for the owner to answer a bot request' : data.active.length ? 'Bots are working…' : 'Up to date';
        timer = setTimeout(refresh, document.hidden ? 10000 : 2000);
      } catch (error) {
        if (version !== epoch) return;
        status.textContent = error.message;
        if ([401,403,404].includes(error.status)) { accessLost = true; history.replaceChildren(); input.disabled = true; send.disabled = true; }
        else timer = setTimeout(refresh, 5000);
      }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (sending || !input.value.trim()) return;
      const text = input.value.trim(); if (!retry || retry.text !== text) retry = { text, clientNonce: crypto.randomUUID() };
      sending = true; send.disabled = true; input.disabled = true; send.textContent = 'Sending…';
      try { await api(`${base}/${encodeURIComponent(group.id)}/messages`, retry); if (version !== epoch) return; input.value = ''; retry = null; await refresh(); }
      catch (error) { if (version === epoch) { status.textContent = error.message; if ([401,403,404].includes(error.status)) { accessLost = true; history.replaceChildren(); } } }
      finally { sending = false; if (version !== epoch) return; send.disabled = accessLost; input.disabled = accessLost; send.textContent = 'Send'; }
    });
    await refresh();
  }
  async function loadGroups(section) {
    section.replaceChildren(el('h3', 'Groups & bots'));
    const list = el('div'); section.append(list);
    try {
      const data = await api(base);
      if (!data.groups.length) list.append(el('p', 'No groups shared with you yet.', { className: 'rk-group-hint' }));
      for (const group of data.groups) {
        const row = el('div', '', { className: 'rk-group-row' }), open = el('button', 'Open', { type: 'button' }); row.append(el('span', `${group.name}${group.owned ? ' · your group' : ' · shared'}`), open); open.addEventListener('click', () => conversation(group));
        if (group.owned) { const share = el('button', 'Manage sharing', { type: 'button' }); share.addEventListener('click', () => manage(group)); row.append(share); } list.append(row);
      }
    } catch (error) { list.append(el('p', error.message, { className: 'rk-group-hint' })); }
  }
  let openBefore = false;
  function attach() {
    const panel = document.getElementById('rk-invite-root');
    const isOpen = panel?.classList.contains('rk-open');
    if (isOpen && !openBefore) {
      let section = panel.querySelector('[data-rk-group-sharing]');
      if (!section) { section = el('section'); section.setAttribute('data-rk-group-sharing','1'); panel.querySelector('.rk-card')?.append(section); }
      void loadGroups(section);
    }
    openBefore = !!isOpen;
  }
  new MutationObserver(attach).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['class'] });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && chat) close(); });
  attach();
})();
