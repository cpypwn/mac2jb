const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  { spawn } = require('node:child_process');
const defaultSourceChecks = require('./source-check.cjs');
const bootstrapProfile = (root) =>
  readJson(path.join(root, 'data/state/bootstrap-profile.json'), {
    recovery: false,
  });
const { createLedger, readJson, saveJson, redact } = require('./ledger.cjs');
function createSessionManager({
  root,
  settings,
  node,
  arm,
  devices,
  connections,
  launch = spawn,
  preview = false,
  launchEnvironment = {},
  prepareLaunch,
  sourceChecks = defaultSourceChecks,
  readBootstrapProfile,
  bootstrapProfileFile = path.join(root, 'data/state/bootstrap-profile.json'),
  bootstrapName = () => 'NS2I',
  loaderId = 'izmysh',
  recoveryAvailable = false,
  graceMs = 5000,
  prepareModules = require('./preload.cjs').prepare,
  killGroup = (pid) => process.kill(-pid, 'SIGKILL'),
}) {
  const sourceCheck = sourceChecks,
    bootstrapProfile =
      readBootstrapProfile ||
      (() => readJson(bootstrapProfileFile, { recovery: false }));
  const journal = createLedger(root);
  let current = null,
    lastAttempt = null,
    probe = {
      ready: false,
      items: ['server', 'arm', 'usb', 'lan'].map((id) => ({
        id,
        ready: false,
        detail: preview ? 'Preview · no device commands' : 'Checking…',
      })),
    },
    checking = null,
    lastCheck = 0,
    notification = null,
    child = null,
    inputTask = null,
    pendingWrites = Promise.resolve(),
    failing = null,
    beginBusy = false,
    emergencyInputPending = false,
    inputRecovery = null,
    inputCancellation = null,
    epoch = 0;
  const recoveryFile = path.join(root, 'data/state/input-recovery.json');
  const recoveryReady = readJson(recoveryFile).then((row) => {
    if (row) {
      inputRecovery = row;
      emergencyInputPending = true;
      notification = {
        type: 'error',
        message:
          'Input cancellation still needs confirmation. Check the ARM PC connection and press red STOP to retry.',
      };
    }
  });
  const record = (type, text, extra = {}) => {
    if (!current) return Promise.resolve();
    const id = current.id;
    pendingWrites = pendingWrites
      .then(() => journal.append(id, type, text, extra))
      .catch(() => {});
    return pendingWrites;
  };
  async function persist() {
    if (current) await journal.write(current);
  }
  async function refresh(force = false) {
    if (preview) return probe;
    if (current) return probe;
    if (
      current?.status === 'running' ||
      current?.status === 'starting' ||
      current?.status === 'typing'
    )
      return probe;
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 4500) return probe;
    checking = (async () => {
      try {
        probe = await devices.inspect();
        lastCheck = Date.now();
        return probe;
      } finally {
        checking = null;
      }
    })();
    return checking;
  }
  function failure(error) {
    if (!current) return Promise.resolve();
    if (failing) return failing;
    const row = current,
      wasInput = ['starting', 'typing', 'checking', 'saving'].includes(
        row.status,
      );
    row.status = 'failed';
    failing = (async () => {
      const run =
        row.runDirectory &&
        (await readJson(
          path.join(row.runDirectory, 'bridge-first-failure.json'),
        ));
      row.error = redact(run?.error || error.message);
      row.completed = new Date().toISOString();
      row.needsRestart = true;
      // Stop a pending remote input job before exposing a retry. A late enqueue
      // with the same identifier is also blocked by the remote cancellation tombstone.
      if (wasInput)
        await arm
          .halt(row.inputJob || row.id)
          .catch((e) =>
            record(
              'detail',
              'Input cancellation could not be confirmed: ' + e.message,
            ),
          );
      if (current !== row || row.forcedStop) return;
      notification = {
        type: 'error',
        message: row.error + '. Restart the console before another attempt.',
        at: row.completed,
      };
      await record('error', notification.message);
      await journal.write(row);
      lastAttempt = row;
      if (current?.id === row.id) current = null;
      lastCheck = 0;
    })().finally(() => (failing = null));
    return failing;
  }
  async function bootstrap(row) {
    if (current?.id !== row.id || current.status === 'stopping') return;
    row.status = 'typing';
    row.inputJob = row.id;
    row.inputActive = true;
    await persist();
    await record(
      'input',
      'Opening EDIT' +
        (row.setup.sourceSlot ?? 0) +
        ' from Direct, then entering ' +
        row.setup.lines +
        ' source lines',
    );
    try {
      await arm.perform(
        'bootstrap',
        row.id,
        null,
        (event) => {
          if (current?.id !== row.id) return;
          const match = event.detail?.match(/Completed line (\d+)\/(\d+)/);
          const entered =
            event.detail === 'Entered source line' &&
            Number.isInteger(event.fields?.line) &&
            Number.isInteger(event.fields?.total);
          if (match || entered) {
            row.progress = {
              line: Number(match?.[1] ?? event.fields.line),
              total: Number(match?.[2] ?? event.fields.total),
            };
            persist().catch(() => {});
          }
          if (
            match ||
            entered ||
            /Typing:|Pause|Finished|Stopped|END transmitted/.test(
              event.detail || '',
            )
          )
            record('input', event.detail);
        },
        { recovery: !!row.setup.recovery },
      );
      if (current?.id !== row.id || row.status === 'stopping') return;
      row.inputActive = false;
      row.status = 'review';
      row.setup.stage = 'review';
      row.setup.screen = 'editor';
      await record(
        'ready',
        'Entry finished. Confirm the ' +
          row.setup.lines +
          ' source lines on the console before checking or saving.',
      );
      await persist();
      lastCheck = 0;
    } catch (e) {
      if (current?.id === row.id && row.status !== 'stopping') await failure(e);
    }
  }
  async function setupAction({
    action,
    requestId,
    reviewed = false,
    values,
    savedConfirmed = false,
    linesConfirmed = false,
  }) {
    if (preview) throw Error('Preview mode does not send device commands');
    const row = current;
    if (!row || row.kind !== 'bootstrap' || !row.setup)
      throw Error('Start First setup before continuing');
    if (!/^[a-f0-9-]{36}$/.test(requestId || ''))
      throw Error('Invalid request identifier');
    const prior = row.setup.operations.find((o) => o.requestId === requestId);
    if (prior) {
      if (prior.action !== action)
        throw Error('Request identifier already used for another step');
      return { duplicate: true, attempt: row };
    }
    if (
      !['verify', 'skip', 'compare', 'save', 'saved', 'edit-values'].includes(
        action,
      )
    )
      throw Error('Unknown setup step');
    if (
      row.inputActive ||
      ['typing', 'checking', 'saving', 'stopping', 'failed'].includes(
        row.status,
      )
    )
      throw Error('Wait for the current input step to finish');
    const stage = row.setup.stage;
    if (['verify', 'skip'].includes(action)) {
      if (!['review', 'values', 'mismatch', 'save'].includes(stage))
        throw Error('This setup step is not available yet');
      if (!reviewed)
        throw Error(
          'Confirm that all ' +
            (row.setup.lines || 229) +
            ' source lines are present and you have left the console on the indicated screen',
        );
    }
    if (action === 'compare' && !linesConfirmed)
      throw Error(
        'Confirm the checker completed without errors and the source line count is correct',
      );
    if (action === 'edit-values' && stage !== 'mismatch')
      throw Error('There are no mismatched readings to edit');
    if (action === 'compare' && stage !== 'values')
      throw Error('Send the read-only check commands before entering values');
    if (action === 'save' && (stage !== 'save' || !row.setup.reviewConfirmed))
      throw Error(
        'Review the source and verify it or explicitly skip the optional check before saving',
      );
    if (
      action === 'saved' &&
      (stage !== 'save_confirmation' || !savedConfirmed)
    )
      throw Error('Confirm that the console actually saved NS2');
    let result;
    if (action === 'compare')
      result = sourceCheck.compare(
        await sourceCheck.readPlan(root, !!row.setup.recovery),
        values,
      );
    if (['verify', 'save'].includes(action)) {
      const checks = await refresh(true);
      if (!checks.ready)
        throw Error(
          'All four connection checks must pass before sending input',
        );
      if (current !== row || row.inputActive)
        throw Error('The setup state changed; refresh the window');
      await sourceCheck.readPlan(root, !!row.setup.recovery);
      if (current !== row || row.inputActive)
        throw Error('The setup state changed; refresh the window');
    }
    const operation = { requestId, action, at: new Date().toISOString() };
    row.setup.operations.push(operation);
    if (action === 'edit-values') {
      row.setup.stage = 'values';
    } else if (action === 'skip') {
      row.setup.reviewConfirmed = true;
      row.setup.verification = 'skipped';
      row.setup.stage = 'save';
      await record(
        'check',
        'Optional source check explicitly skipped; the console text is not verified',
      );
    } else if (action === 'compare') {
      row.setup.comparison = result;
      row.setup.verification = result.passed ? 'passed' : 'mismatch';
      row.setup.stage = result.passed ? 'save' : 'mismatch';
      await record(
        result.passed ? 'check' : 'warning',
        result.passed
          ? 'All three source parts match the six entered readings'
          : 'Source mismatch: ' +
              result.mismatches
                .map(
                  (p) =>
                    'part ' +
                    p.part +
                    ' (lines ' +
                    p.first +
                    '–' +
                    p.last +
                    ')',
                )
                .join(', '),
      );
    } else if (action === 'saved') {
      await saveJson(bootstrapProfileFile, {
        recovery: !!row.setup.recovery,
        name: row.setup.name || 'NS2',
        lines: row.setup.lines || 229,
        sourceSlot: row.setup.sourceSlot ?? 0,
        sourceSha256: row.setup.sourceSha256,
        verification: row.setup.verification,
        userConfirmed: true,
        consoleReadback: false,
        confirmedAt: new Date().toISOString(),
      });
      row.setup.savedConfirmed = true;
      row.setup.stage = 'reboot';
      row.status = 'awaiting_restart';
      await record(
        'ready',
        (row.setup.name || 'NS2') +
          ' save confirmed by the user. Fully restart the console, then open fresh SmileBASIC Direct.',
      );
    } else {
      row.setup.reviewConfirmed = true;
      const job = crypto.randomUUID();
      row.inputJob = job;
      row.inputActive = true;
      operation.jobId = job;
      const command = action + '-' + row.setup.screen;
      row.status = action === 'verify' ? 'checking' : 'saving';
      row.setup.stage = row.status;
      await persist();
      await record(
        'input',
        action === 'verify'
          ? 'Sending the three-part read-only source check'
          : 'Sending SAVE "TXT:' +
              (row.setup.name || 'NS2') +
              '"; confirm the result on the console',
      );
      (async () => {
        try {
          await arm.perform(
            command,
            job,
            null,
            (event) => {
              if (current?.id === row.id && event.detail)
                record('input', event.detail);
            },
            { recovery: !!row.setup.recovery },
          );
          if (
            current?.id !== row.id ||
            row.status === 'stopping' ||
            row.status === 'failed'
          )
            return;
          row.inputActive = false;
          row.setup.screen = 'direct';
          row.status = 'review';
          row.setup.stage =
            action === 'verify' ? 'values' : 'save_confirmation';
          await persist();
          await record(
            'ready',
            action === 'verify'
              ? 'Read PART 1–3 values and enter the six numbers. Confirm SOURCE LINES shows ' +
                  (row.setup.lines || 229) +
                  ' (or ' +
                  ((row.setup.lines || 229) + 1) +
                  ' with one final empty editor line).'
              : 'Save command sent. Confirm any on-console dialog and tick the saved confirmation only after ' +
                  (row.setup.name || 'NS2') +
                  ' is saved.',
          );
        } catch (e) {
          if (current?.id === row.id && row.status !== 'stopping')
            await failure(e);
        }
      })();
      return { attempt: row };
    }
    await persist();
    return { attempt: row, result };
  }

  async function startConsole(row) {
    const stateRoot = journal.session(row.id),
      apps = path.join(stateRoot, 'data/app-links');
    await fs.mkdir(apps, { recursive: true, mode: 0o700 });
    const env = {
      ...process.env,
      ...launchEnvironment,
      NODE: node,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      HB_RESUME: row.recovery ? '1' : '0',
      HB_INPUT: 'manual',
      HB_MANUAL_INPUT: '1',
      HB_PORT: String(settings.consolePort),
      HB_STREAM_HOST: settings.consoleHost,
      HB_VIDEO_CODEC: 'delta',
      IZ12_STREAM_DIRECT_INFLATE:
        settings.streamDirectInflate === false ? '0' : settings.streamDirectInflate === true ? '1' : 'auto',
      HB_STREAM_TRANSPORT: 'tcp',
      HB_OPEN_PANEL: '0',
      IZ11_STATE_DIR: stateRoot,
      HB_APPS_DIR: apps,
      IZ12_CONSOLE_MODE: connections?.mode('lan') || 'lan',
      IZ12_CONSOLE_LINKS: JSON.stringify(connections?.candidates?.() || []),
    };
    if (current !== row || row.status === 'stopping') return;
    if (row.selectedModules?.length) {
      await record(
        'stage',
        'Preparing ' +
          row.selectedModules.length +
          ' selected modules from the local library',
      );
      await prepareModules(root, row.selectedModules, apps,{shell:launchEnvironment.IZ2S_SHELL||launchEnvironment.IZ15_SHELL||'izlauncher'});
    }
    if (
      current !== row ||
      row.status === 'stopping' ||
      row.status === 'cancelled'
    )
      return;
    env.IZ2S_MODULE_PINS = JSON.stringify(await require('../modules.cjs').capture(root));
    const execution = prepareLaunch
      ? await prepareLaunch()
      : {
          command: node,
          args: ['core/session/console-runner.cjs', settings.consoleHost],
          cwd: root,
          env: {},
        };
    row.extensionFingerprint = execution.extensionFingerprint;
    await persist();
    child = launch(execution.command || node, execution.args, {
      cwd: execution.cwd || root,
      env: { ...env, ...execution.env },
      detached: process.platform === 'linux',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ownedChild = child;
    let output = '',
      tail = '',
      sending = false;
    async function consume(line, isError = false) {
      if (
        current !== row ||
        ['stopping', 'cancelled', 'failed'].includes(row.status)
      )
        return;
      const match = line.match(/^Run folder: ([^\r\n]+)/);
      if (match && !sending) {
        const dir = path.resolve(match[1]);
        if (path.dirname(dir) !== path.join(root, 'data/sessions'))
          throw Error('Unexpected run folder');
        sending = true;
        current.runDirectory = dir;
        await persist();
        await record('input', 'Sending the fresh launch sequence');
        inputTask = arm.perform(
          'connect',
          row.id,
          dir,
          (event) => {
            if (event.detail) record('input', event.detail);
          },
          { recovery: !!row.recovery },
        );
        inputTask.catch(async (e) => {
          if (current?.id === row.id && current.status !== 'stopping') {
            child?.kill('SIGTERM');
            await failure(e);
          }
        });
      }
      const peer = line.match(/^Console peer: ([0-9.]+)$/);
      if (peer) {
        row.consoleAddress = peer[1];
        connections?.observeConsole?.(peer[1]);
      }
      if (line === 'Console link: closed') {
        // A dead native link cannot complete audio/receiver cleanup. Its dedicated
        // host process group must not keep the desktop stuck in a running state.
        if (!row.consoleClosed) {
          row.consoleClosed = true;
          await failure(Error('Console connection ended'));
          try {
            if (
              process.platform === 'linux' &&
              Number.isInteger(ownedChild.pid) &&
              ownedChild.pid > 1
            )
              killGroup(ownedChild.pid);
            else ownedChild.kill('SIGKILL');
          } catch (e) {
            if (e.code !== 'ESRCH') throw e;
          }
        }
        return;
      }
      if (/runtime is running/.test(line)) {
        current.status = 'running';
        current.connectedAt = new Date().toISOString();
        await persist();
        await record('ready', 'Launcher is connected');
      }
      if (isError) await record('detail', line);
      else if (
        /Creating|verified|checks passed|starting|ready|Preparing/i.test(
          line,
        ) &&
        line.length < 220
      )
        await record('stage', line);
    }
    child.stdout.on('data', (b) => {
      output += b;
      let i;
      while ((i = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, i);
        output = output.slice(i + 1);
        consume(line).catch((e) => failure(e));
      }
    });
    child.stderr.on('data', (b) => {
      tail = (tail + b).slice(-12000);
      for (const line of b.toString().split('\n'))
        if (line.trim()) consume(line, true).catch(() => {});
    });
    child.once('error', (e) => failure(e).catch(() => {}));
    child.once('close', async (code, signal) => {
      if (child === ownedChild) child = null;
      if (!current || current.id !== row.id) return;
      if (current.status === 'stopping') {
        current.status = 'stopped';
        current.completed = new Date().toISOString();
        await persist();
        lastAttempt = current;
        current = null;
      } else
        await failure(
          Error(
            tail.trim().split('\n')[0] ||
              'Console session ended (' + (signal || code) + ')',
          ),
        );
    });
  }
  async function begin({
    kind,
    screenReady,
    requestId,
    moduleIds = [],
    recovery = false,
  }) {
    await recoveryReady;
    if (preview) throw Error('Preview mode does not send device commands');
    if (!['bootstrap', 'launch'].includes(kind))
      throw Error('Choose an installation step');
    if (!/^[a-f0-9-]{36}$/.test(requestId || ''))
      throw Error('Invalid request identifier');
    if (emergencyInputPending)
      throw Error(
        'Wait for input cancellation to finish before starting again',
      );
    if (beginBusy) throw Error('An attempt is already starting');
    beginBusy = true;
    const ownEpoch = epoch;
    try {
      const existing = await journal.read(requestId);
      if (existing) return { attempt: existing, duplicate: true };
      const finishedSetup =
        kind === 'launch' &&
        current?.kind === 'bootstrap' &&
        current.setup?.stage === 'reboot' &&
        current.setup.savedConfirmed
          ? current
          : null;
      if ((current && !finishedSetup) || child)
        throw Error('An attempt is already active or still stopping');
      if (!screenReady)
        throw Error(
          kind === 'bootstrap'
            ? 'Open Make a Program → Direct with the indicated installation slot empty, English (US) keyboard and Caps Lock off'
            : 'Fully restart the console and open fresh SmileBASIC Direct mode',
        );
      const selectedModules =
        kind === 'launch'
          ? await require('./preload.cjs').resolve(root, moduleIds,{shell:launchEnvironment.IZ2S_SHELL||launchEnvironment.IZ15_SHELL||'izlauncher'})
          : [];
      const checks = await refresh(true);
      if (epoch !== ownEpoch) throw Error('Start cancelled by STOP');
      if (!checks.ready)
        throw Error('All four connection checks must pass before starting');
      if ((current && current !== finishedSetup) || child)
        throw Error('An attempt is already active or still stopping');
      const selectedRecovery =
        recoveryAvailable &&
        (kind === 'bootstrap'
          ? recovery === true
          : !!(await bootstrapProfile(root)).recovery);
      const setupPlan =
        kind === 'bootstrap'
          ? await sourceCheck.readPlan(root, selectedRecovery)
          : null;
      if (finishedSetup) {
        finishedSetup.status = 'complete';
        finishedSetup.completed = new Date().toISOString();
        await journal.write(finishedSetup);
        if (current !== finishedSetup) throw Error('Setup state changed');
        lastAttempt = finishedSetup;
        current = null;
      }
      if (epoch !== ownEpoch) throw Error('Start cancelled by STOP');
      current = {
        id: requestId,
        kind,
        recovery: selectedRecovery,
        selectedModules,
        loaderId,
        status: 'starting',
        created: new Date().toISOString(),
        progress: null,
        ...(finishedSetup ? { setupAttemptId: finishedSetup.id } : {}),
      };
      if (kind === 'bootstrap')
        current.setup = {
          recovery: selectedRecovery,
          name: await bootstrapName(selectedRecovery),
          lines: setupPlan.lines,
          sourceSlot: setupPlan.sourceSlot ?? 0,
          sourceSha256: setupPlan.sha256,
          parts: setupPlan.parts,
          stage: 'prepare',
          screen: 'direct',
          reviewConfirmed: false,
          verification: 'not_run',
          savedConfirmed: false,
          operations: [],
        };
      notification = null;
      await persist();
      await record(
        'start',
        kind === 'bootstrap'
          ? 'First installation requested from Direct'
          : 'Fresh launcher session requested after restart confirmation',
      );
      const row = current;
      if (kind === 'bootstrap') bootstrap(row);
      else
        startConsole(row).catch((error) => {
          if (current === row) return failure(error);
        });
      return { attempt: row };
    } finally {
      beginBusy = false;
    }
  }

  const timeout = async (p, ms) => {
    let timer;
    try {
      return await Promise.race([
        p,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error('Graceful shutdown timed out. Use the red STOP button.'),
              ),
            ms,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  async function stop() {
    if (!current) return;
    const row = current;
    if (row.status === 'stopping') return;
    row.status = 'stopping';
    row.stopRequestedAt = new Date().toISOString();
    await persist();
    const ownedChild = child;
    try {
      if (row.inputActive || (row.kind === 'launch' && ownedChild))
        await timeout(arm.halt(row.inputJob || row.id), graceMs);
      if (current !== row) return;
      ownedChild?.kill('SIGTERM');
      if (row.kind === 'bootstrap' || !ownedChild) {
        row.status = 'cancelled';
        row.needsRestart = row.kind === 'bootstrap' || !!row.runDirectory;
        row.completed = new Date().toISOString();
        await journal.write(row);
        lastAttempt = row;
        current = null;
        notification = row.needsRestart
          ? {
              type: 'error',
              message:
                'Input stopped. Restart the console before another attempt.',
            }
          : {
              type: 'success',
              message: 'Startup cancelled. No console commands were sent.',
            };
      } else {
        const timer = setTimeout(() => {
          if (current === row && row.status === 'stopping') {
            row.stopTimedOut = true;
            notification = {
              type: 'error',
              message:
                'Graceful shutdown is not responding. Use the red STOP button, then restart the console manually.',
            };
            journal.write(row).catch(() => {});
          }
        }, graceMs);
        timer.unref();
      }
    } catch (error) {
      if (current === row) {
        row.stopTimedOut = true;
        notification = { type: 'error', message: error.message };
        await persist();
      }
    }
    lastCheck = 0;
  }
  function cancelRemoteInput(row) {
    if (inputCancellation) return inputCancellation;
    emergencyInputPending = true;
    inputRecovery = row;
    const operation = timeout(
      saveJson(recoveryFile, {
        id: row.id,
        inputJob: row.inputJob || row.id,
      }).then(() => arm.halt(row.inputJob || row.id)),
      20000,
    );
    inputCancellation = operation
      .then(
        async () => {
          await fs.rm(recoveryFile, { force: true });
          emergencyInputPending = false;
          inputRecovery = null;
          notification = {
            type: 'error',
            message:
              'Host stopped and input cancellation confirmed. Fully restart the Switch manually before reconnecting.',
          };
          await journal.append(
            row.id,
            'detail',
            'Remote input cancellation confirmed.',
          );
        },
        async (error) => {
          notification = {
            type: 'error',
            message:
              'Host stopped. Input cancellation could not be confirmed. Check the ARM PC connection and press the red STOP button to retry.',
          };
          await journal.append(
            row.id,
            'warning',
            'Input cancellation unconfirmed: ' + error.message,
          );
        },
      )
      .finally(() => {
        inputCancellation = null;
      });
    return inputCancellation;
  }
  async function hardStop() {
    await recoveryReady;
    epoch++;
    const row = current,
      ownedChild = child;
    if (!row && !ownedChild) {
      if (inputRecovery) cancelRemoteInput(inputRecovery).catch(() => {});
      return { ok: true };
    }
    if (row) {
      row.status = 'cancelled';
      if (current === row) current = null;
    }
    // The runner owns a dedicated process group; never kill the desktop UI or another profile.
    if (ownedChild) {
      if (
        process.platform === 'linux' &&
        Number.isInteger(ownedChild.pid) &&
        ownedChild.pid > 1
      ) {
        try {
          killGroup(ownedChild.pid);
        } catch (e) {
          if (e.code !== 'ESRCH') throw e;
        }
      } else ownedChild.kill('SIGKILL');
      if (child === ownedChild) child = null;
    }
    if (row) {
      row.status = 'cancelled';
      row.forcedStop = true;
      row.needsRestart = true;
      row.completed = new Date().toISOString();
      if (current === row) current = null;
      lastAttempt = row;
      await journal.write(row);
      await journal.append(
        row.id,
        'warning',
        'Forced host stop. No console cleanup or power command was sent. Fully restart the console manually.',
      );
      cancelRemoteInput(row).catch(() => {});
    }
    notification = {
      type: 'error',
      message:
        'Host session force-stopped. Fully restart the Switch manually before reconnecting.',
    };
    lastCheck = 0;
    return { ok: true };
  }
  async function snapshot() {
    await recoveryReady;
    const row = current || lastAttempt;
    let runtime = null,
      capture = null,
      link = null,
      consoleState = null,
      library = [],
      jobs = [],
      log = [];
    if (row?.runDirectory) {
      runtime = await readJson(
        path.join(row.runDirectory, 'run11-runtime.json'),
      );
      capture = await readJson(
        path.join(row.runDirectory, 'pc-screen-local.json'),
      );
      link = await readJson(
        path.join(row.runDirectory, 'connection-state.json'),
      );
      consoleState = await readJson(
        path.join(row.runDirectory, 'console-state.json'),
      );
      if (
        current === row &&
        consoleState?.network?.connected &&
        consoleState.stale===false &&
        require('./network-discovery.cjs').privateIP(consoleState.network.ip) &&
        Date.now() - Date.parse(consoleState.at || 0) < 6000 &&
        ['ethernet', 'wifi'].includes(consoleState.network.type)
      )
        await connections?.observeConsole?.(
          consoleState.network.ip,
          consoleState.network.type === 'wifi' ? 'wifi' : 'lan',
        );
    }
    if (row) {
      log = await journal.recent(row.id);
      try {
        const lines = (
          await fs.readFile(
            path.join(journal.session(row.id), 'events.jsonl'),
            'utf8',
          )
        )
          .trim()
          .split('\n')
          .filter(Boolean)
          .slice(-150)
          .flatMap((line) => {
            try {
              return [JSON.parse(line)];
            } catch {
              return [];
            }
          });
        log.push(
          ...lines.map((e) => ({
            ...e,
            message: redact(e.message).replace(/Run11/g, 'Launcher'),
          })),
        );
        log.sort((a, b) => a.at.localeCompare(b.at));
        log = log.slice(-250);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      try {
        jobs = await require('../packages/jobs.cjs').all(
          journal.session(row.id),
        );
      } catch {}
    }
    try {
      const repo = await require('../packages/repository.cjs').create(root,{shell:launchEnvironment.IZ2S_SHELL||launchEnvironment.IZ15_SHELL||'izlauncher'});
      library = (await repo.list()).packages.map(
        require('../packages/repository.cjs').publicPackage,
      );
    } catch (e) {
      notification = { type: 'error', message: redact(e.message) };
    }
    const fresh = !!(
      current?.status === 'running' &&
      runtime?.menuReady &&
      Date.now() - Date.parse(runtime.updated || 0) < 6000
    );
    return {
      hostModules: await require('./host-modules.cjs').status(root),
      version: 12,
      setupWizard: true,
      hardStopAvailable: true,
      bootstrapProfile: await bootstrapProfile(root),
      recoverySetupAvailable: recoveryAvailable,
      recoverySource: await sourceCheck.readPlan(root, recoveryAvailable),
      link,
      consoleState: consoleState
        ? {
            ...consoleState,
            stale: Date.now() - Date.parse(consoleState.at || 0) > 6000,
          }
        : null,
      emergencyInputPending,
      preview,
      connections: connections
        ? {
            ...connections.snapshot(),
            locked: !!(current || child || beginBusy || emergencyInputPending),
          }
        : null,
      checks: probe,
      active: current,
      lastAttempt: !current ? lastAttempt : null,
      notification,
      history: await journal.listFailures(),
      log,
      library,
      jobs,
      installed: runtime?.installed || [],
      connected: fresh,
      fps:
        fresh && runtime.lastFrameBatch?.interval
          ? Math.round(
              runtime.lastFrameBatch.frames / runtime.lastFrameBatch.interval,
            )
          : null,
      streamUrl: capture?.url || null,
      settings: {
        consoleHost: settings.consoleHost,
        consoleAddress: settings.consoleAddress,
      },
    };
  }
  async function loadPackages(ids) {
    if (
      !current?.runDirectory ||
      current.status !== 'running' ||
      !(await snapshot()).connected
    )
      throw Error('Start and connect the launcher first');
    const repo = await require('../packages/repository.cjs').create(root,{shell:launchEnvironment.IZ2S_SHELL||launchEnvironment.IZ15_SHELL||'izlauncher'}),
      list = await repo.list();
    if (!Array.isArray(ids) || !ids.length || ids.length > 16)
      throw Error('Select an app');
    for (const id of [...new Set(ids)]) {
      const pkg = list.packages.find((p) => p.id === id);
      if (!pkg) throw Error('App is no longer available');
      await require('../packages/jobs.cjs').create(
        journal.session(current.id),
        pkg,
        'browser',
      );
    }
  }
  async function unloadPackages(ids) {
    if(preview)throw Error('Preview cannot remove console modules');
    const state=await snapshot();
    if(!current?.runDirectory||current.status!=='running'||!state.connected)throw Error('Start and connect the launcher first');
    return require('../packages/removal.cjs').queue(journal.session(current.id),ids,state.installed,'browser');
  }
  async function configureConnection(body) {
    await recoveryReady;
    if (preview) throw Error('Preview mode does not change device connections');
    if (!connections)
      throw Error('Restart Run12 to enable connection settings');
    if (current || child || beginBusy || emergencyInputPending)
      throw Error('Stop the current session before changing connections');
    beginBusy = true;
    try {
      if (checking) await checking;
      await connections.update(body);
      probe = {
        ready: false,
        items: probe.items.map((row) => ({
          ...row,
          ready: false,
          detail: 'Checking selected connection…',
        })),
      };
      lastCheck = 0;
      await refresh(true);
      return { ok: true };
    } finally {
      beginBusy = false;
    }
  }
  return {
    refresh,
    begin,
    stop,
    hardStop,
    snapshot,
    loadPackages,
    unloadPackages,
    setupAction,
    configureConnection,
    async retry() {
      if (child || beginBusy || current?.inputActive)
        throw Error(
          'Wait for input and the current session to stop before returning to the beginning',
        );
      if (current) {
        if (current.kind !== 'bootstrap')
          throw Error('Stop the active session first');
        current.status =
          current.setup?.verification === 'mismatch' ? 'failed' : 'cancelled';
        current.completed = new Date().toISOString();
        current.needsRestart = true;
        if (current.status === 'failed')
          current.error = 'Source check did not match';
        await persist();
        current = null;
      }
      lastAttempt = null;
      notification = null;
      lastCheck = 0;
      return { ok: true };
    },
    async setupReport(id) {
      let row = await journal.read(id);
      if (!row) throw Error('Attempt not found');
      if (row.setupAttemptId)
        row = (await journal.read(row.setupAttemptId)) || row;
      return sourceCheck.report(root, row, await journal.recent(row.id));
    },
    ownsListener: () => !!child,
    get activeId() {
      return current?.id;
    },
    async remove(id) {
      await journal.removeFailure(id, current?.id);
      if (lastAttempt?.id === id) lastAttempt = null;
    },
    historyLog: (id) => journal.recent(id),
    dismiss: () => (notification = null),
  };
}
module.exports = { createSessionManager };
