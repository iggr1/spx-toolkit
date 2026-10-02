(function () {
  const EXCEPTION_TARGET = "#/exceptionHandlingArea/singleInbound";
  const RECEIVE_TARGET = "#/generalReceiveTaskOps/singleReceiveNew";

  const HINT_BOX_ID = "spx-auto-hint";
  const ATTEMPTS_BOX_ID = "spx-delivery-attempts-hint";
  const AUTOADD_TOAST_ID = "spx-autoadd-toast";
  const STYLE_ID = "spx-auto-hint-style";

  const REASON_TRANSLATIONS = {
    "cannot find address": "Endereço não encontrado",
    "disaster": "Chuva forte / Desastres Naturais",
    "do not deliver": "Não entregar",
    "incorrect/ missing verification": "Palavra-chave incorreta ou não informada",
    "incorrect/missing verification": "Palavra-chave incorreta ou não informada",
    "insufficient time": "Motorista não teve tempo de entregar",
    "insufficient vehicle capacity": "Não coube no veículo",
    "office closed": "Comércio Fechado",
    "parcel damaged, cannot attempt": "Item Danificado",
    "parcel lost": "Item Perdido",
    "recipient change location": "Mudança de endereço",
    "recipient reject": "Recusado por terceiros",
    "recipient unavailable for parcel": "Ausente",
    "reject - buyers change their mind": "Rejeitado pelo comprador",
    "risky area of delivery": "Área de risco",
    "robbery attempt": "Tentativa de Roubo/Assalto",
    "theft": "Roubo/Assalto",
    "unforeseen circumstances": "Motorista desistiu da rota",
    "vehicle breakdown": "Problemas Mecânicos",
    "wrongly assigned": "Fora de Rota"
  };

  const AUTOADD_SCAN_DELAY_MS = 1500;
  const AUTOADD_RECENT_BEFORE_SCAN_SEC = 30;
  const AUTOADD_RECENT_AFTER_SCAN_SEC = 14400;
  const AUTOADD_TRACKING_RETRY_DELAYS_MS = [0, 1200, 1800, 2500, 3200];
  const EHA_ADDRESS_REASON_ID = "ER40";
  const EHA_ADDRESS_REASON_DESC = "Onhold with Delivery Address Issue";
  const EHA_ADDRESS_FOLLOW_UP_FUNCTION = "Confirm";

  let lastShipmentId = "";
  let monitorTimer = null;
  let debounceTimer = null;
  let requestSeq = 0;
  let deliveryHistoryEnabled = true;
  let ehaShortcutsEnabled = true;
  let lastKnownUrl = location.href;
  let urlWatchTimer = null;

  const STORAGE_KEYS = {
    deliveryHistory: "spxToolkitDeliveryHistoryEnabled",
    ehaShortcuts: "spxToolkitEhaShortcutsEnabled"
  };

  function readSettings(callback) {
    if (!chrome?.storage?.local) {
      callback();
      return;
    }

    chrome.storage.local.get({
      [STORAGE_KEYS.deliveryHistory]: true,
      [STORAGE_KEYS.ehaShortcuts]: true
    }, (cfg) => {
      deliveryHistoryEnabled = cfg[STORAGE_KEYS.deliveryHistory] !== false;
      ehaShortcutsEnabled = cfg[STORAGE_KEYS.ehaShortcuts] !== false;
      callback();
    });
  }

  function isExceptionPage() {
    return location.origin === "https://spx.shopee.com.br" && location.hash.startsWith(EXCEPTION_TARGET);
  }

  function isReceivePage() {
    return location.origin === "https://spx.shopee.com.br" && location.hash.startsWith(RECEIVE_TARGET);
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${HINT_BOX_ID}, #${ATTEMPTS_BOX_ID}, #${AUTOADD_TOAST_ID} {
        position: fixed;
        top: 20px;
        right: 20px;
        background: #0f172a;
        color: #fff;
        border-radius: 14px;
        font-size: 13px;
        line-height: 1.45;
        z-index: 999999;
        box-shadow: 0 20px 48px rgba(0,0,0,0.38);
        font-family: Arial, sans-serif;
        border: 1px solid rgba(255,255,255,0.08);
      }

      #${HINT_BOX_ID} {
        padding: 14px 38px 14px 16px;
      }

      #${ATTEMPTS_BOX_ID} {
        width: min(520px, calc(100vw - 32px));
        max-height: min(78vh, 640px);
        overflow: hidden;
        padding: 10px 10px 10px 10px;
        display: flex;
        flex-direction: column;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempts-content {
        display: flex;
        flex-direction: column;
        gap: 7px;
        flex: 1 1 auto;
        min-height: 0;
      }

      #${HINT_BOX_ID} .spx-auto-hint-title,
      #${ATTEMPTS_BOX_ID} .spx-auto-hint-title {
        font-weight: 800;
        font-size: 17px;
        line-height: 1.1;
        margin: 0 26px 3px 0;
      }

      #${ATTEMPTS_BOX_ID} .spx-subtitle {
        color: #cbd5e1;
        font-size: 11px;
        margin-bottom: 3px;
      }

      #${HINT_BOX_ID} .spx-auto-hint-row {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-top: 8px;
        white-space: nowrap;
      }

      #${HINT_BOX_ID} .spx-key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        height: 28px;
        padding: 0 9px;
        border-radius: 7px;
        background: linear-gradient(180deg, #f8fafc, #cbd5e1);
        color: #0f172a;
        font-weight: 800;
        font-size: 12px;
        font-family: Arial, sans-serif;
        border: 1px solid #94a3b8;
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,.9),
          0 3px 0 #64748b;
      }

      #spx-auto-hint-close,
      #spx-delivery-attempts-close {
        position: absolute;
        top: 8px;
        right: 10px;
        border: 0;
        background: transparent;
        color: #fff;
        font-size: 22px;
        cursor: pointer;
        line-height: 1;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempts-meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-meta-pill {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 5px 8px;
        border-radius: 9px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
      }

      #${ATTEMPTS_BOX_ID} .spx-meta-label {
        color: #cbd5e1;
        font-size: 10px;
        font-weight: 700;
      }

      #${ATTEMPTS_BOX_ID} .spx-meta-value {
        color: #fff;
        font-size: 13px;
        font-weight: 900;
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-card {
        padding: 8px 10px;
        border-radius: 11px;
        border: 1px solid rgba(255,255,255,0.10);
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-card.spx-decision-good {
        background: linear-gradient(180deg, rgba(22,163,74,0.18), rgba(20,83,45,0.28));
        border-color: rgba(34,197,94,0.42);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-card.spx-decision-bad {
        background: linear-gradient(180deg, rgba(127,29,29,0.24), rgba(69,10,10,0.30));
        border-color: rgba(239,68,68,0.42);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-card.spx-decision-warning {
        background: linear-gradient(180deg, rgba(180,83,9,0.24), rgba(120,53,15,0.30));
        border-color: rgba(251,146,60,0.44);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-card.spx-decision-address-pending {
        background: linear-gradient(180deg, rgba(192,132,252,0.24), rgba(107,33,168,0.30));
        border-color: rgba(216,180,254,0.52);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-card.spx-decision-address-confirmed {
        background: linear-gradient(180deg, rgba(126,34,206,0.34), rgba(76,29,149,0.40));
        border-color: rgba(168,85,247,0.62);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-head {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr);
        gap: 8px;
	align-items: center;
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-icon {
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        color: #fff;
        font-size: 15px;
        font-weight: 900;
        background: rgba(255,255,255,0.12);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-title {
        font-weight: 900;
        font-size: 18px;
        line-height: 1.05;
        letter-spacing: .01em;
      }


      #${ATTEMPTS_BOX_ID} .spx-decision-tags {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        margin-top: 6px;
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-tag {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        border-radius: 999px;
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 800;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.08);
        color: #fff;
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-tag.spx-ok {
        border-color: rgba(34,197,94,0.38);
        background: rgba(34,197,94,0.14);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-tag.spx-no {
        border-color: rgba(239,68,68,0.38);
        background: rgba(239,68,68,0.14);
      }

      #${ATTEMPTS_BOX_ID} .spx-decision-tag.spx-warning {
        border-color: rgba(251,146,60,0.40);
        background: rgba(251,146,60,0.14);
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 6px;
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-item {
        display: grid;
        grid-template-columns: 20px minmax(0, 1fr);
        align-items: start;
        gap: 6px;
        min-height: 42px;
        padding: 6px 7px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.035);
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        color: #fff;
        font-weight: 900;
        line-height: 1;
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-body {
        min-width: 0;
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-label {
        display: block;
        color: #fff;
        font-weight: 800;
        font-size: 11px;
        line-height: 1.12;
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-detail {
        display: block;
        color: #cbd5e1;
        font-size: 10px;
        line-height: 1.12;
        margin-top: 2px;
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-item.spx-ok {
        border-color: rgba(34,197,94,0.34);
        background: rgba(34,197,94,0.10);
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-item.spx-ok .spx-validation-icon {
        background: #16a34a;
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-item.spx-no {
        border-color: rgba(239,68,68,0.34);
        background: rgba(239,68,68,0.10);
      }

      #${ATTEMPTS_BOX_ID} .spx-validation-item.spx-no .spx-validation-icon {
        background: #dc2626;
      }

      #${ATTEMPTS_BOX_ID} .spx-tracking-list {
        position: relative;
        margin-top: 0;
        padding-left: 22px;
        padding-right: 4px;
        overflow-y: auto;
        overflow-x: hidden;
        flex: 1 1 auto;
        min-height: 72px;
      }

      #${ATTEMPTS_BOX_ID} .spx-post-tracking-section {
        display: flex;
        flex-direction: column;
        gap: 7px;
        margin-top: 7px;
        padding-top: 2px;
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-tracking-list::-webkit-scrollbar {
        width: 8px;
      }

      #${ATTEMPTS_BOX_ID} .spx-tracking-list::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.18);
        border-radius: 999px;
      }

      #${ATTEMPTS_BOX_ID} .spx-tracking-list::before {
        content: "";
        position: absolute;
        top: 15px;
        bottom: 12px;
        left: 7px;
        width: 2px;
        background: linear-gradient(180deg, #ff6000, rgba(255, 96, 0, 0.14));
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-card {
        position: relative;
        background: rgba(255,255,255,0.035);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        padding: 6px;
        margin: 0 0 5px 0;
        transition: background .16s ease, border-color .16s ease;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-card:hover {
        background: rgba(255,255,255,0.055);
        border-color: rgba(255,96,0,0.25);
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-card:last-child {
        margin-bottom: 0;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-dot {
        position: absolute;
        top: 12px;
        left: -21px;
        width: 12px;
        height: 12px;
        border-radius: 999px;
        background: #ff6000;
        border: 3px solid #0f172a;
        box-shadow: 0 0 0 2px rgba(255,96,0,0.45);
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-reason-wrap {
        display: flex;
        align-items: flex-start;
        gap: 5px;
        min-width: 0;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-index {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 19px;
        border-radius: 999px;
        background: rgba(255,96,0,0.15);
        color: #ff6000;
        font-size: 10px;
        font-weight: 900;
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-reason-tag {
        display: inline-flex;
        align-items: center;
        min-height: 19px;
        max-width: 100%;
        padding: 2px 7px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.10);
        font-weight: 800;
        font-size: 11px;
        line-height: 1.15;
      }

      #${ATTEMPTS_BOX_ID} .spx-reason-valid {
        color: #86efac;
        border-color: rgba(34,197,94,0.34);
        background: rgba(34,197,94,0.12);
      }

      #${ATTEMPTS_BOX_ID} .spx-reason-invalid {
        color: #fca5a5;
        border-color: rgba(239,68,68,0.34);
        background: rgba(239,68,68,0.12);
      }

      #${ATTEMPTS_BOX_ID} .spx-reason-finalizer {
        color: #fde68a;
        border-color: rgba(251,191,36,0.34);
        background: rgba(251,191,36,0.14);
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-reason-neutral {
        color: #fff;
        background: rgba(255,255,255,0.06);
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-date {
        color: #94a3b8;
        font-size: 10px;
        white-space: nowrap;
        padding-top: 2px;
        flex: 0 0 auto;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-row {
        color: #cbd5e1;
        font-size: 10px;
        margin-top: 4px;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-row b {
        color: #e2e8f0;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 7px;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        min-height: 28px;
        padding: 5px 10px;
        border: 1px solid transparent;
        border-radius: 7px;
        color: #fff;
        font-size: 10px;
        font-weight: 900;
        cursor: pointer;
        transition: opacity .16s ease, transform .16s ease, border-color .16s ease;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-btn svg {
        width: 13px;
        height: 13px;
        flex: 0 0 auto;
        stroke: currentColor;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-btn:hover:not(:disabled) {
        transform: translateY(-1px);
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-btn:disabled {
        cursor: wait;
        opacity: .48;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-confirm {
        background: rgba(22,163,74,.28);
        border-color: rgba(34,197,94,.58);
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-cancel {
        background: rgba(185,28,28,.28);
        border-color: rgba(239,68,68,.58);
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-status {
        width: 100%;
        color: #cbd5e1;
        font-size: 10px;
        font-weight: 700;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-status:empty {
        display: none;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-status.spx-success {
        color: #86efac;
      }

      #${ATTEMPTS_BOX_ID} .spx-eha-action-status.spx-action-error {
        color: #fca5a5;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-body {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 48px;
        gap: 7px;
        align-items: stretch;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-content {
        min-width: 0;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-thumbs {
        width: 48px;
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        align-self: stretch;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-thumb-wrap {
        position: relative;
        display: inline-flex;
        width: 100%;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-thumb {
        width: 48px;
        height: 48px;
        object-fit: cover;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.08);
        cursor: zoom-in;
        display: block;
        transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease;
      }

      #${ATTEMPTS_BOX_ID} .spx-attempt-thumb:hover {
        transform: scale(1.025);
        border-color: rgba(255,96,0,0.75);
        box-shadow: 0 0 0 2px rgba(255,96,0,0.18);
      }

      #${ATTEMPTS_BOX_ID} .spx-more-photos-badge {
        position: absolute;
        right: 4px;
        bottom: 4px;
        background: rgba(15,23,42,0.94);
        border: 1px solid rgba(255,255,255,.15);
        padding: 2px 6px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 800;
        color: #fff;
      }

      .spx-photo-lightbox {
        position: fixed;
        inset: 0;
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: rgba(2,6,23,0.78);
        backdrop-filter: blur(2px);
      }

      .spx-photo-lightbox[hidden] {
        display: none;
      }

      .spx-photo-lightbox-panel {
        position: relative;
        max-width: min(900px, 92vw);
        max-height: 88vh;
        padding: 10px;
        border-radius: 14px;
        background: #0f172a;
        border: 1px solid rgba(255,96,0,0.45);
        box-shadow: 0 24px 80px rgba(0,0,0,0.55);
      }

      .spx-photo-lightbox-close {
        position: absolute;
        top: -14px;
        right: -14px;
        width: 34px;
        height: 34px;
        border: 0;
        border-radius: 999px;
        background: #ff6000;
        color: #fff;
        font-size: 21px;
        font-weight: 900;
        cursor: pointer;
        line-height: 1;
      }

      .spx-photo-lightbox img {
        max-width: calc(92vw - 20px);
        max-height: calc(88vh - 20px);
        object-fit: contain;
        border-radius: 10px;
        display: block;
        background: rgba(0,0,0,0.2);
      }

      #${AUTOADD_TOAST_ID} {
        left: auto;
        top: auto;
        right: 20px;
        bottom: 22px;
        display: flex;
        align-items: center;
        gap: 9px;
        max-width: min(420px, calc(100vw - 32px));
        padding: 11px 14px;
        color: #dcfce7;
        background: rgba(15,23,42,0.96);
        border: 1px solid rgba(34,197,94,0.42);
        border-left: 4px solid #22c55e;
        font-size: 13px;
        font-weight: 900;
        transform: translateX(calc(100% + 32px));
        animation: spxAutoAddToastIn 260ms ease-out forwards;
        pointer-events: none;
      }

      #${AUTOADD_TOAST_ID}.spx-autoadd-next-cycle {
        color: #fef3c7;
        border-color: rgba(245,158,11,0.42);
        border-left-color: #f59e0b;
      }

      #${AUTOADD_TOAST_ID} .spx-autoadd-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        background: rgba(255,255,255,0.1);
        font-size: 13px;
      }

      #${AUTOADD_TOAST_ID} .spx-autoadd-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      @keyframes spxAutoAddToastIn {
        from { transform: translateX(calc(100% + 32px)); opacity: 0.2; }
        to { transform: translateX(0); opacity: 1; }
      }

      #${ATTEMPTS_BOX_ID} .spx-muted {
        color: #cbd5e1;
      }

      #${ATTEMPTS_BOX_ID} .spx-error {
        color: #fecaca;
      }

      @media (max-width: 720px) {
        #${ATTEMPTS_BOX_ID} {
          width: min(100vw - 20px, 620px);
          max-height: calc(100vh - 20px);
          top: 10px;
          right: 10px;
        }
      }

      @media (max-width: 560px) {
        #${ATTEMPTS_BOX_ID} .spx-attempts-meta,
        #${ATTEMPTS_BOX_ID} .spx-validation-grid {
          grid-template-columns: 1fr;
        }

        #${ATTEMPTS_BOX_ID} .spx-attempt-body {
          grid-template-columns: 1fr;
        }

        #${ATTEMPTS_BOX_ID} .spx-attempt-thumbs,
        #${ATTEMPTS_BOX_ID} .spx-attempt-thumb {
          width: 100%;
        }

        #${ATTEMPTS_BOX_ID} .spx-attempt-thumb {
          height: 110px;
        }

        #${ATTEMPTS_BOX_ID} .spx-attempt-head {
          flex-direction: column;
        }

        #${ATTEMPTS_BOX_ID} .spx-attempt-date {
          white-space: normal;
        }
      }
        `;
    document.head.appendChild(style);
  }

  function removeHint() {
    const old = document.getElementById(HINT_BOX_ID);
    if (old) old.remove();
  }

  function removeAttemptsBox() {
    const old = document.getElementById(ATTEMPTS_BOX_ID);
    if (old) old.remove();
  }

  function createHint() {
    if (!isExceptionPage()) {
      removeHint();
      return;
    }

    if (document.getElementById(HINT_BOX_ID)) return;
    ensureStyle();

    const box = document.createElement("div");
    box.id = HINT_BOX_ID;
    box.innerHTML = `
      <button id="spx-auto-hint-close" type="button">×</button>

      <div class="spx-auto-hint-title">Atalhos disponíveis</div>

      <div class="spx-auto-hint-row">
        <span class="spx-key">'</span>
        <span>Confirmar / Adicionar razão</span>
      </div>

      <div class="spx-auto-hint-row">
        <span class="spx-key">Backspace</span>
        <span>Cancelar ER</span>
      </div>
    `;

    document.body.appendChild(box);
    document.getElementById("spx-auto-hint-close").addEventListener("click", removeHint);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeReason(reason) {
    return String(reason || "")
      .replace(/^\s*\[[^\]]+\]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function translateReason(reason) {
    const clean = normalizeReason(reason);
    const key = clean.toLowerCase();
    return REASON_TRANSLATIONS[key] || clean || "-";
  }

  function normalizeRuleText(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s*\/\s*/g, " / ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  const VALID_ATTEMPT_REASONS = new Set([
    "endereco nao encontrado",
    "palavra-chave incorreta ou nao informada",
    "comercio fechado",
    "recusado por terceiros",
    "ausente"
  ]);

  const INVALID_ATTEMPT_REASONS = new Set([
    "chuva forte / desastres naturais",
    "motorista nao teve tempo de entregar",
    "nao coube no veiculo",
    "item danificado",
    "item perdido",
    "area de risco",
    "tentativa de roubo/assalto",
    "roubo/assalto",
    "motorista desistiu da rota",
    "problemas mecanicos",
    "fora de rota"
  ]);

  const FINALIZER_REASONS = new Set([
    "nao entregar",
    "mudanca de endereco",
    "rejeitado pelo comprador"
  ]);

  function getAttemptDay(value) {
    const n = Number(value || 0);
    if (!n) return "";
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(n * 1000));
  }

  function getSaoPauloDayUnixRange() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(new Date()).reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    const start = Math.floor(Date.UTC(year, month - 1, day, 3, 0, 0) / 1000);
    return { start, end: start + 86399 };
  }

  async function fetchJson(url) {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        "accept": "application/json, text/plain, */*"
      }
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
    }

    if (!res.ok || data.retcode !== 0) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }

    return data;
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const item = String(document.cookie || "")
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix));

    return item ? decodeURIComponent(item.slice(prefix.length)) : "";
  }

  function getSpxWriteHeaders() {
    const csrfToken = readCookie("csrftoken");
    const deviceId = readCookie("spx-admin-device-id") || readCookie("device-id");
    const headers = {
      "accept": "application/json, text/plain, */*",
      "app": "FMS Portal",
      "cache-control": "no-cache",
      "content-type": "application/json;charset=UTF-8",
      "pragma": "no-cache"
    };

    if (csrfToken) headers["x-csrftoken"] = csrfToken;
    if (deviceId) headers["device-id"] = deviceId;
    return headers;
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: getSpxWriteHeaders(),
      body: JSON.stringify(body)
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(text.slice(0, 300) || `HTTP ${res.status}`);
    }

    if (!res.ok || data.retcode !== 0) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }

    return data;
  }

  function selectAuditTask(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    return list.find((task) => Number(task?.end_time || 0) === 0) || list[0] || null;
  }

  function collectTrackingNodes(nodes, output) {
    if (!Array.isArray(nodes)) return output;

    nodes.forEach((node) => {
      if (!node || typeof node !== "object") return;

      output.push(node);
      collectTrackingNodes(node.children, output);
      collectTrackingNodes(node.event_children, output);
    });

    return output;
  }

  function extractAssignmentTaskId(message) {
    const text = String(message || "");
    if (!/Assignment Task/i.test(text)) return "";

    const match = text.match(/\[(AT[^\]\s]+)\]/i);
    return match ? String(match[1]).trim() : "";
  }

  function isPolygonAutoAddNode(node) {
    const operator = String(node?.operator || "").trim();
    const bizStaffName = String(node?.biz_staff_name || "").trim();
    return operator === "Admin(Polygon Auto Add)" || bizStaffName === "Admin(Polygon Auto Add)";
  }

  function isRecentAutoAddNode(node, scanUnix) {
    const timestamp = Number(node?.timestamp || 0);
    const reference = Number(scanUnix || 0);
    if (!timestamp || !reference) return false;

    return timestamp >= reference - AUTOADD_RECENT_BEFORE_SCAN_SEC &&
      timestamp <= reference + AUTOADD_RECENT_AFTER_SCAN_SEC;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function findPolygonAutoAddTargetId(trackingData, scanUnix) {
    const nodes = collectTrackingNodes(trackingData?.data?.tracking_list, []);
    const candidates = nodes
      .map((node, index) => ({
        node,
        index,
        targetId: extractAssignmentTaskId(node?.message)
      }))
      .filter((item) =>
        item.targetId &&
        isPolygonAutoAddNode(item.node) &&
        isRecentAutoAddNode(item.node, scanUnix)
      )
      .sort((a, b) => {
        const timestampDiff = Number(b.node?.timestamp || 0) - Number(a.node?.timestamp || 0);
        if (timestampDiff !== 0) return timestampDiff;

        const idDiff = Number(b.node?.id || 0) - Number(a.node?.id || 0);
        if (idDiff !== 0) return idDiff;

        return b.index - a.index;
      });

    return candidates[0]?.targetId || "";
  }

  async function fetchPolygonAutoAddTargetId(shipmentId, scanUnix) {
    const trackingUrl = `https://spx.shopee.com.br/api/fleet_order/order/detail/tracking_info?shipment_id=${encodeURIComponent(shipmentId)}`;
    const trackingData = await fetchJson(trackingUrl);
    return findPolygonAutoAddTargetId(trackingData, scanUnix);
  }

  async function fetchRecentPolygonAutoAddTargetId(shipmentId, scanUnix) {
    let lastError = null;

    for (let i = 0; i < AUTOADD_TRACKING_RETRY_DELAYS_MS.length; i += 1) {
      const delay = AUTOADD_TRACKING_RETRY_DELAYS_MS[i];
      if (delay > 0) await sleep(delay);

      try {
        const targetId = await fetchPolygonAutoAddTargetId(shipmentId, scanUnix);
        if (targetId) return targetId;
      } catch (err) {
        lastError = err;
      }
    }

    if (lastError) throw lastError;
    return "";
  }

  async function fetchAutoAddInfo(shipmentId, scanUnix) {
    try {
      const referenceUnix = Number(scanUnix || Math.floor(Date.now() / 1000));
      const autoAddTargetId = await fetchRecentPolygonAutoAddTargetId(shipmentId, referenceUnix);
      if (!autoAddTargetId) return null;

      const range = getSaoPauloDayUnixRange();
      const taskUrl = `https://spx.shopee.com.br/api/in-station/lmhub/audit/task/list?page_no=1&count=24&validation_start_time=${range.start}&validation_end_time=${range.end}`;
      const taskData = await fetchJson(taskUrl);
      const task = selectAuditTask(taskData?.data?.list);
      const taskId = task?.validation_task_id;

      if (!taskId) return null;

      const targetUrl = `https://spx.shopee.com.br/api/in-station/lmhub/audit/target/list?target_id=${encodeURIComponent(autoAddTargetId)}&task_id=${encodeURIComponent(taskId)}&page_no=1&count=24`;
      const targetData = await fetchJson(targetUrl);
      const targets = Array.isArray(targetData?.data?.list) ? targetData.data.list : [];
      const target = targets.find((item) => String(item?.target_id || "").toUpperCase() === String(autoAddTargetId).toUpperCase()) || targets[0];

      if (!target) {
        return {
          nextCycle: true,
          taskId: String(taskId),
          targetId: String(autoAddTargetId)
        };
      }

      if (!target.binding_entity) return null;

      return {
        route: String(target.binding_entity),
        taskId: String(taskId),
        targetId: String(autoAddTargetId)
      };
    } catch (err) {
      console.warn("SPX Toolkit AutoADD:", err);
      return null;
    }
  }

  function getAutoAddMessage(autoAddInfo) {
    if (autoAddInfo?.nextCycle) return "AutoAdd para o próximo ciclo";
    if (autoAddInfo?.route) return `AutoADD na rota ${autoAddInfo.route}`;
    return "";
  }

  function removeAutoAddToast() {
    const toast = document.getElementById(AUTOADD_TOAST_ID);
    if (toast) toast.remove();
  }

  function showAutoAddToast(autoAddInfo) {
    const message = getAutoAddMessage(autoAddInfo);
    removeAutoAddToast();
    if (!message) return;

    ensureStyle();

    const toast = document.createElement("div");
    toast.id = AUTOADD_TOAST_ID;
    if (autoAddInfo?.nextCycle) {
      toast.className = "spx-autoadd-next-cycle";
    }
    toast.innerHTML = `
      <span class="spx-autoadd-icon">${autoAddInfo?.nextCycle ? "↻" : "✓"}</span>
      <span class="spx-autoadd-text">${escapeHtml(message)}</span>
    `;
    document.body.appendChild(toast);
  }

  function buildAttemptDecision(attempts) {
    const reasons = attempts.map((item) => translateReason(item.on_hold_reason__desc));
    const ruleReasons = reasons.map(normalizeRuleText);
    const attemptCount = attempts.length;
    const validReasonCount = ruleReasons.filter((reason) => VALID_ATTEMPT_REASONS.has(reason)).length;
    const differentDays = new Set(attempts.map((item) => getAttemptDay(item.ctime)).filter(Boolean)).size;
    const hasFinalizer = ruleReasons.some((reason) => FINALIZER_REASONS.has(reason));
    const latestAttempt = attempts
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const timeDiff = Number(a.item?.ctime || 0) - Number(b.item?.ctime || 0);
        return timeDiff || a.index - b.index;
      })
      .at(-1)?.item;
    const latestReason = normalizeRuleText(translateReason(latestAttempt?.on_hold_reason__desc));
    const isLatestForaDeRota = latestReason === "fora de rota";

    const checks = [
      { label: "3+ tentativas", valid: attemptCount >= 3, detail: `${attemptCount} encontrada(s)` },
      { label: "3+ motivos válidos", valid: validReasonCount >= 3, detail: `${validReasonCount} válido(s)` },
      { label: "3+ dias diferentes", valid: differentDays >= 3, detail: `${differentDays} dia(s)` }
    ];

    const allReturnChecksValid = checks.every((check) => check.valid);
    let action = "PROCESSAR PARA ENTREGA";
    let actionClass = "spx-decision-good";
    let actionIcon = "✓";
    let actionNote = "Sem bloqueios para realocação ou retorno. Seguir fluxo normal de entrega.";
    let actionTags = checks.map((check) => ({
      label: check.label,
      stateClass: check.valid ? "spx-ok" : "spx-no"
    }));

    if (isLatestForaDeRota) {
      action = "REALOCAR/FLEET";
      actionClass = "spx-decision-warning";
      actionIcon = "📍";
      actionNote = "O motivo mais recente é Fora de Rota. Seguir fluxo de realocação.";
      actionTags.unshift({ label: "Último motivo: Fora de rota", stateClass: "spx-warning" });
    } else if (hasFinalizer || allReturnChecksValid) {
      action = "RETORNAR AO SOC";
      actionClass = "spx-decision-bad";
      actionIcon = "↩";
      actionNote = hasFinalizer ? "Motivo finalizador encontrado. Retorno ao SOC liberado independentemente das demais regras." : "Todas as validações obrigatórias foram atendidas. Retornar ao SOC.";
      if (hasFinalizer) {
        actionTags.unshift({ label: "Motivo finalizador", stateClass: "spx-warning" });
      }
    }

    return { checks, action, actionClass, actionIcon, actionNote, actionTags };
  }

  function applyEhaDecisionState(decision, ehaState) {
    if (!decision || decision.action !== "PROCESSAR PARA ENTREGA") return decision;

    if (ehaState === "pending") {
      return {
        ...decision,
        action: "TRATATIVA DE ENDEREÇO",
        actionClass: "spx-decision-address-pending",
        actionIcon: "⌛"
      };
    }

    if (ehaState === "confirmed") {
      return {
        ...decision,
        action: "AGUARDAR TRATATIVA (24h)",
        actionClass: "spx-decision-address-confirmed",
        actionIcon: "◷"
      };
    }

    return decision;
  }

  function renderAttemptValidations(attempts, ehaState) {
    const decision = applyEhaDecisionState(buildAttemptDecision(attempts), ehaState);
    const checksHtml = decision.checks.map((check) => `
      <div class="spx-validation-item ${check.valid ? "spx-ok" : "spx-no"}">
        <span class="spx-validation-icon">${check.valid ? "✓" : "×"}</span>
        <span class="spx-validation-body">
          <span class="spx-validation-label">${escapeHtml(check.label)}</span>
          <span class="spx-validation-detail">${escapeHtml(check.detail)}</span>
        </span>
      </div>
    `).join("");

    const tagsHtml = decision.actionTags.map((tag) => `
      <span class="spx-decision-tag ${tag.stateClass}">${escapeHtml(tag.label)}</span>
    `).join("");

    return `
      <div class="spx-post-tracking-section">
        <div class="spx-decision-card ${decision.actionClass}">
          <div class="spx-decision-head">
            <span class="spx-decision-icon">${escapeHtml(decision.actionIcon)}</span>
            <div>
              <div class="spx-decision-title">${escapeHtml(decision.action)}</div>
            </div>
          </div>
          <div class="spx-decision-tags">${tagsHtml}</div>
        </div>
       </div>
    `;
  }

  function formatDateTime(value) {
    const n = Number(value || 0);
    if (!n) return "-";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(n * 1000));
  }

  function showAttemptsBox(shipmentId, html, statusClass) {
    ensureStyle();
    removeHint();

    let box = document.getElementById(ATTEMPTS_BOX_ID);
    if (!box) {
      box = document.createElement("div");
      box.id = ATTEMPTS_BOX_ID;
      document.body.appendChild(box);
    }

    box.dataset.spxShipmentId = shipmentId;
    box.innerHTML = `
      <button id="spx-delivery-attempts-close" type="button">×</button>
      <div class="spx-auto-hint-title">Tentativas de entrega</div>
      <div class="spx-subtitle">Shipment ID: <b>${escapeHtml(shipmentId)}</b></div>
      <div class="spx-attempts-content ${statusClass || ""}">${html}</div>
    `;

    const close = document.getElementById("spx-delivery-attempts-close");
    if (close) close.addEventListener("click", removeAttemptsBox);

    box.onclick = onAttemptsBoxClick;
  }

  function ensurePhotoLightbox() {
    let viewer = document.querySelector(".spx-photo-lightbox");
    if (viewer) return viewer;

    viewer = document.createElement("div");
    viewer.className = "spx-photo-lightbox";
    viewer.hidden = true;
    viewer.innerHTML = `
      <div class="spx-photo-lightbox-panel">
        <button class="spx-photo-lightbox-close" type="button">×</button>
        <img src="" alt="Foto ampliada">
      </div>
    `;
    document.body.appendChild(viewer);

    viewer.addEventListener("click", (event) => {
      if (
        event.target === viewer ||
        event.target.closest(".spx-photo-lightbox-close")
      ) {
        viewer.hidden = true;
        const img = viewer.querySelector("img");
        if (img) img.src = "";
      }
    });

    return viewer;
  }

  function onAttemptsBoxClick(event) {
    const actionButton = event.target.closest("[data-spx-eha-action]");
    if (actionButton) {
      handleEhaAction(actionButton);
      return;
    }

    const thumb = event.target.closest(".spx-attempt-thumb");
    if (!thumb) return;

    const url = thumb.getAttribute("data-spx-photo-url") || thumb.getAttribute("src");
    if (!url) return;

    const viewer = ensurePhotoLightbox();
    const image = viewer.querySelector("img");
    if (!image) return;

    image.src = url;
    viewer.hidden = false;
  }


  function buildPhotoUrls(item) {
    const base = "https://spx.shopee.com.br/shopee-live-spx-perm-data";
    const paths = [];

    if (Array.isArray(item?.image_list)) {
      item.image_list.forEach((img) => {
        if (img && img.image_url) paths.push(img.image_url);
      });
    }

    if (Array.isArray(item?.photo_list)) {
      item.photo_list.forEach((path) => {
        if (path) paths.push(path);
      });
    }

    return Array.from(new Set(paths))
      .filter(Boolean)
      .map((path) => String(path).startsWith("http") ? String(path) : `${base}${String(path).startsWith("/") ? "" : "/"}${String(path)}`);
  }


  function getReasonClass(reason) {
    const normalized = normalizeRuleText(translateReason(reason));

    if (FINALIZER_REASONS.has(normalized)) return "spx-reason-finalizer";
    if (VALID_ATTEMPT_REASONS.has(normalized)) return "spx-reason-valid";
    if (INVALID_ATTEMPT_REASONS.has(normalized)) return "spx-reason-invalid";

    return "spx-attempt-reason-neutral";
  }

  function renderPhotoThumbs(item) {
    const urls = buildPhotoUrls(item).slice(0, 4);
    if (!urls.length) return "";

    const primary = urls[0];
    const extra = urls.length - 1;

    return `
      <div class="spx-attempt-thumbs">
        <div class="spx-attempt-thumb-wrap">
          <img
            class="spx-attempt-thumb"
            src="${escapeHtml(primary)}"
            alt="Foto da tentativa"
            title="Ampliar foto"
            data-spx-photo-url="${escapeHtml(primary)}"
          >
          ${extra > 0 ? `<span class="spx-more-photos-badge">+${extra}</span>` : ""}
        </div>
      </div>
    `;
  }

  function renderEhaActions(actionInfo) {
    if (!actionInfo) return "";

    return `
      <div
        class="spx-eha-actions"
        data-spx-eha-reason-id="${escapeHtml(actionInfo.reasonId)}"
        data-spx-eha-reason-desc="${escapeHtml(actionInfo.reasonDesc)}"
        data-spx-eha-local-lang="${escapeHtml(actionInfo.localLang)}"
      >
        <button class="spx-eha-action-btn spx-eha-confirm" type="button" data-spx-eha-action="confirm">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5"></path>
          </svg>
          <span>Confirmar</span>
        </button>
        <button class="spx-eha-action-btn spx-eha-cancel" type="button" data-spx-eha-action="cancel">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18"></path>
            <path d="m6 6 12 12"></path>
          </svg>
          <span>Cancelar</span>
        </button>
        <div class="spx-eha-action-status" aria-live="polite"></div>
      </div>
    `;
  }

  function renderAttempts(data, ehaInfo) {
    const attempts = data?.data?.recipient?.On_Hold || [];
    const ehaActionInfo = ehaInfo?.actionInfo || null;
    const ehaState = ehaInfo?.state || "";

    const summary = `
    `;

    if (!attempts.length) {
      return `${summary}<div class="spx-muted">Nenhuma tentativa On Hold encontrada.</div>`;
    }

    const orderedAttempts = attempts
      .slice()
      .sort((a, b) => Number(a?.ctime || 0) - Number(b?.ctime || 0));

    const cards = orderedAttempts.map((item, index) => {
      const translatedReason = translateReason(item.on_hold_reason__desc);
      const reasonClass = getReasonClass(item.on_hold_reason__desc);
      const isLastAddressIssue = index === orderedAttempts.length - 1 &&
        normalizeRuleText(translatedReason) === "endereco nao encontrado";
      return `
        <div class="spx-attempt-card">
          <span class="spx-attempt-dot"></span>
          <div class="spx-attempt-body">
            <div class="spx-attempt-content">
              <div class="spx-attempt-head">
                <div class="spx-attempt-reason-wrap">
                  <span class="spx-attempt-index">${index + 1}</span>
                  <span class="spx-attempt-reason-tag ${reasonClass}">${escapeHtml(translatedReason)}</span>
                </div>
                <div class="spx-attempt-date">${escapeHtml(formatDateTime(item.ctime))}</div>
              </div>
              <div class="spx-attempt-row"><b>Motorista:</b> ${escapeHtml(item.driver_name || "-")}</div>
              ${isLastAddressIssue ? renderEhaActions(ehaActionInfo) : ""}
            </div>
            ${renderPhotoThumbs(item)}
          </div>
        </div>
      `;
    }).join("");

    return `${summary}<div class="spx-tracking-list">${cards}</div>${renderAttemptValidations(orderedAttempts, ehaState)}`;
  }

  function isShipmentStillCurrent(shipmentId, seq) {
    if (typeof seq === "number" && seq !== requestSeq) return false;
    if (!shipmentId || shipmentId !== lastShipmentId) return false;

    const inputShipmentId = readShipmentId();
    return !inputShipmentId || inputShipmentId === shipmentId;
  }

  function shouldLookupAddressIssue(attempts) {
    const orderedAttempts = Array.isArray(attempts)
      ? attempts.slice().sort((a, b) => Number(a?.ctime || 0) - Number(b?.ctime || 0))
      : [];
    const lastAttempt = orderedAttempts[orderedAttempts.length - 1];
    if (!lastAttempt) return false;

    const lastReason = normalizeRuleText(translateReason(lastAttempt.on_hold_reason__desc));
    if (lastReason !== "endereco nao encontrado") return false;

    return buildAttemptDecision(orderedAttempts).action !== "RETORNAR AO SOC";
  }

  function extractAddressIssueInfo(data) {
    const reason = data?.data?.reason || {};
    const eoInfo = data?.data?.eo_info || {};
    const reasonList = Array.isArray(eoInfo?.reason_list) ? eoInfo.reason_list : [];
    const activeReason = reasonList.find((item) =>
      Number(item?.reason_status) === 1 &&
      (
        (reason?.reason_id && item?.reason_id === reason.reason_id) ||
        (reason?.reason_desc && item?.reason_desc === reason.reason_desc)
      )
    ) || reasonList.find((item) => Number(item?.reason_status) === 1);

    if (
      activeReason?.reason_desc === EHA_ADDRESS_REASON_DESC &&
      activeReason?.follow_up_function === EHA_ADDRESS_FOLLOW_UP_FUNCTION
    ) {
      return {
        state: "pending",
        actionInfo: {
          reasonId: String(activeReason.reason_id || reason.reason_id || EHA_ADDRESS_REASON_ID),
          reasonDesc: EHA_ADDRESS_REASON_DESC,
          localLang: String(activeReason.local_lang ?? reason.local_lang ?? "")
        }
      };
    }

    const isConfirmed =
      activeReason?.reason_desc === "Delivery Address Issue" ||
      activeReason?.follow_up_function === "Update Delivery Address" ||
      reason?.reason_desc === "Delivery Address Issue" ||
      reason?.reason_id === "ER41";

    if (isConfirmed) {
      return { state: "confirmed", actionInfo: null };
    }

    const isCancelled =
      Number(eoInfo?.eo_status) === 3 ||
      String(eoInfo?.eo_status_str || "").toLowerCase() === "cancelled";

    if (isCancelled) {
      return { state: "cancelled", actionInfo: null };
    }

    return { state: "", actionInfo: null };
  }

  async function fetchAddressIssueInfo(shipmentId) {
    const url = "https://spx.shopee.com.br/api/in-station/admin/common_site/eha/no_reason_inbound";
    const data = await postJson(url, { shipment_id: shipmentId });
    return extractAddressIssueInfo(data);
  }

  function updateEhaDecisionState(box, state) {
    const card = box?.querySelector(".spx-decision-card");
    const title = card?.querySelector(".spx-decision-title");
    const icon = card?.querySelector(".spx-decision-icon");
    if (!card || !title || !icon) return;

    card.classList.remove(
      "spx-decision-good",
      "spx-decision-address-pending",
      "spx-decision-address-confirmed"
    );

    if (state === "confirmed") {
      card.classList.add("spx-decision-address-confirmed");
      title.textContent = "AGUARDAR TRATATIVA (24h)";
      icon.textContent = "◷";
      return;
    }

    card.classList.add("spx-decision-good");
    title.textContent = "PROCESSAR PARA ENTREGA";
    icon.textContent = "✓";
  }

  async function handleEhaAction(button) {
    if (!button || button.disabled) return;

    const box = button.closest(`#${ATTEMPTS_BOX_ID}`);
    const actions = button.closest(".spx-eha-actions");
    const status = actions?.querySelector(".spx-eha-action-status");
    const shipmentId = String(box?.dataset?.spxShipmentId || "").trim();
    const action = button.getAttribute("data-spx-eha-action");

    if (!actions || !shipmentId || !isShipmentStillCurrent(shipmentId)) {
      if (status) {
        status.textContent = "O código mudou. A ação foi bloqueada.";
        status.className = "spx-eha-action-status spx-action-error";
      }
      return;
    }

    const reasonId = actions.getAttribute("data-spx-eha-reason-id") || EHA_ADDRESS_REASON_ID;
    const reasonDesc = actions.getAttribute("data-spx-eha-reason-desc") || EHA_ADDRESS_REASON_DESC;
    const localLang = actions.getAttribute("data-spx-eha-local-lang") || "";
    const buttons = Array.from(actions.querySelectorAll("[data-spx-eha-action]"));
    buttons.forEach((item) => { item.disabled = true; });

    if (status) {
      status.textContent = action === "confirm" ? "Confirmando..." : "Cancelando...";
      status.className = "spx-eha-action-status";
    }

    try {
      if (action === "confirm") {
        await postJson(
          "https://spx.shopee.com.br/api/in-station/admin/common_site/eha/resolve_reason",
          { shipment_id: shipmentId, reason_id: reasonId }
        );
      } else if (action === "cancel") {
        await postJson(
          "https://spx.shopee.com.br/api/in-station/admin/common_site/eha/cancel_eo_reason",
          {
            shipment_id: shipmentId,
            reason_id: reasonId,
            reason_desc: reasonDesc,
            local_lang: localLang
          }
        );
      } else {
        throw new Error("Ação inválida");
      }

      if (status) {
        status.textContent = action === "confirm" ? "Motivo confirmado com sucesso." : "Motivo cancelado com sucesso.";
        status.className = "spx-eha-action-status spx-success";
      }
      updateEhaDecisionState(box, action === "confirm" ? "confirmed" : "cancelled");
      buttons.forEach((item) => { item.hidden = true; });
      focusReceiveInputForNextScan();
    } catch (err) {
      if (status) {
        status.textContent = err && err.message ? err.message : String(err);
        status.className = "spx-eha-action-status spx-action-error";
      }
      if (isShipmentStillCurrent(shipmentId)) {
        buttons.forEach((item) => { item.disabled = false; });
      }
    }
  }

  async function fetchDeliveryHistoryInfo(shipmentId, seq) {
    try {
      const attemptsUrl = `https://spx.shopee.com.br/api/fleet_order/order/detail/recipient_info?shipment_id=${encodeURIComponent(shipmentId)}&station_type=3`;
      const data = await fetchJson(attemptsUrl);

      if (!isShipmentStillCurrent(shipmentId, seq)) return;

      const attempts = data?.data?.recipient?.On_Hold || [];
      let ehaInfo = null;

      if (shouldLookupAddressIssue(attempts)) {
        try {
          ehaInfo = await fetchAddressIssueInfo(shipmentId);
        } catch (err) {
          console.warn("SPX Toolkit EHA endereço:", err);
        }
      }

      if (!isShipmentStillCurrent(shipmentId, seq)) return;
      showAttemptsBox(shipmentId, renderAttempts(data, ehaInfo), "");
    } catch (err) {
      if (!isShipmentStillCurrent(shipmentId, seq)) return;
      showAttemptsBox(
        shipmentId,
        `Não foi possível buscar as tentativas. ${escapeHtml(err && err.message ? err.message : err)}`,
        "spx-error"
      );
    }
  }

  async function fetchAutoAddLookupInfo(shipmentId, seq, scanUnix) {
    try {
      const autoAddInfo = await fetchAutoAddInfo(shipmentId, scanUnix);
      if (seq !== requestSeq) return;
      showAutoAddToast(autoAddInfo);
    } catch (err) {
      if (seq !== requestSeq) return;
      console.warn("SPX Toolkit AutoADD:", err);
    }
  }

  function fetchAttempts(shipmentId, seq, scanUnix) {
    if (deliveryHistoryEnabled) {
      showAttemptsBox(shipmentId, `<div class="spx-muted">Buscando tentativas...</div>`, "");
      Promise.resolve(fetchDeliveryHistoryInfo(shipmentId, seq));
    } else {
      removeAttemptsBox();
    }

    Promise.resolve(fetchAutoAddLookupInfo(shipmentId, seq, scanUnix));
  }

  function findReceiveInput() {
    const inputs = Array.from(
      document.querySelectorAll('.ssc-input input[placeholder="Por favor, insira"]')
    );

    return inputs.find((input) => {
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      return (
        !input.disabled &&
        !input.readOnly &&
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    }) || null;
  }

  function focusReceiveInputForNextScan() {
    const applyFocus = () => {
      const input = findReceiveInput();
      if (!input) return false;

      try {
        input.focus({ preventScroll: true });
      } catch (_) {
        input.focus();
      }

      const valueLength = String(input.value || "").length;
      if (typeof input.setSelectionRange === "function") {
        input.setSelectionRange(0, valueLength, "forward");
      } else if (typeof input.select === "function") {
        input.select();
      }

      return (
        document.activeElement === input &&
        Number(input.selectionStart) === 0 &&
        Number(input.selectionEnd) === valueLength
      );
    };

    [0, 40, 100, 200, 350, 600].forEach((delay) => {
      window.setTimeout(applyFocus, delay);
    });
  }

  function readShipmentId() {
    const input = findReceiveInput();
    return String(input?.value || "").trim();
  }

  function onShipmentMaybeChanged() {
    if (!isReceivePage()) return;

    const shipmentId = readShipmentId();
    if (!shipmentId || shipmentId === lastShipmentId) return;

    removeAutoAddToast();
    lastShipmentId = shipmentId;
    const scanUnix = Math.floor(Date.now() / 1000);
    window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      const current = readShipmentId();
      const targetShipmentId = current || shipmentId;
      if (!targetShipmentId || targetShipmentId !== lastShipmentId) return;
      requestSeq += 1;
      fetchAttempts(targetShipmentId, requestSeq, scanUnix);
    }, AUTOADD_SCAN_DELAY_MS);
  }

  function startReceiveMonitor() {
    if (!isReceivePage()) {
      stopReceiveMonitor(true);
      removeAttemptsBox();
      removeAutoAddToast();
      return;
    }

    if (monitorTimer) {
      onShipmentMaybeChanged();
      return;
    }

    monitorTimer = window.setInterval(onShipmentMaybeChanged, 300);
    document.addEventListener("input", onShipmentMaybeChanged, true);
    document.addEventListener("change", onShipmentMaybeChanged, true);
    setTimeout(onShipmentMaybeChanged, 400);
  }

  function stopReceiveMonitor(clearShipment) {
    if (monitorTimer) {
      window.clearInterval(monitorTimer);
      monitorTimer = null;
    }
    document.removeEventListener("input", onShipmentMaybeChanged, true);
    document.removeEventListener("change", onShipmentMaybeChanged, true);
    if (clearShipment) lastShipmentId = "";
  }

  function checkPage() {
    if (ehaShortcutsEnabled && isExceptionPage()) {
      createHint();
    } else {
      removeHint();
    }

    if (isReceivePage()) {
      startReceiveMonitor();
      if (!deliveryHistoryEnabled) removeAttemptsBox();
    } else {
      stopReceiveMonitor(true);
      removeAttemptsBox();
      removeAutoAddToast();
    }
  }

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  function handleUrlMaybeChanged() {
    if (location.href === lastKnownUrl) return;
    lastKnownUrl = location.href;
    setTimeout(checkPage, 250);
  }

  function startUrlWatcher() {
    if (urlWatchTimer) return;
    urlWatchTimer = window.setInterval(handleUrlMaybeChanged, 500);
  }

  history.pushState = function () {
    originalPushState.apply(this, arguments);
    handleUrlMaybeChanged();
    setTimeout(checkPage, 300);
  };

  history.replaceState = function () {
    originalReplaceState.apply(this, arguments);
    handleUrlMaybeChanged();
    setTimeout(checkPage, 300);
  };

  window.addEventListener("hashchange", () => {
    handleUrlMaybeChanged();
    checkPage();
  });
  window.addEventListener("popstate", () => {
    handleUrlMaybeChanged();
    checkPage();
  });
  window.addEventListener("focus", checkPage);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkPage();
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      let shouldRefresh = false;

      if (changes[STORAGE_KEYS.deliveryHistory]) {
        deliveryHistoryEnabled = changes[STORAGE_KEYS.deliveryHistory].newValue !== false;
        shouldRefresh = true;
      }

      if (changes[STORAGE_KEYS.ehaShortcuts]) {
        ehaShortcutsEnabled = changes[STORAGE_KEYS.ehaShortcuts].newValue !== false;
        shouldRefresh = true;
      }

      if (shouldRefresh) checkPage();
    });
  }

  startUrlWatcher();
  readSettings(() => {
    checkPage();
    setTimeout(checkPage, 800);
    setTimeout(checkPage, 1800);
  });
})();
