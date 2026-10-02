(() => {
  const TARGET_HASH = '#/exceptionHandlingArea/singleInbound';

  const CFG = {
    hotkey: { key: "'" },
    cancelErHotkey: { key: 'Backspace' },

    confirmChainClickContains: 'instation_singole_inbound_to_resolve_update_status',

    determinarText: 'determinar',
    inserirPlaceholder: 'Inserir',

    addReasonText: 'Adicionar razão',
    optionText: 'Etiqueta avariada',
    confirmText: 'Confirmar',

    cancelErChainClickContains: 'instation_singole_inbound_to_resolve_cancel_er',
    cancelErText: 'Cancelar ER',

    maxTries: 16,
    retryMs: 180,
    clickDelayMs: 140,
  };

  const STORAGE_KEY_EHA_SHORTCUTS = 'spxToolkitEhaShortcutsEnabled';
  let ehaShortcutsEnabled = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadShortcutSetting() {
    if (!chrome?.storage?.local) return;

    chrome.storage.local.get({ [STORAGE_KEY_EHA_SHORTCUTS]: true }, (cfg) => {
      ehaShortcutsEnabled = cfg[STORAGE_KEY_EHA_SHORTCUTS] !== false;
    });
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!changes[STORAGE_KEY_EHA_SHORTCUTS]) return;
      ehaShortcutsEnabled = changes[STORAGE_KEY_EHA_SHORTCUTS].newValue !== false;
    });
  }

  loadShortcutSetting();

  function isTargetPage() {
    return location.origin === 'https://spx.shopee.com.br' && location.hash.startsWith(TARGET_HASH);
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden';
  }

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }

  function findButtonByText(text) {
    const t = norm(text);
    const btns = [...document.querySelectorAll('button')].filter(isVisible);
    return (
      btns.find((b) => norm(b.innerText) === t) ||
      btns.find((b) => norm(b.innerText).includes(t)) ||
      null
    );
  }

  function findConfirmByChainClick() {
    const needles = [
      CFG.confirmChainClickContains,
      'resolve_reason',
      '/api/in-station/admin/common_site/eha/resolve_reason',
    ].map(norm);

    const btns = [...document.querySelectorAll('button.ssc-button.ssc-btn-type-text[data-chain-click]')].filter(isVisible);

    return btns.find((b) =>
      needles.some((n) => norm(b.getAttribute('data-chain-click')).includes(n))
    ) || null;
  }

  function findCancelErBtn() {
    const chainNeedles = [
      CFG.cancelErChainClickContains,
      '/api/in-station/admin/common_site/eha/cancel_eo_reason',
    ].map(norm);

    const chainBtns = [...document.querySelectorAll('button.ssc-button.ssc-btn-type-text[data-chain-click]')].filter(isVisible);

    const byChain = chainBtns.find((b) =>
      chainNeedles.some((n) => norm(b.getAttribute('data-chain-click')).includes(n))
    );
    if (byChain) return byChain;

    return findButtonByText(CFG.cancelErText);
  }

  function findDeterminarBtn() {
    const t = norm(CFG.determinarText);
    const btns = [...document.querySelectorAll('button')].filter(isVisible);

    const preferred = btns.filter((b) => b.classList.contains('ssc-message-box-action-button'));
    return (
      preferred.find((b) => norm(b.innerText) === t) ||
      preferred.find((b) => norm(b.innerText).includes(t)) ||
      btns.find((b) => norm(b.innerText) === t) ||
      btns.find((b) => norm(b.innerText).includes(t)) ||
      null
    );
  }

  function findInserirInput() {
    const t = norm(CFG.inserirPlaceholder);
    const inputs = [...document.querySelectorAll('input[placeholder]')].filter(isVisible);
    return inputs.find((i) => norm(i.getAttribute('placeholder')) === t) || null;
  }

  function findReasonsRoot() {
    const root = document.querySelector('[data-for="reasons"]');
    return isVisible(root) ? root : null;
  }

  function findReasonsClickTarget() {
    const root = findReasonsRoot();
    if (!root) return null;

    const ref = root.querySelector('.ssc-select-reference');
    if (isVisible(ref)) return ref;

    const wrapper = root.querySelector('.ssc-select-reference-wrapper');
    if (isVisible(wrapper)) return wrapper;

    const arrow = root.querySelector('span.ssc-select-arrow');
    if (isVisible(arrow)) return arrow;

    return null;
  }

  function findOptionEtiquetaAvariada() {
    const target = norm(CFG.optionText);
    const lis = [...document.querySelectorAll('li.ssc-option')].filter(isVisible);

    let opt = lis.find((li) => norm(li.getAttribute('title')) === target);
    if (opt) return opt;

    opt = lis.find((li) => norm(li.innerText) === target);
    if (opt) return opt;

    opt = lis.find((li) => norm(li.innerText).includes(target));
    return opt || null;
  }

  function findConfirmPrimary() {
    const t = norm(CFG.confirmText);
    const primary = [...document.querySelectorAll('button.ssc-btn-type-primary')].filter(isVisible);
    return primary.find((b) => norm(b.innerText).includes(t)) || findButtonByText(CFG.confirmText);
  }

  async function waitAndGet(getter, label, tries = CFG.maxTries) {
    for (let i = 1; i <= tries; i++) {
      const el = getter();
      if (el) return el;
      await sleep(CFG.retryMs);
    }
    throw new Error(`Não achei: ${label}`);
  }

  function isEditableElement(el) {
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
  }

  function isMainEhaInput(el) {
    if (!el || (el.tagName || '').toLowerCase() !== 'input') return false;
    return norm(el.getAttribute('placeholder')) === norm(CFG.inserirPlaceholder);
  }

  function shouldIgnoreBecauseTyping() {
    const el = document.activeElement;
    if (!isEditableElement(el)) return false;

    // O EHA passou a manter o input principal focado. Nesse campo, os atalhos
    // continuam tendo prioridade sobre a digitação normal. Outros campos
    // editáveis permanecem protegidos para não disparar ações por acidente.
    return !isMainEhaInput(el);
  }

  async function flowConfirm() {
    const confirmBtn = await waitAndGet(
      () => findConfirmByChainClick(),
      'botão Confirm (data-chain-click resolve_reason)'
    );
    console.log('[AutoRazao] Confirm existe -> clicando...');
    click(confirmBtn);
    await sleep(CFG.clickDelayMs);

    const detBtn = await waitAndGet(
      () => findDeterminarBtn(),
      `botão "${CFG.determinarText}"`
    );
    click(detBtn);
    await sleep(CFG.clickDelayMs);

    const inp = await waitAndGet(
      () => findInserirInput(),
      `input placeholder "${CFG.inserirPlaceholder}"`
    );
    inp.focus();
    inp.click();
    console.log('[AutoRazao] Foquei no input Inserir ✅');
  }

  async function flowAddReason() {
    console.log('[AutoRazao] Confirm NÃO existe -> seguindo com Adicionar razão...');

    const addBtn = await waitAndGet(
      () => findButtonByText(CFG.addReasonText),
      `botão "${CFG.addReasonText}"`
    );
    click(addBtn);
    await sleep(CFG.clickDelayMs);

    const selectTarget = await waitAndGet(
      () => findReasonsClickTarget(),
      'select reasons (data-for="reasons")'
    );
    click(selectTarget);
    await sleep(CFG.clickDelayMs);

    const opt = await waitAndGet(
      () => findOptionEtiquetaAvariada(),
      `opção "${CFG.optionText}"`
    );
    click(opt);
    await sleep(CFG.clickDelayMs);

    const confirmBtn = await waitAndGet(
      () => findConfirmPrimary(),
      `botão "${CFG.confirmText}"`
    );
    click(confirmBtn);
  }

  async function flowCancelEr() {
    console.log('[AutoRazao] Iniciando fluxo Cancelar ER...');

    const cancelBtn = await waitAndGet(
      () => findCancelErBtn(),
      `botão "${CFG.cancelErText}"`
    );
    click(cancelBtn);
    await sleep(CFG.clickDelayMs);

    const detBtn = await waitAndGet(
      () => findDeterminarBtn(),
      `botão "${CFG.determinarText}"`
    );
    click(detBtn);
    await sleep(CFG.clickDelayMs);

    const inp = await waitAndGet(
      () => findInserirInput(),
      `input placeholder "${CFG.inserirPlaceholder}"`
    );
    inp.focus();
    inp.click();

    console.log('[AutoRazao] Fluxo Cancelar ER concluído ✅');
  }

  async function runFlow() {
    console.log('[AutoRazao] Iniciando...');

    const confirmNow = findConfirmByChainClick();
    if (confirmNow) {
      await flowConfirm();
      console.log('[AutoRazao] Concluído (fluxo Confirm) ✅');
      return;
    }

    await flowAddReason();
    console.log('[AutoRazao] Concluído (fluxo Adicionar razão) ✅');
  }

  if (window.__autoRazaoCleanup) window.__autoRazaoCleanup();

  const handler = (e) => {
    if (!ehaShortcutsEnabled) return;
    if (!isTargetPage()) return;

    const isConfirmHotkey = e.key === CFG.hotkey.key || e.code === 'Quote';
    const isCancelHotkey = e.key === CFG.cancelErHotkey.key;

    if (!isConfirmHotkey && !isCancelHotkey) return;
    if (shouldIgnoreBecauseTyping()) return;

    // Intercepta a tecla antes que o EHA/React consiga enviá-la ao input focado.
    // Isso evita que ' seja escrito ou que Backspace apague o conteúdo do campo.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    // Evita executar a automação várias vezes se a tecla ficar pressionada.
    if (e.repeat) return;

    if (isConfirmHotkey) {
      runFlow().catch((err) => console.warn('[AutoRazao] Falhou:', err?.message || err));
      return;
    }

    flowCancelEr().catch((err) => console.warn('[AutoRazao] Falhou no Cancelar ER:', err?.message || err));
  };

  document.addEventListener('keydown', handler, true);
  window.__autoRazaoCleanup = () => document.removeEventListener('keydown', handler, true);

  console.log(`[AutoRazao] Instalado ✅ Rota ativa: ${TARGET_HASH} | Atalhos: tecla ' e Backspace`);
})();
