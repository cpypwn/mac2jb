'use strict';
const $ = (id) => document.getElementById(id),
  key = location.hash.slice(1),
  selection = new Set();
let hardStopping = false;
let state = null,
  step = 'launch',
  busy = false,
  timer = null,
  notificationKey = '',
  dismissed = '',
  packageStamp = '',
  requestId = null,
  finishedAttempt = '',
  setupStamp = '',
  resultStamp = '',
  pendingSetup = null,
  logFollow = true,
  logWriting = false,
  backendNotice = '';
const startupSelection = new Set();
let startupStamp = '';
try {
  for (const id of JSON.parse(
    (localStorage.getItem('iz2s.startupModules') ?? localStorage.getItem('iz15.startupModules')) || '[]',
  ))
    startupSelection.add(id);
} catch {}
function saveStartup() {
  localStorage.setItem(
    'iz2s.startupModules',
    JSON.stringify([...startupSelection]),
  );
  localStorage.setItem(
    'iz2s.startupEnabled',
    $('preload-enabled').checked ? '1' : '0',
  );
}
try {
  $('preload-enabled').checked =
    (localStorage.getItem('iz2s.startupEnabled') ?? localStorage.getItem('iz15.startupEnabled')) === '1';
} catch {}
const words = {
  server: ['Server', 'i-server'],
  arm: ['ARM PC', 'i-arm'],
  usb: ['ARM Type C - Switch', 'i-usb'],
  lan: ['Console', 'i-lan'],
};
const element = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
function folderButton(kind, id, text = 'Open folder') {
  const button = element('button', 'quiet folder-button');
  button.type = 'button';
  button.innerHTML = '<svg aria-hidden="true"><use href="#i-folder"/></svg>';
  button.append(element('span', '', text));
  button.setAttribute('aria-label', text);
  button.title = text;
  button.disabled = !!state?.preview;
  button.onclick = async event => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try { await api('/api/folder/open', { kind, ...(id ? { id } : {}) }); }
    catch (error) { notice(error.message); }
    finally { button.disabled = !!state?.preview; }
  };
  return button;
}
const date = (value) =>
  value ? new Date(value).toLocaleString('en-GB', { hour12: false }) : '';
async function api(route, data) {
  const res = await fetch(route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'x-iz-key': key,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await res.json();
  if (!res.ok) throw Error(result.error || 'The server did not respond');
  return result;
}
function notice(message, type = 'error', identity = message) {
  if (identity === dismissed) return;
  notificationKey = identity;
  $('toast').hidden = false;
  $('toast').classList.toggle('success', type === 'success');
  $('toast-title').textContent =
    type === 'success' ? 'All set.' : 'Something needs attention.';
  $('toast-text').textContent = message;
  $('toast').querySelector('.toast-symbol').textContent =
    type === 'success' ? '✓' : '!';
}
async function act(route, data) {
  if (busy) return;
  busy = true;
  renderControls();
  try {
    const result = await api(route, data);
    await poll();
    return result;
  } catch (e) {
    notice(e.message);
  } finally {
    busy = false;
    renderControls();
  }
}
function switchView(id) {
  document.querySelectorAll('.view').forEach((e) => (e.hidden = e.id !== id));
  document
    .querySelectorAll('[data-view]')
    .forEach((e) => e.classList.toggle('active', e.dataset.view === id));
}
function chooseStep(value) {
  step = value;
  requestId = null;
  $('screen-ready').checked = false;
  document
    .querySelectorAll('[data-step]')
    .forEach((e) => e.classList.toggle('selected', e.dataset.step === step));
  renderControls();
  if (state) renderWizard();
}
function fieldsDirty(container, values) {
  return Object.entries(fieldValues(container)).some(
    ([name, value]) => String(value) !== String(values?.[name] ?? ''),
  );
}
function deliveryDirty() {
  return (
    !!state?.platform?.izModules &&
    fieldsDirty($('delivery-fields'), state.platform.loaderSettings)
  );
}
function renderControls() {
  if(state?.platform)renderArmSetup(state.platform);
  renderPlatformControls();
  const setup = state?.active?.kind === 'bootstrap' ? state.active.setup : null,
    reboot = setup?.stage === 'reboot',
    active = !!state?.active,
    ready = !!state?.checks.ready,
    ack = $('screen-ready').checked,
    initial = !active || reboot;
  $('recovery-option').hidden =
    step !== 'bootstrap' || !initial || !state?.recoverySetupAvailable;
  $('recovery-enabled').disabled =
    busy || !initial || !state?.recoverySetupAvailable;
  if (state && !state.recoverySetupAvailable)
    $('recovery-enabled').checked = false;
  $('launch-modules').hidden = step !== 'launch' && !reboot;
  $('preload-options').hidden = !$('preload-enabled').checked;
  $('preload-enabled').disabled = busy || !initial;
  $('preload-clear').disabled = busy || !initial;
  document
    .querySelectorAll('#preload-list input')
    .forEach((e) => (e.disabled = busy || !initial || e.dataset.unavailable === 'true'));
  $('preload-count').textContent = startupSelection.size + ' selected';
  $('start').disabled =
    busy ||
    !!state?.emergencyInputPending ||
    !initial ||
    !ready ||
    !ack ||
    !!state?.preview ||
    !state?.setupWizard ||
    deliveryDirty();
  $('start-label').textContent =
    reboot || step === 'launch'
      ? 'Load IZlauncher'
      : 'Install ' +
        ($('recovery-enabled').checked && state?.recoverySetupAvailable
          ? state?.platform?.delivery?.recoveryBootstrapName || 'NS2R'
          : state?.platform?.delivery?.baseBootstrapName || 'NS2');
  $('start').hidden = !initial;
  $('gate-message').textContent = deliveryDirty()
    ? 'Save the loading settings before launch.'
    : state?.emergencyInputPending
      ? 'Check the ARM PC connection. Press red STOP to retry input cancellation.'
      : !state?.setupWizard
        ? 'Restart Platform to activate the updated setup flow'
        : active && !reboot
          ? 'Leave the console on the indicated screen.'
          : state?.preview
            ? 'Preview · device commands disabled'
            : !ready
              ? 'Waiting for '+(state?.checks?.items?.length || 0)+' device checks'
              : !ack
                ? 'Confirm the console screen to continue'
                : 'All checks passed · ready to start';
  $('hard-stop').hidden = !active && !busy && !state?.emergencyInputPending;
  $('hard-stop').disabled = hardStopping || !state?.hardStopAvailable;
  $('stop').hidden = !active;
  $('stop').disabled = busy || state?.active?.status === 'stopping';
  $('stop').textContent =
    state?.active?.status === 'stopping'
      ? 'Disconnecting…'
      : state?.active?.kind === 'bootstrap'
        ? 'Cancel setup'
        : 'Disconnect safely';
  $('screen-ready').disabled = !initial || busy;
  $('screen-ready').parentElement.hidden = !initial;
  document
    .querySelectorAll('[data-step]')
    .forEach((e) => (e.disabled = active || busy));
  $('recheck').disabled = !!state?.active?.inputActive || busy;
  $('load').disabled =
    busy || !state?.connected || !selection.size || !!state?.preview;
  document.querySelectorAll('.module-host-actions button').forEach(button => {
    const source = button.closest('.local-module')?.querySelector('.local-source');
    button.disabled = busy || !!state?.preview || button.dataset.unavailable === 'true' || (!!source && !source.value.trim());
  });
  document
    .querySelectorAll(
      '.transport-choice button,.transport-choice input,.address-form input,.address-form select,.address-form button,.detected-peer',
    )
    .forEach(
      (e) =>
        (e.disabled =
          busy ||
          !state?.connections ||
          !!state?.connections?.locked ||
          !!state?.preview ||
          e.dataset.unavailable === 'true'),
    );
  const hidDisabled = busy || !ready || !!state?.preview || !state?.setupWizard;
  $('verify-source').disabled = hidDisabled || !$('review-ready').checked;
  $('skip-source').disabled =
    busy || !$('review-ready').checked || !state?.setupWizard;
  $('save-source').disabled = hidDisabled;
  $('compare-source').disabled =
    busy ||
    !$('check-lines').checked ||
    !Array.from({ length: 6 }, (_, i) => $('metric-' + i).value).every((s) =>
      /^[0-9]{1,8}$/.test(s),
    );
  $('reverify-source').disabled = hidDisabled;
  $('confirm-saved').disabled = busy || !$('saved-ready').checked;
  $('retry').disabled = busy;
  $('restart-setup').disabled = busy;
  $('edit-readings').disabled = busy;
}
function renderWizard() {
  if (state?.platform && !state.platform.izModules) {
    renderPlatformControls();
    renderEngineInstall();
    return;
  }
  const row = state.active;
  if (row?.kind === 'launch') {
    step = 'launch';
    document
      .querySelectorAll('[data-step]')
      .forEach((e) =>
        e.classList.toggle('selected', e.dataset.step === 'launch'),
      );
  }
  const setup = row?.kind === 'bootstrap' ? row.setup : null,
    stage = setup?.stage || 'prepare',
    show = step === 'bootstrap' || !!setup;
  for (const id of [
    'wizard-review',
    'wizard-values',
    'wizard-results',
    'wizard-save',
    'wizard-saved',
  ])
    $(id).hidden = true;
  $('wizard-steps').hidden = !show;
  renderInstallationSlot();
  const failed =
    !row && ['failed', 'cancelled'].includes(state.lastAttempt?.status);
  $('retry').hidden = !failed;
  const source =
      setup ||
      ($('recovery-enabled').checked && state.recoverySetupAvailable
        ? state.recoverySource
        : state.platform?.baseSource),
    lines = source?.lines || 229,
    sourceSlot = source?.sourceSlot ?? 0,
    name =
      setup?.name ||
      ($('recovery-enabled').checked && state.recoverySetupAvailable
        ? state.platform?.delivery?.recoveryBootstrapName || 'NS2R'
        : state.platform?.delivery?.baseBootstrapName || 'NS2');
  document.querySelector('[data-phase=typing]').textContent = lines + ' lines';
  document.querySelector('[data-phase=save]').textContent = 'Save ' + name;
  for (let i = 0; i < 3; i++) {
    const part = source?.parts?.[i];
    if (part)
      document.querySelector('label[for=metric-' + i * 2 + ']').textContent =
        i + 1 + ' · lines ' + part.first + '–' + part.last;
  }
  $('check-lines').nextElementSibling.textContent =
    'The check finished without errors. SOURCE LINES shows ' +
    lines +
    ', or ' +
    (lines + 1) +
    ' with only one empty final line.';
  $('save-source').firstChild.textContent = 'Save as ' + name + ' ';
  $('saved-ready').nextElementSibling.textContent =
    name + ' was saved successfully on the console.';
  $('recovery-status').hidden = !state.recoverySetupAvailable;
  $('recovery-status').textContent =
    state.link?.state === 'waiting-for-dock'
      ? 'Connection interrupted · waiting for the console to reconnect.'
      : state.link?.protocol === 2
        ? 'Automatic connection recovery is active.'
        : state.active?.kind === 'launch'
          ? 'This session uses the original NS2. Install NS2R to enable recovery.'
          : state.bootstrapProfile?.recovery
            ? (state.platform?.delivery?.bootstrapName || 'NS2R') +
              ' is selected for the next launch.'
            : 'Connection recovery needs a one-time NS2R installation.';
  const descriptions = {
    prepare:
      'In SmileBASIC, choose Make a Program and open Direct mode (the black console screen). Slot 0 must be empty. I will enter LIST 0:1 first, then the original 229 lines.',
    typing:
      'Entering the original source into EDIT0. Keep SmileBASIC open and do not switch screens.',
    review:
      'Are all 229 source lines present, with END on the last source line? An empty line 230 after the final Enter is normal. The three-part source check is optional.',
    checking:
      'Switching to Direct automatically when needed, then entering ordinary read-only source checks. The bootstrap is not executed.',
    values:
      'Read the six numbers from the Switch. The PC cannot read or validate the console output automatically.',
    mismatch:
      'Some source readings differ. Review the marked part and line range. Download a diagnostic for analysis, correct the readings if mistyped, or start again.',
    save: 'Ready to save the source as NS2. Saving is a separate action and never starts the bootstrap.',
    saving:
      'Sending the save command in Direct mode. Confirm any on-console Save / Overwrite dialog.',
    save_confirmation:
      'Has SmileBASIC saved NS2 successfully? Confirm the result on the Switch before continuing.',
    reboot:
      'Fully restart the Switch. Then open SmileBASIC → Make a Program → Direct (the black screen). Only confirm the checkbox below after this is done.',
  };
  if (show) {
    $('step-description').textContent = (
      descriptions[stage] || descriptions.prepare
    )
      .replaceAll('229', String(lines))
      .replaceAll('230', String(lines + 1))
      .replaceAll('original ', name === 'NS2R' ? 'recovery ' : 'original ')
      .replaceAll('as NS2.', 'as ' + name + '.')
      .replaceAll('saved NS2 successfully', 'saved ' + name + ' successfully')
      .replaceAll('Slot 0', 'Slot ' + sourceSlot)
      .replaceAll('LIST 0:1', 'LIST ' + sourceSlot + ':1')
      .replaceAll('EDIT0', 'EDIT' + sourceSlot);
    $('screen-label').textContent =
      stage === 'reboot'
        ? 'I fully restarted the Switch and opened fresh SmileBASIC Direct.'
        : 'I opened fresh SmileBASIC → Make a Program → Direct, slot ' +
          sourceSlot +
          ' is empty, keyboard is English (US), Caps Lock is off.';
  } else {
    $('step-description').textContent =
      row?.kind === 'launch'
          ? 'Keep SmileBASIC open. The original launch sequence is running; no memory preparation is repeated automatically.'
          : 'Use the program already saved on your console. Fully restart the Switch and open fresh SmileBASIC Direct before launching.';
    $('screen-label').textContent = state.platform?.delivery?.preloaded
      ? 'After a full restart, the bootstrap is loaded in slot 0 and Direct is open; RUN and REMOVE have not been executed.'
      : 'I fully restarted the Switch and opened fresh SmileBASIC Direct.';
  }
  const stamp = (row?.id || 'none') + ':' + stage;
  if (stamp !== setupStamp) {
    const previous = setupStamp.split(':').at(-1);
    setupStamp = stamp;
    if (stage === 'review') $('review-ready').checked = false;
    if (stage === 'values') {
      $('check-lines').checked = false;
      if (previous === 'checking')
        for (let i = 0; i < 6; i++) $('metric-' + i).value = '';
    }
    if (stage === 'save_confirmation') $('saved-ready').checked = false;
    if (stage === 'reboot') {
      requestId = null;
      $('screen-ready').checked = false;
    }
  }
  $('wizard-review').hidden = !setup || stage !== 'review';
  $('wizard-values').hidden = !setup || stage !== 'values';
  $('wizard-save').hidden = !setup || stage !== 'save';
  $('wizard-saved').hidden = !setup || stage !== 'save_confirmation';
  if (setup) {
    $('review-label').textContent =
      'All ' +
      lines +
      ' source lines are present, the last source line is END, and I left the console in ' +
      (setup.screen === 'editor' ? 'the editor.' : 'Direct mode.');
    $('save-note').textContent =
      setup.verification === 'passed'
        ? 'All three parts match the entered readings. The next button enters SAVE “TXT:NS2” in Direct.'
        : 'You skipped the optional check. The received source remains unverified. The next button enters SAVE “TXT:NS2” in Direct.';
    $('save-note').textContent =
      $('save-note').textContent.replaceAll('TXT:NS2', 'TXT:' + name) +
      ' · SAVE "TXT:' +
      name +
      '",' +
      sourceSlot;
    const comparison = setup.comparison;
    if (comparison && ['mismatch', 'save'].includes(stage)) {
      $('wizard-results').hidden = false;
      const fingerprint = JSON.stringify(comparison);
      if (fingerprint !== resultStamp) {
        resultStamp = fingerprint;
        $('part-results').replaceChildren();
        for (const part of comparison.parts) {
          const box = element(
            'div',
            'part-result' + (part.matches ? '' : ' mismatch'),
          );
          box.append(
            element(
              'strong',
              '',
              `Part ${part.index} · lines ${part.first}–${part.last} · ${part.matches ? 'Matches' : 'Mismatch'}`,
            ),
            element(
              'span',
              '',
              `Characters: ${part.actual.characters} / expected ${part.characters}`,
            ),
            element(
              'span',
              '',
              `Checksum: ${part.actual.checksum} / expected ${part.checksum}`,
            ),
            element(
              'span',
              '',
              `Text storage: ${part.actual.characters * 2} / expected ${part.utf16Bytes} bytes (UTF-16, derived)`,
            ),
          );
          $('part-results').append(box);
        }
      }
      $('edit-readings').hidden = stage !== 'mismatch';
      $('restart-setup').hidden = stage !== 'mismatch';
    }
  }
  const phases = ['prepare', 'typing', 'review', 'save', 'reboot', 'launch'],
    phase = ['checking', 'values', 'mismatch'].includes(stage)
      ? 'review'
      : ['saving', 'save_confirmation'].includes(stage)
        ? 'save'
        : stage;
  document.querySelectorAll('[data-phase]').forEach((e) => {
    e.classList.toggle('current', e.dataset.phase === phase);
    e.classList.toggle(
      'done',
      phases.indexOf(e.dataset.phase) < phases.indexOf(phase),
    );
  });
  renderControls();
  renderEngineInstall();
}

const networkName = (mode) => (mode === 'wifi' ? 'Wi-Fi' : 'LAN');
async function changeConnection(id, mode, ip, modes) {
  const result = await act('/api/connection', {
    id,
    ...(mode === undefined ? {} : { mode }),
    ...(ip === undefined ? {} : { ip }),
    ...(modes === undefined ? {} : { modes }),
  });
  if (result?.ok) {
    $('screen-ready').checked = false;
    requestId = null;
    renderControls();
  }
}
function renderConsoleConnections(card, preference, locked, supported) {
  const modes = preference.modes || [preference.mode];
  card.querySelectorAll('[data-transport]').forEach((label) => {
    const selected = modes.includes(label.dataset.transport),
      input = label.querySelector('input');
    label.classList.toggle('selected', selected);
    input.checked = selected;
    input.dataset.unavailable = String(
      !supported || (selected && modes.length === 1),
    );
    input.disabled = locked || input.dataset.unavailable === 'true';
  });
  const editor = card.querySelector('.address-editor');
  if (!editor.dataset.dual) {
    editor.dataset.dual = 'true';
    const summary = element('summary');
    editor.replaceChildren(summary);
    for (const mode of ['lan', 'wifi']) {
      const form = element('form', 'address-form console-address');
      form.dataset.mode = mode;
      const label = element('label', '', networkName(mode) + ' IP'),
        input = element('input'),
        apply = element('button', '', 'Apply'),
        status = element('p', 'console-path');
      input.type = 'text';
      input.inputMode = 'decimal';
      input.autocomplete = 'off';
      input.placeholder = 'Automatic · optional address';
      input.id = 'console-address-' + mode;
      input.setAttribute(
        'aria-label',
        'Console ' + networkName(mode) + ' IP address',
      );
      label.htmlFor = input.id;
      apply.type = 'submit';
      const auto = element('button', 'quiet', 'Auto');
      auto.type = 'button';
      auto.onclick = () =>
        changeConnection('lan', mode, '', state.connections.devices.lan.modes);
      form.append(label, input, apply, auto, status);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pref = state.connections.devices.lan;
        await changeConnection(
          'lan',
          mode,
          input.value.trim(),
          pref.modes || [pref.mode],
        );
      });
      editor.append(form);
    }
  }
  const active = preference.paths?.find(
    (p) => p.ready && p.mode === preference.activeMode,
  );
  editor.querySelector('summary').textContent = active
    ? networkName(active.mode) + ' · ' + active.address + ' · Edit'
    : modes.map(networkName).join(' + ') + ' · Auto / manual';
  for (const form of editor.querySelectorAll('form')) {
    const mode = form.dataset.mode,
      input = form.querySelector('input'),
      path = preference.paths?.find((p) => p.mode === mode),
      enabled = modes.includes(mode),
      status = form.querySelector('.console-path'),
      value =
        preference.addresses[mode] ||
        preference.candidates?.find((p) => p.mode === mode)?.address ||
        '';
    if (document.activeElement !== input) input.value = value;
    const lastKnown=preference.lastKnownAddresses?.[mode];input.placeholder=lastKnown?'Auto · last known '+lastKnown.address:'Automatic · optional address';
    form.querySelectorAll('input,button').forEach((e) => {
      e.dataset.unavailable = String(!supported);
      e.disabled = locked || !supported;
    });
    status.textContent = !supported
      ? 'Restart Platform to enable both connections'
      : !enabled
        ? 'Not selected'
        : !path
          ? (lastKnown?'Last known · '+lastKnown.address+' · not checked':'Not checked')
          : path.pending
            ? 'Automatic · waiting for Switch'+(lastKnown?' · last known '+lastKnown.address:'')
            : path.ready
              ? (mode === preference.activeMode ? 'In use' : 'Available') +
                (Number.isFinite(path.latencyMs)
                  ? ' · ' + path.latencyMs.toFixed(2) + ' ms'
                  : '')
              : 'Unavailable';
    status.title = path?.error || (lastKnown?'Verified '+lastKnown.verifiedAt+'; current connection not confirmed':'');
    status.classList.toggle('available', !!path?.ready && enabled);
    status.classList.toggle(
      'active',
      mode === preference.activeMode && !!path?.ready,
    );
  }
  card.querySelector('.console-paths')?.remove();
}
function renderArmSetup(meta) {
  const panel = $('arm-setup');
  panel.hidden = meta.configuration.inputAdapter !== 'ssh-gadget';
  if (panel.hidden) return;
  const source = meta.profiles?.[meta.configurationId] || {};
  const fields = { 'arm-setup-address': source.armAddress || meta.configuration.settings?.armAddress || '', 'arm-setup-user': source.armUser || 'root', 'arm-setup-key': source.sshIdentity || '' };
  if(panel.dataset.configuration!==meta.configurationId){panel.dataset.configuration=meta.configurationId;panel.open=!state.checks.items.find(x=>x.id==='arm')?.ready;}
  for(const [id,value] of Object.entries(fields)) if(document.activeElement!==$(id) && !$(id).dataset.edited) $(id).value=value;
  const ready=state.checks.items.find(x=>x.id==='arm')?.ready;
  $('arm-setup-status').textContent=ready?'Input device ready · setup guide remains available':'Install the input package before the first connection';
  const locked=busy||!!meta.locked||!!state.preview;
  panel.querySelectorAll('input,button').forEach(e=>{if(!['arm-method-ssh','arm-method-manual','arm-package-download'].includes(e.id))e.disabled=locked;});
  $('arm-install-target').textContent='Target folder: '+(meta.configuration.inputDirectory||'/opt/iz2s/arm-input')+' · service: iz2s-discovery.service';
  $('arm-install').disabled ||= !$('arm-install-confirm').checked;
}
function renderDeviceDetail(container, row) {
  const detail = String(row.detail || 'Not checked');
  if (!container.querySelector('.detail-text')) {
    const text = element('span', 'detail-text');
    const help = element('button', 'detail-help', '?');
    help.type = 'button';
    const tooltip = element('span', 'detail-tooltip');
    tooltip.id = 'device-help-' + row.id;
    tooltip.setAttribute('role', 'tooltip');
    help.setAttribute('aria-describedby', tooltip.id);
    help.setAttribute('aria-label', 'Connection details');
    help.setAttribute('aria-expanded', 'false');
    help.append(tooltip);
    help.onclick = (event) => {
      event.stopPropagation();
      const open = help.getAttribute('aria-expanded') !== 'true';
      document.querySelectorAll('.detail-help[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
      help.setAttribute('aria-expanded', String(open));
    };
    help.onkeydown = (event) => {
      if (event.key === 'Escape') { help.setAttribute('aria-expanded', 'false'); help.blur(); }
    };
    container.replaceChildren(text, help);
  }
  const extended = detail.length > 70 || detail.includes('\n');
  const first = detail.split(/\.(?:\s|$)|\n/)[0];
  container.querySelector('.detail-text').textContent = extended
    ? (first.length <= 55 ? first.replace(/[.;]$/, '') + '.' : row.pending ? 'Waiting for connection.' : row.ready ? 'Ready.' : 'Setup required.')
    : detail;
  container.querySelector('.detail-help').hidden = !extended;
  container.querySelector('.detail-tooltip').textContent = detail;
}
document.addEventListener('click', (event) => {
  if (!event.target.closest('.detail-help')) document.querySelectorAll('.detail-help[aria-expanded="true"]').forEach(button => button.setAttribute('aria-expanded', 'false'));
});
function renderDevices() {
  const config = state.connections;
  for(const card of [...$('devices').children])if(!state.checks.items.some(row=>card.id==='device-'+row.id))card.remove();
  $('devices').style.setProperty('--device-count',state.checks.items.length);
  for (const row of state.checks.items) {
    let card = $('device-' + row.id);
    const preference = config?.devices[row.id];
    if (!card) {
      card = element('article', 'device');
      card.id = 'device-' + row.id;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#' + words[row.id][1]);
      svg.setAttribute('aria-hidden', 'true');
      svg.append(use);
      const heading = element('div', 'device-heading');
      heading.append(
        svg,
        element('span', 'state'),
        element('h3', '', words[row.id][0]),
        element('p', 'device-detail'),
        element('p', 'device-ping'),
      );
      card.append(heading);
      if (row.id !== 'usb') {
        const group = element('div', 'transport-choice');
        group.setAttribute('role', 'group');
        group.setAttribute(
          'aria-label',
          words[row.id][0] + ' network connection',
        );
        for (const mode of ['lan', 'wifi']) {
          const button = element(
            row.id === 'lan' ? 'label' : 'button',
            'transport-option',
          );
          button.dataset.transport = mode;
          button.title = networkName(mode);
          if (row.id === 'lan') {
            const input = element('input');
            input.type = 'checkbox';
            input.setAttribute(
              'aria-label',
              'Enable console ' + networkName(mode),
            );
            input.addEventListener('change', () => {
              const current = state.connections.devices.lan.modes || [
                  state.connections.devices.lan.mode,
                ],
                modes = input.checked
                  ? [...new Set([...current, mode])]
                  : current.filter((m) => m !== mode);
              if (!modes.length) {
                input.checked = true;
                return;
              }
              changeConnection(row.id, undefined, undefined, modes);
            });
            button.append(input, element('span', 'transport-tick', '✓'));
          } else {
            button.type = 'button';
            button.setAttribute('aria-label', networkName(mode));
            button.addEventListener('click', () =>
              changeConnection(row.id, mode),
            );
          }
          const icon = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'svg',
            ),
            symbol = document.createElementNS(
              'http://www.w3.org/2000/svg',
              'use',
            );
          symbol.setAttribute('href', mode === 'wifi' ? '#i-wifi' : '#i-lan');
          icon.setAttribute('aria-hidden', 'true');
          icon.append(symbol);
          button.append(icon);
          group.append(button);
        }
        const editor = element('details', 'address-editor'),
          summary = element('summary'),
          form = element('form', 'address-form'),
          label = element(
            'label',
            '',
            row.id === 'server' ? 'Listen on this PC' : 'Device IP address',
          );
        const input = element(row.id === 'server' ? 'select' : 'input');
        input.id = 'address-' + row.id;
        input.setAttribute('aria-label', words[row.id][0] + ' IP address');
        if (row.id !== 'server') {
          input.type = 'text';
          input.inputMode = 'decimal';
          input.autocomplete = 'off';
          input.placeholder = 'Automatic · or enter IP';
          const list = element('datalist');
          list.id = 'addresses-' + row.id;
          input.setAttribute('list', list.id);
          form.append(list);
        }
        const apply = element('button', '', 'Apply');
        apply.type = 'submit';
        label.htmlFor = input.id;
        const automatic = element('button', 'quiet', 'Auto');
        automatic.type = 'button';
        automatic.onclick = () =>
          act('/api/connection', {
            id: row.id,
            mode: state.connections.devices[row.id].mode,
            automatic: true,
          });
        form.append(label, input, apply, automatic);
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const pref = state.connections?.devices[row.id];
          if (!pref) return;
          await changeConnection(row.id, pref.mode, input.value.trim());
        });
        const suggestions = element('div', 'detected-peers');
        editor.append(summary, suggestions, form);
        card.append(group, editor);
      } else {
        const fixed = element('div', 'fixed-transport');
        fixed.title = 'USB · direct cable';
        fixed.setAttribute('aria-label', 'USB · direct cable');
        const usb = svg.cloneNode(true);
        fixed.append(usb);
        card.append(fixed);
      }
    }
    $('devices').append(card);
    card.querySelector('h3').textContent=row.label||words[row.id][0];
    card.classList.toggle('ready', row.ready);
    card.querySelector('.state').textContent = row.ready
      ? row.pending
        ? 'AUTO'
        : '✓ READY'
      : state.preview
        ? 'PREVIEW'
        : '○ WAITING';
    renderDeviceDetail(card.querySelector('.device-detail'), row);
    const ping = card.querySelector('.device-ping');
    ping.hidden = !Number.isFinite(row.latencyMs);
    ping.textContent = Number.isFinite(row.latencyMs)
      ? 'Last ping · ' + row.latencyMs.toFixed(2) + ' ms'
      : '';
    if (preference) {
      const locked = busy || !!config.locked || !!state.preview;
      if (row.id === 'lan') {
        renderConsoleConnections(
          card,
          preference,
          locked,
          config.dualConsoleSupported,
        );
        card
          .querySelector('.device-heading use')
          .setAttribute(
            'href',
            '#' +
              (preference.activeMode === 'wifi' ||
              (preference.modes?.length !== 2 && preference.mode === 'wifi')
                ? 'i-wifi'
                : 'i-lan'),
          );
        continue;
      }
      card.querySelectorAll('[data-transport]').forEach((button) => {
        const selected = button.dataset.transport === preference.mode;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-pressed', String(selected));
        button.disabled = locked;
      });
      const icon =
        row.id === 'lan'
          ? preference.mode === 'wifi'
            ? 'i-wifi'
            : 'i-lan'
          : words[row.id][1];
      card.querySelector('use').setAttribute('href', '#' + icon);
      const editor = card.querySelector('.address-editor'),
        input = $('address-' + row.id);
      editor.querySelector('summary').textContent = preference.address
        ? (preference.automatic ? 'Auto · ' : '') +
          preference.address +
          ' · Edit'
        : 'Auto / manual · ' + networkName(preference.mode);
      if (document.activeElement !== input) {
        if (row.id === 'server') {
          const options = preference.options.filter(
              (o) => o.mode === preference.mode,
            ),
            stamp = JSON.stringify([
              options,
              preference.address,
              preference.automatic,
            ]);
          if (input.dataset.stamp !== stamp) {
            input.dataset.stamp = stamp;
            input.replaceChildren();
            const automatic = element('option', '', 'Automatic');
            automatic.value = '';
            input.append(automatic);
            if (
              preference.address &&
              !options.some((o) => o.address === preference.address)
            ) {
              const option = element(
                'option',
                '',
                preference.address ||
                  'No active ' + networkName(preference.mode) + ' adapter',
              );
              option.value = preference.address;
              input.append(option);
            }
            for (const item of options) {
              const option = element(
                'option',
                '',
                item.address + ' · ' + item.name,
              );
              option.value = item.address;
              input.append(option);
            }
            input.value = preference.automatic ? '' : preference.address;
          }
        } else if (input.dataset.mode !== preference.mode || !editor.open)
          input.value = preference.address;
        input.dataset.mode = preference.mode;
      }
      if (row.id !== 'server') {
        const list = $('addresses-' + row.id),
          stamp = JSON.stringify(preference.options);
        if (list.dataset.stamp !== stamp) {
          list.dataset.stamp = stamp;
          list.replaceChildren();
          for (const item of preference.options) {
            const option = element('option');
            option.value = item.address;
            option.label = item.name || item.address;
            list.append(option);
          }
        }
      }
      const suggestions = editor.querySelector('.detected-peers'),
        choices =
          row.id === 'server'
            ? []
            : preference.options.filter(
                (p) => p.address !== state.connections.devices.server.address,
              ),
        choiceStamp = JSON.stringify([preference.mode, choices]);
      if (suggestions.dataset.stamp !== choiceStamp) {
        suggestions.dataset.stamp = choiceStamp;
        suggestions.replaceChildren();
        if (choices.length) {
          suggestions.append(
            element('span', '', 'Detected on ' + networkName(preference.mode)),
          );
          for (const item of choices.slice(0, 5)) {
            const choose = element(
              'button',
              'detected-peer',
              item.name ? item.name + ' · ' + item.address : item.address,
            );
            choose.type = 'button';
            choose.addEventListener('click', () =>
              changeConnection(
                row.id,
                state.connections.devices[row.id].mode,
                item.address,
              ),
            );
            suggestions.append(choose);
          }
        }
      }
      input.disabled = locked;
      editor
        .querySelectorAll('button')
        .forEach((button) => (button.disabled = locked));
    } else if (row.id !== 'usb') {
      card
        .querySelectorAll('button,input,select')
        .forEach((e) => (e.disabled = true));
    }
  }
  const consoleState = state.consoleState,
    known = state.connected && consoleState && !consoleState.stale;
  const modeLine = $('console-mode-state');
  modeLine.hidden = !known;
  if (known) {
    const mode =
        consoleState.mode === 'docked'
          ? 'TV mode'
          : consoleState.mode === 'handheld'
            ? 'Portable mode'
            : 'Output mode unknown',
      network =
        consoleState.network.type === 'ethernet'
          ? 'Ethernet'
          : consoleState.network.type === 'wifi'
            ? 'Wi-Fi'
            : 'network unknown',
      display = consoleState.display;
    modeLine.textContent =
      mode +
      ' · ' +
      display.width +
      ' × ' +
      display.height +
      ' · ' +
      network +
      (consoleState.network.connected ? '' : ' (disconnected)') +
      (consoleState.warning ? ' · Ethernet is not connected.' : '');
    modeLine.classList.toggle('warning', !!consoleState.warning);
  }
  const modes = config?.devices;
  $('network-summary').textContent = modes
    ? ['server', 'arm', 'lan'].filter(id=>state.checks.items.some(row=>row.id===id))
        .map(
          (id) =>
            (state.checks.items.find(row=>row.id===id)?.label||words[id][0]) +
            ' ' +
            (modes[id].modes || [modes[id].mode]).map(networkName).join(' + '),
        )
        .join('  ·  ')
    : 'Restart Platform to enable connection choices.';
  $('network-help').textContent = config?.locked
    ? 'Connections are locked for this session. Stop it before changing networks.'
    : config?.discovery?.ambiguous
      ? 'Several ARM services found. Choose the required device, or enter its IP.'
      : 'Automatic discovery uses your local network. Manual addresses take priority.';
}

function renderStartupModules() {
  const stamp = JSON.stringify(
    state.library.map((p) => [p.id, p.name, p.version, p.icon, p.supported]),
  );
  if (stamp === startupStamp) return;
  startupStamp = stamp;
  const valid = new Set(state.library.filter(p => p.supported !== false).map(p => p.id));
  for (const id of startupSelection)
    if (!valid.has(id)) startupSelection.delete(id);
  $('preload-list').replaceChildren();
  for (const pkg of state.library) {
    const label = element('label', 'preload-item'),
      input = element('input'),
      image = element('img'),
      text = element('span');
    input.type = 'checkbox';
    input.checked = startupSelection.has(pkg.id);
    input.dataset.unavailable = String(pkg.supported === false);
    input.disabled = pkg.supported === false;
    input.setAttribute('aria-label', 'Load ' + pkg.name + ' at startup');
    input.addEventListener('change', () => {
      input.checked
        ? startupSelection.add(pkg.id)
        : startupSelection.delete(pkg.id);
      saveStartup();
      renderControls();
    });
    image.src = pkg.icon;
    image.alt = '';
    text.append(
      element('strong', '', pkg.name),
      element('small', '', pkg.version),
    );
    label.append(input, image, text);
    $('preload-list').append(label);
  }
}
$('preload-enabled').addEventListener('change', () => {
  saveStartup();
  renderControls();
});
$('preload-clear').addEventListener('click', () => {
  startupSelection.clear();
  document
    .querySelectorAll('#preload-list input')
    .forEach((e) => (e.checked = false));
  saveStartup();
  renderControls();
});
function renderLibrary() {
  const errors = $('module-errors');
  if (errors) {
    errors.hidden = !state.moduleErrors?.length;
    errors.textContent = (state.moduleErrors || []).map(row => (row.id || row.path || 'Module') + ': ' + row.error).join(' · ');
  }
  const available = new Set(state.library.filter(pkg => pkg.supported !== false).map(pkg => pkg.id));
  for (const id of selection) if (!available.has(id)) selection.delete(id);
  const stamp = JSON.stringify(
    state.library.map((p) => [p.id, p.version, p.bytes, p.name, p.icon, p.description, p.supported, p.contents]),
  );
  if (stamp !== packageStamp) {
    packageStamp = stamp;
    $('library').replaceChildren();
    $('module-host-actions').dataset.stamp = '';
    for (const pkg of state.library) {
      const card = element('article', 'app-card'),
        label = element('label', 'app-select'),
        input = element('input'),
        img = element('img');
      card.dataset.appId = pkg.id;
      input.type = 'checkbox';
      input.disabled = pkg.supported === false;
      if (input.disabled) selection.delete(pkg.id);
      input.checked = selection.has(pkg.id);
      input.setAttribute('aria-label', 'Select ' + pkg.name);
      input.addEventListener('change', () => {
        if (input.checked) selection.add(pkg.id);
        else selection.delete(pkg.id);
        renderControls();
      });
      img.src = pkg.icon;
      img.alt = '';
      label.append(
        input,
        img,
        element('strong', '', pkg.name),
        element(
          'small',
          '',
          pkg.version + ' / IZM ' + (pkg.bytes / 1024).toFixed(1) + ' KiB',
        ),
        element('p', '', pkg.description),
      );
      card.append(label, element('div', 'module-host-actions'));
      if (pkg.contents) {
        const details = element('details', 'module-contents');
        details.append(
          element('summary', '', 'Package contents'),
          element(
            'p',
            '',
            'Switch sources: ' +
              (pkg.contents.switchSourceBytes / 1024).toFixed(1) +
              ' KiB · Server sources: ' +
              (pkg.contents.serverSourceBytes / 1024).toFixed(1) +
              ' KiB. Server code stays on this PC.' +
              (pkg.contents.upstreamSourceBytes
                ? ' Upstream sources: ' +
                  (pkg.contents.upstreamSourceBytes / 1048576).toFixed(1) +
                  ' MiB.'
                : '') +
              (pkg.contents.moduleDependencies?.length
                ? ' Required modules: ' +
                  pkg.contents.moduleDependencies.join(', ') +
                  '.'
                : '') +
              (pkg.contents.externalDependencies.length
                ? ' Downloaded separately: ' +
                  pkg.contents.externalDependencies.join(', ') +
                  '.'
                : ''),
          ),
        );
        details.onclick = (e) => e.stopPropagation();
        card.append(details);
      }
      card.append(folderButton('module', pkg.module?.id || pkg.id, 'Open module folder'));
      const unload=element('button','secondary module-unload','Remove from console');
      unload.type='button';unload.title='Unload this module from the console menu. The PC package remains available.';
      unload.onclick=async()=>{if(!window.confirm('Remove '+pkg.name+' from the console menu? You can load it again from this PC.'))return;selection.delete(pkg.id);await act('/api/unload',{ids:[pkg.id]});};
      card.append(unload);
      $('library').append(card);
    }
  }
  const installed = new Set((state.installed || []).map(app => typeof app === 'string' ? app : app.id));
  for (const card of $('library').children) {
    const loaded = installed.has(card.dataset.appId);
    card.classList.toggle('installed', loaded);
    card.dataset.installed = String(loaded);
    card.querySelector('img').title = loaded ? 'Loaded on console' : 'Not loaded on console';
    const unload=card.querySelector('.module-unload'),pending=state.jobs.some(job=>job.packageId===card.dataset.appId&&['queued','loading','publishing'].includes(job.status));
    unload.hidden=!loaded;unload.disabled=busy||state.preview||!state.connected||pending;
    unload.textContent=pending?'Operation queued…':'Remove from console';
  }
  const hostList = $('module-host-actions'),
    hostStamp = JSON.stringify([packageStamp, state.moduleCatalog, state.hostModules, state.moduleStates]);
  if (hostList.dataset.stamp !== hostStamp) {
    const drafts = new Map([...document.querySelectorAll('.module-host-actions .local-source')].map(input => [input.dataset.runtime, input.value]));
    hostList.dataset.stamp = hostStamp;
    for (const target of document.querySelectorAll('.module-host-actions')) target.replaceChildren();
    for (const module of state.moduleCatalog || []) {
      const card = [...$('library').children].find(item => item.dataset.appId === module.id),
        target = card?.querySelector('.module-host-actions') || hostList;
      for (const pkg of module.server?.localPackages || []) {
        const record = state.hostModules?.[pkg.id];
        if (record?.installed) continue;
        const box = element('details', 'local-module module-setup'),
          summary = element('summary', '', 'PC setup'),
          text = element('div'),
          button = element('button', 'secondary', pkg.importSource ? 'Import local runtime' : 'Install on this PC');
        text.append(element('p', 'hint', pkg.importSource
          ? 'Choose the local game folder. Saved games stay in the original installation.'
          : record?.missingFiles?.length ? 'Local runtime files are missing. Reinstall this component.'
          : 'External component is downloaded separately from the IZM package.'));
        button.dataset.unavailable = String(record?.supported === false);
        button.disabled = busy || state.preview || record?.supported === false;
        button.onclick = () => act('/api/install-host', { id: pkg.id });
        if (pkg.importSource) {
          const input = element('input', 'local-source');
          input.type = 'text';
          input.dataset.runtime = pkg.id;
          input.value = drafts.get(pkg.id) || '';
          input.placeholder = 'Absolute runtime folder';
          input.setAttribute('aria-label', module.name + ' runtime folder');
          text.append(input);
          button.disabled ||= !input.value.trim();
          input.oninput = () => { button.disabled = busy || state.preview || record?.supported === false || !input.value.trim(); };
          button.onclick = () => act('/api/install-host', { id: pkg.id, source: input.value.trim() });
        }
        box.append(summary, text, button);
        target.append(box);
      }
      if (module.server && !module.switch) {
        const box = element('div', 'local-module'),
          running = state.moduleStates?.some(item => item.id === module.id),
          button = element('button', 'secondary', running ? 'Stop' : 'Start');
        box.append(element('strong', '', module.name), button);
        button.disabled = busy || state.preview;
        button.onclick = () => act(running ? '/api/module/stop' : '/api/module/start', { id: module.id });
        target.append(box);
      }
    }
  }
  for (const target of document.querySelectorAll('.module-host-actions')) target.hidden = !target.childElementCount;
  $('app-count').textContent = state.library.length;
  const libraryConnection = $('library-connection');
  libraryConnection.classList.toggle('online', !!state.connected);
  const connectionLabel = state.connected ? 'Switch 2 connected' : 'Switch 2 not connected';
  if (libraryConnection.querySelector('span').textContent !== connectionLabel)
    libraryConnection.querySelector('span').textContent = connectionLabel;
  $('library-note').textContent = state.connected
    ? 'Switch 2 connected · ' + selection.size + ' selected'
    : 'Connect Switch 2 and start IZlauncher to load apps.';
  $('jobs').replaceChildren();
  for (const job of state.jobs.slice(-6).reverse()) {
    const row = element('div', 'job ' + job.status);
    row.append(
      element('strong', '', job.name),
      element('span', '', ['complete','ready'].includes(job.status) ? (job.operation==='remove'?'Removed from console':'Loaded') : job.status),
    );
    if (job.error) row.title = job.error;
    $('jobs').append(row);
  }
  const url = state.streamUrl;
  try {
    const u = new URL(url);
    if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') throw Error();
    $('stream-link').href = url;
    $('stream-link').hidden = !state.connected;
  } catch {
    $('stream-link').hidden = true;
  }
}
let historyStamp = '';
function renderHistory() {
  const stamp = JSON.stringify(state.history);
  $('fail-count').textContent = state.history.length;
  if (stamp === historyStamp) return;
  historyStamp = stamp;
  $('attempts').replaceChildren();
  if (!state.history.length) {
    const box = element('div', 'empty');
    box.append(
      element('h2', '', 'No failed attempts'),
      element('p', '', 'Session diagnostics appear here after a failed or cancelled attempt.'),
    );
    $('attempts').append(box);
  }
  for (const attempt of state.history) {
    const row = element('article', 'attempt'),
      body = element('div', 'body');
    body.append(
      element(
        'h3',
        '',
        attempt.kind === 'bootstrap'
          ? 'Bootstrap installation'
          : 'Launcher session',
      ),
      element('time', '', date(attempt.created)),
      element(
        'p',
        '',
        attempt.error ||
          'Input cancelled. Restart the console before trying again.',
      ),
    );
    const view = element('button', '', 'View log'),
      remove = element('button', 'delete', 'Delete log');
    view.addEventListener('click', async () => {
      try {
        const value = await api(
          '/api/log?id=' + encodeURIComponent(attempt.id),
        );
        $('saved-log').textContent =
          value.events.map((e) => date(e.at) + '  ' + e.message).join('\n') ||
          'No further details were recorded.';
        $('log-dialog').showModal();
      } catch (e) {
        notice(e.message);
      }
    });
    remove.addEventListener('click', () =>
      act('/api/delete', { id: attempt.id }),
    );
    row.append(body, view, folderButton('session', attempt.id, 'Open log folder'), remove);
    $('attempts').append(row);
  }
}
function renderActivity() {
  const list = state.log.filter((e) => e.type !== 'detail').slice(-60),
    stamp = JSON.stringify(list),
    log = $('log');
  if (log.dataset.stamp === stamp) return;
  const previous = log.scrollTop;
  logWriting = true;
  log.dataset.stamp = stamp;
  $('log-count').textContent = list.length + ' events';
  log.replaceChildren();
  for (const item of list) {
    const row = element('div', 'log-row ' + item.type);
    row.append(
      element('time', '', new Date(item.at).toLocaleTimeString('en-GB')),
      element('span', '', item.message),
    );
    log.append(row);
  }
  if (!list.length)
    log.append(
      element(
        'p',
        'hint',
        'No active attempt. Device checks do not send console commands.',
      ),
    );
  log.scrollTop = logFollow ? log.scrollHeight : previous;
  requestAnimationFrame(() => {
    log.scrollTop = logFollow ? log.scrollHeight : previous;
    logWriting = false;
  });
}

function render() {
  renderPlatform();
  const ended = state.lastAttempt;
  if (ended && ended.id !== finishedAttempt) {
    finishedAttempt = ended.id;
    requestId = null;
    $('screen-ready').checked = false;
  }
  renderDevices();
  renderStartupModules();
  renderLibrary();
  renderHistory();
  renderActivity();
  renderWizard();
  $('mode').textContent = state.simulated
    ? 'SIMULATED DEVICES'
    : state.preview
      ? 'DESIGN PREVIEW'
      : state.connected
        ? 'CONSOLE CONNECTED'
        : 'LOCAL CONTROL';
  $('mode').classList.toggle('preview', state.preview);
  $('connection').classList.toggle('online', state.connected);
  $('connection').lastChild.textContent =
    state.link?.state === 'waiting-for-dock'
      ? 'Reconnecting…'
      : state.connected
        ? 'Console connected'
        : state.active?.kind === 'bootstrap'
          ? 'Setup in progress'
          : state.active
            ? 'Connecting…'
            : 'Not connected';
  const attempt = state.active || state.lastAttempt;
  $('progress-box').hidden = !attempt;
  $('progress-title').textContent = attempt
    ? {
        starting: 'Preparing launcher',
        typing: 'Entering bootstrap.bas',
        running: 'Launcher is running',
        stopping: 'Stopping safely…',
        complete: 'Setup complete',
        review: 'Source entered · awaiting your review',
        checking: 'Reading the source check',
        saving: 'Sending the save command',
        awaiting_restart: 'Waiting for a full console restart',
        failed: 'Attempt failed',
        cancelled: 'Input cancelled',
        stopped: 'Session stopped',
      }[attempt.status] || attempt.status
    : '';
  if (attempt?.progress) {
    $('progress').value = attempt.progress.line;
    $('progress').max = attempt.progress.total;
    $('progress-value').textContent =
      attempt.progress.line + ' / ' + attempt.progress.total + ' lines';
  } else {
    if (['complete', 'running'].includes(attempt?.status))
      $('progress').value = 229;
    else $('progress').removeAttribute('value');
    $('progress-value').textContent = '';
  }
  $('progress-note').textContent =
    attempt?.kind === 'bootstrap'
      ? 'Source entry uses the original HID timings. Console execution and save results require your confirmation.'
      : state.connected
        ? 'You can close this window. Your console session will keep running.'
        : attempt?.status === 'failed'
          ? 'Restart the console before your next attempt.'
          : state.platform?.delivery?.preloaded
            ? 'RUN → prepare memory once → connect'
            : 'LOAD “TXT:' +
              (state.platform?.delivery?.bootstrapName ||
                (state.bootstrapProfile?.recovery ? 'NS2R' : 'NS2')) +
              '” → RUN → prepare memory once → connect';
  if (state.notification) {
    backendNotice = state.notification.at || state.notification.message;
    notice(state.notification.message, state.notification.type, backendNotice);
  } else if (backendNotice) {
    if (notificationKey === backendNotice) $('toast').hidden = true;
    backendNotice = '';
  }
}
let platformMenuStamp = '',
  configurationStamp = '',
  loaderFieldsStamp = '';
const upstreamSteps = { izmysh: 'launch' };
function fieldsFor(schema) {
  if (Array.isArray(schema)) return schema;
  if (schema?.fields) return schema.fields;
  return Object.entries(schema?.properties || schema || {}).map(([id, v]) => ({
    id,
    ...v,
  }));
}
function buildFields(container, schema, values) {
  container.replaceChildren();
  for (const field of fieldsFor(schema)) {
    const id = field.id || field.key || field.name;
    if (!id) continue;
    const label = element('label', 'configuration-field'),
      input = field.options ? element('select') : element('input');
    input.name = id;
    input.dataset.kind = field.type || 'string';
    if (field.options)
      for (const value of field.options) {
        const o = element(
          'option',
          '',
          typeof value === 'object' ? value.label : value,
        );
        o.value = typeof value === 'object' ? value.value : value;
        input.append(o);
      }
    else
      input.type = ['boolean', 'checkbox'].includes(field.type)
        ? 'checkbox'
        : field.type === 'number'
          ? 'number'
          : 'text';
    input.autocomplete = 'off';
    const value = values?.[id] ?? field.default ?? '';
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value;
    label.append(element('span', '', field.label || field.title || id), input);
    if (field.description || field.help)
      label.append(element('small', 'hint', field.description || field.help));
    container.append(label);
  }
}
function fieldValues(container) {
  const value = {};
  for (const input of container.querySelectorAll('input,select'))
    value[input.name] =
      input.type === 'checkbox'
        ? input.checked
        : input.dataset.kind === 'number'
          ? Number(input.value)
          : input.value.trim();
  return value;
}
function upstreamPanel(id) {
  return document.querySelector('[data-upstream-panel="' + id + '"]');
}
function renderPlatform() {
  const meta = state?.platform;
  if (!meta) return;
  const locked = busy || meta.locked,
    selected = meta.loaderId;
  const inventoryStamp = JSON.stringify(
    meta.loaders.map((l) => [l.id, l.name]),
  );
  const tabs = document.querySelector('.loader-tabs');
  tabs.hidden = meta.loaders.length < 2;
  tabs.style.setProperty('--engine-count', meta.loaders.length);
  if (tabs.dataset.inventory !== inventoryStamp) {
    tabs.dataset.inventory = inventoryStamp;
    tabs.replaceChildren();
    meta.loaders.forEach((loader, i) => {
      const b = element('button');
      b.type = 'button';
      b.dataset.loader = loader.id;
      b.setAttribute('role', 'tab');
      b.append(
        element('span', '', String(i + 1).padStart(2, '0')),
        element('strong', '', loader.name),
      );
      b.onclick = () => act('/api/launch-settings', { loaderId: loader.id });
      tabs.append(b);
    });
  }
  let hardwareSearch=$('hardware-search');if(!hardwareSearch){hardwareSearch=element('input');hardwareSearch.id='hardware-search';hardwareSearch.type='search';hardwareSearch.placeholder='Find a configuration…';hardwareSearch.setAttribute('aria-label','Search hardware configurations');$('launch-configuration').before(hardwareSearch);hardwareSearch.oninput=()=>{for(const option of $('launch-configuration').options)option.hidden=!option.textContent.toLowerCase().includes(hardwareSearch.value.toLowerCase());};}
  hardwareSearch.hidden = meta.configurations.length < 7;
  hardwareSearch.disabled = locked;
  const profileSelect = $('launch-configuration'),
    profileStamp = JSON.stringify(
      meta.configurations.map((p) => [p.id, p.name, p.selectable, p.unavailableReason]),
    );
  if (profileSelect.dataset.inventory !== profileStamp) {
    profileSelect.dataset.inventory = profileStamp;
    profileSelect.replaceChildren();
    for (const p of meta.configurations) {
      const o = element('option', '', p.name);
      o.value = p.id;
      o.disabled = p.selectable === false;
      o.title = p.unavailableReason || '';
      profileSelect.append(o);
    }
  }
  const shellSelect = $('launch-runtime'),
    shellStamp = JSON.stringify((meta.shells || []).map((p) => [p.id, p.name]));
  if (shellSelect.dataset.inventory !== shellStamp) {
    shellSelect.dataset.inventory = shellStamp;
    shellSelect.replaceChildren();
    for (const v of [
      ...(meta.shells || []),
      { id: 'original', name: 'Original' },
    ]) {
      const b = element('button', '', v.name);
      b.type = 'button';
      b.dataset.variant = v.id;
      b.onclick = () => act('/api/launch-settings', { variant: v.id });
      shellSelect.append(b);
    }
  }
  document.querySelector('[data-step=bootstrap]').hidden =
    meta.loaders.find((l) => l.id === selected)?.menu?.sourceSetup === false;
  document.querySelector('[data-view=apps]').disabled = !meta.izModules;
  document.querySelector('[data-view=apps]').title = meta.izModules
    ? ''
    : 'IZM modules are available in IZlauncher mode';
  if (!meta.izModules && !$('apps').hidden) switchView('setup');
  $('iz-flow').hidden = !meta.izModules;
  const label = meta.loaders.find((l) => l.id === selected)?.name || selected;
  const errors = $('extension-errors');
  if (errors) {
    errors.hidden = !meta.extensionErrors?.length;
    errors.textContent = (meta.extensionErrors || [])
      .map((e) => e.id + ': ' + e.error)
      .join(' · ');
  }
  $('delivery-summary').textContent = label;
  document.querySelector('[data-variant=original]').textContent = 'Original';
  const deliverySchema = (
    meta.loaders.find((l) => l.id === selected)?.settingsSchema || []
  ).filter(
    (f) =>
      (!f.runtimes || f.runtimes.includes('izlauncher')) &&
      f.key !== 'holdRpc' &&
      f.key !== 'mode' &&
      f.key !== 'basicArity',
  );
  const deliveryStamp = JSON.stringify([
    selected,
    deliverySchema,
    meta.loaderSettings,
  ]);
  if (
    $('delivery-options').dataset.stamp !== deliveryStamp &&
    !$('delivery-options').contains(document.activeElement)
  ) {
    buildFields($('delivery-fields'), deliverySchema, meta.loaderSettings);
    $('delivery-options').dataset.stamp = deliveryStamp;
  }
  $('delivery-options').hidden = !meta.izModules || !deliverySchema.length;
  $('delivery-options')
    .querySelectorAll('input,select,button')
    .forEach((e) => (e.disabled = locked));
  $('launch-runtime').hidden = false;
  document.querySelectorAll('[data-loader]').forEach((button) => {
    button.classList.toggle('selected', button.dataset.loader === selected);
    button.setAttribute(
      'aria-selected',
      String(button.dataset.loader === selected),
    );
    const available =
      meta.loaders.find((l) => l.id === button.dataset.loader)?.supported !==
        false &&
      (
        meta.loaders.find((l) => l.id === button.dataset.loader)
          ?.availableIn || ['izlauncher', 'original']
      ).includes(meta.variant);
    button.disabled = locked || !available;
    button.classList.toggle('unavailable', !available);
    button.setAttribute('aria-disabled', String(locked || !available));
    button.title = available ? '' : 'Available in Original mode';
  });
  document.querySelectorAll('[data-variant]').forEach((button) => {
    button.classList.toggle(
      'selected',
      button.dataset.variant === meta.variant,
    );
    button.disabled = locked;
  });
  $('launch-configuration').value = meta.configurationId;
  $('launch-configuration').disabled = locked;
  const configuration = meta.configurations.find(
      (c) => c.id === meta.configurationId,
    ),
    stamp = JSON.stringify([
      meta.configurationId,
      configuration?.settingsSchema,
      configuration?.fields,
      meta.profiles?.[meta.configurationId],
    ]);
  if (
    stamp !== configurationStamp &&
    !$('hardware-form').contains(document.activeElement)
  ) {
    configurationStamp = stamp;
    buildFields(
      $('hardware-fields'),
      configuration?.settingsSchema || configuration?.fields || [],
      meta.profiles?.[meta.configurationId] || {},
    );
  }
  $('hardware-form')
    .querySelectorAll('input,select,button')
    .forEach((e) => (e.disabled = locked));
  const hw=meta.configuration.hardware;
  if(hw){let summary=$('hardware-topology');if(!summary){summary=element('p','hint');summary.id='hardware-topology';$('configuration-note').after(summary);}summary.textContent=hw.deviceCount+' devices · '+(hw.combined?'Server + input: '+hw.server.name:'Server: '+hw.server.name+' → Input: '+hw.input.name)+' → Console: '+hw.console.name;}
  renderArmSetup(meta);
  const needs = meta.configuration.setupRequired;
  $('configuration-note').textContent =
    (needs ? 'Setup required. ' : '') +
    (Array.isArray(meta.configuration.requirements)
      ? meta.configuration.requirements
          .map((x) => (typeof x === 'string' ? x : x.message || x.label || ''))
          .filter(Boolean)
          .join(' · ')
      : meta.configuration.requirements || '');
  const menuStamp = JSON.stringify(
    meta.loaders.map((l) => [l.id, l.menu, l.settingsSchema]),
  );
  if (menuStamp !== platformMenuStamp) {
    platformMenuStamp = menuStamp;
    $('upstream-menus').replaceChildren();
    for (const loader of meta.loaders) {
      const id = loader.id;
      upstreamSteps[id] ??= 'launch';
      const panel = element('section', 'installation upstream-menu');
      panel.dataset.upstreamPanel = id;
      const heading = element('div', 'section-heading'),
        title = element('div'),
        tabs = element('div', 'segmented');
      title.append(
        element('span', 'eyebrow', 'LOADER / ' + id.toUpperCase()),
        element('h2', '', loader.menu?.title || loader.name || id),
      );
      for (const value of loader.menu?.sourceSetup === false
        ? ['launch']
        : ['bootstrap', 'launch']) {
        const button = element(
          'button',
          '',
          value === 'launch' ? 'Launch' : 'First setup',
        );
        button.type = 'button';
        button.dataset.upstreamStep = value;
        button.onclick = () => {
          upstreamSteps[id] = value;
          panel.querySelector('.up-ready').checked = false;
          renderPlatformControls();
        };
        tabs.append(button);
      }
      heading.append(title, tabs);
      panel.append(
        heading,
        element(
          'p',
          'subtitle',
          loader.menu?.description ||
            loader.menu?.subtitle ||
            loader.description ||
            '',
        ),
      );
      const fields = element('form', 'configuration-form loader-settings'),
        fieldBox = element('div'),
        save = element('button', 'secondary', 'Save loader settings');
      fieldBox.className = 'loader-fields';
      save.type = 'submit';
      fields.append(fieldBox, save);
      fields.oninput = () => {
        panel.querySelector('.up-ready').checked = false;
        renderPlatformControls();
      };
      fields.onsubmit = (e) => {
        e.preventDefault();
        act('/api/launch-settings', { loaderSettings: fieldValues(fieldBox) });
      };
      panel.append(fields);
      const note = element('p', 'subtitle up-description'),
        source = element('button', 'quiet up-source', 'Download source .bas');
      source.type = 'button';
      source.onclick = async () => {
        try {
          const response = await fetch(
            '/api/loader-source?id=' + encodeURIComponent(id),
            {
              headers: { 'x-iz-key': key },
            },
          );
          if (!response.ok) throw Error((await response.json()).error);
          const url = URL.createObjectURL(await response.blob()),
            link = element('a');
          link.href = url;
          link.download = id + '-bootstrap.bas';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (e) {
          notice(e.message);
        }
      };
      const ack = element('label', 'ack'),
        ready = element('input'),
        readyText = element(
          'span',
          '',
          'Switch is fully restarted and SmileBASIC Direct is open.',
        );
      ready.type = 'checkbox';
      ready.className = 'up-ready';
      readyText.className = 'up-ready-label';
      ready.onchange = renderPlatformControls;
      ack.append(ready, readyText);
      const actions = element('div', 'launch-row'),
        start = element('button', 'primary up-start', 'Launch'),
        saveSource = element('button', 'secondary up-save', 'Save source'),
        confirm = element(
          'button',
          'secondary up-confirm',
          'Source saved · continue',
        ),
        stop = element('button', 'soft-stop up-stop', 'Disconnect safely'),
        hard = element('button', 'hard-stop up-hard', '! STOP'),
        status = element('span', 'hint up-status');
      start.onclick = () =>
        act('/api/start', {
          kind: upstreamSteps[id] || 'launch',
          requestId: crypto.randomUUID(),
          screenReady: ready.checked,
          sourceReady: panel.querySelector('.up-source-ready').checked,
          moduleIds: [],
        });
      saveSource.onclick = () =>
        act('/api/setup', { action: 'save', requestId: crypto.randomUUID() });
      confirm.onclick = () =>
        act('/api/setup', {
          action: 'saved',
          requestId: crypto.randomUUID(),
          savedConfirmed: true,
        });
      stop.onclick = () => act('/api/stop', {});
      hard.onclick = async () => {
        if (hardStopping) return;
        hardStopping = true;
        try {
          await api('/api/hard-stop', {});
          await poll();
        } catch (e) {
          notice(e.message);
        } finally {
          hardStopping = false;
          renderPlatformControls();
        }
      };
      actions.append(start, saveSource, confirm, stop, hard, status);
      const sourceAck = element('label', 'ack source-preparation'),
        sourceReady = element('input'),
        sourceText = element('span');
      sourceReady.type = 'checkbox';
      sourceReady.className = 'up-source-ready';
      sourceReady.onchange = renderPlatformControls;
      sourceText.className = 'up-source-label';
      sourceAck.append(sourceReady, sourceText);
      panel.append(note, source, sourceAck, ack, actions);
      $('upstream-menus').append(panel);
    }
  }
  for (const loader of meta.loaders) {
    const panel = upstreamPanel(loader.id);
    if (!panel) continue;
    panel.hidden = meta.izModules || loader.id !== selected;
    const fieldBox = panel.querySelector('.loader-fields'),
      fieldsStamp = JSON.stringify([
        loader.id,
        loader.settingsSchema,
        selected === loader.id ? meta.loaderSettings : {},
      ]);
    if (
      panel.dataset.fieldsStamp !== fieldsStamp &&
      !panel.querySelector('.loader-settings').contains(document.activeElement)
    ) {
      panel.dataset.fieldsStamp = fieldsStamp;
      buildFields(
        fieldBox,
        (loader.settingsSchema || []).filter(f => !f.runtimes || f.runtimes.includes('original')),
        selected === loader.id ? meta.loaderSettings : {},
      );
    }
    panel.querySelector('.loader-settings').hidden = !fieldBox.children.length;
  }
  const inputName =
    meta.configurationId === 'arm-only'
      ? 'ARM PC · local input'
      : meta.configurationId === 'pc-cardputer-adv'
        ? 'Cardputer ADV'
        : 'ARM PC';
  words.arm[0] = inputName;
  words.usb[0] = inputName === 'ARM PC' ? 'ARM Type C - Switch' : 'USB · ' + inputName + ' → Switch';
  for (const row of state.checks.items) {
    const card = $('device-' + row.id);
    if (card && words[row.id])
      card.querySelector('h3').textContent = row.label || words[row.id][0];
  }
  renderPlatformControls();
  renderEngineInstall();
}
function renderInstallationSlot() {
  if(state?.platform?.configuration?.externalWorkflow){$('installation-options').hidden=true;return;}
  const meta = state?.platform,
    installation = meta?.installation;
  const firstSetup = meta?.izModules
    ? step === 'bootstrap'
    : upstreamSteps[meta?.loaderId] === 'bootstrap';
  $('installation-options').hidden = !installation || !firstSetup;
  if (!installation) return;
  $('install-slot').value = String(installation.slot);
  $('install-slot').disabled = busy || !!meta.locked;
  $('install-slot-commands').textContent =
    installation.list + ' → source entry → ' + installation.save;
  $('install-slot-warning').querySelector('span').textContent = 'Installation can overwrite code in slot ' + installation.slot + ' and the saved file TXT:' + installation.name + '. Back up anything you need first.';
}
function renderEngineInstall() {
  const meta = state?.platform;
  if (!meta) return;
  if(meta.configuration.externalWorkflow){$('engine-install').hidden=true;return;}
  const missing = meta.engineInstalled === false;
  $('engine-install').hidden = !missing;
  const selectedEngine = meta.loaders.find((e) => e.id === meta.loaderId);
  $('engine-source').href = selectedEngine?.upstream?.repository || '#';
  $('engine-install-note').textContent =
    'Download the engine source from its published repository, or add it manually. The engine runs only when you launch a session.';
  $('engine-install-folder').textContent =
    'Manual installation: copy the complete repository into engines/' +
    meta.loaderId + '/upstream/, then choose Check manual folder.';
  $('engine-install-folder').title = meta.engineInstallation?.folder || '';
  $('engine-download').disabled = busy || meta.locked || state.preview;
  $('engine-rescan').disabled = busy || meta.locked;
  if (missing) {
    $('iz-flow').hidden = true;
    $('installation-options').hidden = true;
    for (const p of document.querySelectorAll('[data-upstream-panel]'))
      p.hidden = true;
  }
}
function renderPlatformControls() {
  renderInstallationSlot();
  const meta = state?.platform;
  if (!meta) return;
  for (const panel of document.querySelectorAll('[data-upstream-panel]')) {
    const id = panel.dataset.upstreamPanel,
      phase = upstreamSteps[id] || 'launch',
      preparation = state.sourcePreparation,
      active = state.active,
      locked = busy || meta.locked,
      stage = active?.setup?.stage;
    const fields = panel.querySelector('.loader-fields'),
      draft = fieldValues(fields),
      dirty = id === meta.loaderId && fieldsDirty(fields, meta.loaderSettings),
      preloaded = draft.bootstrapMode === 'loaded';
    const sourceRequired =
      phase === 'launch' && !preloaded && !preparation?.ready;
    panel.querySelectorAll('[data-upstream-step]').forEach((button) => {
      button.classList.toggle(
        'selected',
        button.dataset.upstreamStep === phase,
      );
      button.disabled = locked;
    });
    panel
      .querySelectorAll(
        '.loader-settings input,.loader-settings select,.loader-settings button',
      )
      .forEach((e) => (e.disabled = locked));
    panel.querySelector('.source-preparation').hidden = !sourceRequired;
    panel.querySelector('.up-source-label').textContent =
      'I confirm: the selected bootstrap has been saved as ' +
      (draft.bootstrapName || preparation?.name || 'NS2') +
      '.';
    panel.querySelector('.up-source-ready').disabled = locked;
    panel.querySelector('.up-source').hidden = !preparation?.name;
    panel.querySelector('.up-ready-label').textContent =
      phase === 'bootstrap'
        ? 'Fresh SmileBASIC Direct is open; slot ' +
          (preparation?.sourceSlot ?? 0) +
          ' is empty; English (US) keyboard, Caps Lock off.'
        : preloaded
          ? 'After a full restart, the bootstrap is loaded in slot 0 and Direct is open; RUN and REMOVE have not been executed.'
          : 'After a full restart, SmileBASIC Direct is open; RUN and REMOVE have not been executed.';
    panel.querySelector('.up-description').textContent =
      phase === 'launch'
        ? preloaded
          ? 'Source is already in slot 0. The engine will provide the connection commands.'
          : 'The panel will load the saved file ' +
            (draft.bootstrapName || preparation?.name || 'bootstrap') +
            ' with LOAD confirmation, then enter RUN → REMOVE → START.'
        : 'Source will be entered into empty slot ' +
          (preparation?.sourceSlot ?? 0) +
          '. Save it separately as ' +
          (preparation?.name || 'NS2') +
          ', then restart Switch. Other slots remain unchanged.';
    const start = panel.querySelector('.up-start');
    start.textContent =
      phase === 'launch' ? 'Launch' : 'Enter source';
    start.hidden = !!active;
    start.disabled =
      busy ||
      dirty ||
      !!state.preview ||
      !state.checks.ready ||
      !panel.querySelector('.up-ready').checked ||
      (sourceRequired && !panel.querySelector('.up-source-ready').checked) ||
      !!state.emergencyInputPending;
    panel.querySelector('.up-ready').disabled = locked;
    panel.querySelector('.up-save').hidden = stage !== 'review';
    panel.querySelector('.up-save').disabled = busy;
    panel.querySelector('.up-confirm').hidden = stage !== 'save_confirmation';
    panel.querySelector('.up-confirm').disabled = busy;
    panel.querySelector('.up-stop').hidden = !active;
    panel.querySelector('.up-stop').disabled =
      busy || active?.status === 'stopping';
    panel.querySelector('.up-hard').hidden =
      !active && !state.emergencyInputPending;
    panel.querySelector('.up-hard').disabled = hardStopping;
    panel.querySelector('.up-status').textContent = active
      ? active.inputActive
        ? 'Entering commands…'
        : stage === 'review'
          ? 'Review the source on Switch, then save.'
          : stage === 'save_confirmation'
            ? 'Confirm saving on Switch before continuing.'
            : active.status
      : state.emergencyInputPending
        ? 'Input cancellation needs confirmation.'
        : dirty
          ? 'Save the loader settings before connecting.'
          : state.checks.ready
            ? 'Ready to launch.'
            : 'Configure the connections to continue.';
  }
}
document
  .querySelectorAll('[data-loader]')
  .forEach(
    (button) =>
      (button.onclick = () =>
        act('/api/launch-settings', { loaderId: button.dataset.loader })),
  );
document
  .querySelectorAll('[data-variant]')
  .forEach(
    (button) =>
      (button.onclick = () =>
        act('/api/launch-settings', { variant: button.dataset.variant })),
  );
$('launch-configuration').onchange = (e) =>
  act('/api/launch-settings', { configurationId: e.target.value });
$('hardware-form').onsubmit = (e) => {
  e.preventDefault();
  act('/api/launch-settings', {
    configurationId: state.platform.configurationId,
    profile: fieldValues($('hardware-fields')),
  });
};

async function poll() {
  try {
    state = await api('/api/state');
    render();
  } catch (e) {
    $('connection').lastChild.textContent = 'Server unavailable';
    $('connection').classList.remove('online');
    $('start').disabled = true;
    $('load').disabled = true;
    notice(
      'The local server is unavailable. Reopen Platform to reconnect this window.',
    );
  }
}
document
  .querySelectorAll('[data-view]')
  .forEach((e) =>
    e.addEventListener('click', () => switchView(e.dataset.view)),
  );
document
  .querySelectorAll('[data-step]')
  .forEach((e) =>
    e.addEventListener('click', () => chooseStep(e.dataset.step)),
  );
$('recovery-enabled').addEventListener('change', () => {
  requestId = null;
  renderWizard();
});
$('screen-ready').addEventListener('change', renderControls);
$('recheck').addEventListener('click', () => act('/api/check', {}));
$('start').addEventListener('click', () => {
  requestId ||= crypto.randomUUID();
  act('/api/start', {
    kind: state?.active?.setup?.stage === 'reboot' ? 'launch' : step,
    screenReady: $('screen-ready').checked,
    requestId,
    recovery: $('recovery-enabled').checked,
    moduleIds: $('preload-enabled').checked ? [...startupSelection] : [],
  });
});
$('stop').addEventListener('click', () => act('/api/stop', {}));
$('load').addEventListener('click', () =>
  act('/api/load', { ids: [...selection] }),
);
$('about').addEventListener('click', () => $('about-dialog').showModal());
document
  .querySelectorAll('[data-close]')
  .forEach((e) =>
    e.addEventListener('click', () => $(e.dataset.close).close()),
  );
document.querySelectorAll('dialog').forEach((e) =>
  e.addEventListener('click', (event) => {
    if (event.target === e) {
      const r = e.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        e.close();
    }
  }),
);
$('dismiss').addEventListener('click', () => {
  dismissed = notificationKey;
  $('toast').hidden = true;
  api('/api/dismiss', {}).catch(() => {});
});
document.querySelector('.brand').addEventListener('click', (e) => {
  e.preventDefault();
  switchView('setup');
});
chooseStep('launch');
poll().finally(() => (timer = setInterval(poll, 2000)));
// No unload/visibility handler: closing or hiding Chrome never ends the session.

async function setupAction(action, extra = {}) {
  if (!pendingSetup || pendingSetup.action !== action)
    pendingSetup = { action, requestId: crypto.randomUUID() };
  const result = await act('/api/setup', { ...pendingSetup, ...extra });
  if (result) pendingSetup = null;
  return result;
}
async function retrySetup() {
  const result = await act('/api/retry', {});
  if (result?.ok) {
    requestId = null;
    pendingSetup = null;
    setupStamp = '';
    resultStamp = '';
    $('toast').hidden = true;
    dismissed = notificationKey;
    backendNotice = '';
    $('screen-ready').checked = false;
    $('review-ready').checked = false;
    $('check-lines').checked = false;
    $('saved-ready').checked = false;
    for (let i = 0; i < 6; i++) $('metric-' + i).value = '';
    chooseStep('bootstrap');
  }
}
$('verify-source').addEventListener('click', () =>
  setupAction('verify', { reviewed: $('review-ready').checked }),
);
$('skip-source').addEventListener('click', () =>
  setupAction('skip', { reviewed: $('review-ready').checked }),
);
$('reverify-source').addEventListener('click', () =>
  setupAction('verify', { reviewed: true }),
);
$('compare-source').addEventListener('click', () =>
  setupAction('compare', {
    values: Array.from({ length: 6 }, (_, i) => $('metric-' + i).value),
    linesConfirmed: $('check-lines').checked,
  }),
);
$('edit-readings').addEventListener('click', () => setupAction('edit-values'));
$('save-source').addEventListener('click', () => setupAction('save'));
$('confirm-saved').addEventListener('click', () =>
  setupAction('saved', { savedConfirmed: $('saved-ready').checked }),
);
$('retry').addEventListener('click', retrySetup);
$('restart-setup').addEventListener('click', retrySetup);
for (const id of [
  'review-ready',
  'check-lines',
  'saved-ready',
  ...Array.from({ length: 6 }, (_, i) => 'metric-' + i),
])
  $(id).addEventListener('input', renderControls);
$('export-source').addEventListener('click', async () => {
  try {
    const row = state.active || state.lastAttempt,
      data = await api('/api/setup-report?id=' + encodeURIComponent(row.id)),
      url = URL.createObjectURL(
        new Blob([data.text], { type: 'text/plain;charset=utf-8' }),
      ),
      a = element('a');
    a.href = url;
    a.download = 'IZlauncher-source-check-' + row.id + '.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    notice(e.message);
  }
});
$('log').addEventListener('scroll', () => {
  if (!logWriting && $('log').clientHeight)
    logFollow =
      $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight < 40;
});
document.querySelector('.activity').addEventListener('toggle', (event) => {
  if (event.target.open && logFollow)
    $('log').scrollTop = $('log').scrollHeight;
});

$('hard-stop').addEventListener('click', async () => {
  if (hardStopping) return;
  hardStopping = true;
  renderControls();
  try {
    await api('/api/hard-stop', {});
    await poll();
  } catch (e) {
    notice(e.message, 'error');
  } finally {
    hardStopping = false;
    renderControls();
  }
});


$('delivery-options').oninput = () => {
  $('screen-ready').checked = false;
  renderControls();
};
$('delivery-options').onsubmit = (e) => {
  e.preventDefault();
  act('/api/launch-settings', {
    loaderSettings: {
      ...state.platform.loaderSettings,
      ...fieldValues($('delivery-fields')),
    },
  });
};

$('install-slot').onchange = () => {
  $('screen-ready').checked = false;
  document.querySelectorAll('.up-ready').forEach((e) => (e.checked = false));
  act('/api/launch-settings', { installSlot: Number($('install-slot').value) });
};

$('engine-download').onclick = () =>
  act('/api/engine/install', { id: state.platform.loaderId });
$('engine-rescan').onclick = () => act('/api/engine/rescan', {});

for(const id of ['arm-setup-address','arm-setup-user','arm-setup-key']) $(id).oninput=()=>{$(id).dataset.edited='true';};
$('arm-install-confirm').onchange=()=>{if(state?.platform)renderArmSetup(state.platform);};
for(const mode of ['ssh','manual']) $('arm-method-'+mode).onclick=()=>{for(const item of ['ssh','manual']){$('arm-method-'+item).classList.toggle('selected',mode===item);$('arm-'+item+'-pane').hidden=mode!==item;}};
$('arm-install-form').onsubmit=async(event)=>{
  event.preventDefault();
  $('arm-install-result').textContent='Installing the verified package over SSH…';
  const result=await act('/api/input/install',{address:$('arm-setup-address').value.trim(),user:$('arm-setup-user').value.trim(),identity:$('arm-setup-key').value.trim(),confirm:$('arm-install-confirm').checked});
  if(result?.ok){$('arm-install-result').textContent=result.keyboard?'Installed. Check the console USB connection before launch.':'Installed. Connect/configure the board’s USB keyboard gadget, then check again.';for(const id of ['arm-setup-address','arm-setup-user','arm-setup-key'])delete $(id).dataset.edited;}else $('arm-install-result').textContent='Installation was not confirmed. Check the error above, or use the manual package.';
};
$('arm-check').onclick=()=>act('/api/check');
$('arm-package-download').onclick=async()=>{try{const response=await fetch('/api/input-package',{headers:{'x-iz-key':key}});if(!response.ok)throw Error((await response.json()).error);const url=URL.createObjectURL(await response.blob()),link=element('a');link.href=url;link.download='iz2s-arm-input.tar.gz';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){notice(error.message);}};


for (const placeholder of document.querySelectorAll('[data-folder]')) {
  const button = folderButton(placeholder.dataset.folder, null, placeholder.textContent.trim());
  button.id = placeholder.id;
  button.className += ' ' + placeholder.className;
  button.onclick = async event => {
    event.preventDefault();
    event.stopPropagation();
    const kind = placeholder.dataset.folder;
    const id = kind === 'configuration' ? state?.platform?.configurationId
      : ['engine', 'engine-source'].includes(kind) ? state?.platform?.loaderId : undefined;
    button.disabled = true;
    try { await api('/api/folder/open', { kind, ...(id ? { id } : {}) }); }
    catch (error) { notice(error.message); }
    finally { button.disabled = !!state?.preview; }
  };
  placeholder.replaceWith(button);
}
