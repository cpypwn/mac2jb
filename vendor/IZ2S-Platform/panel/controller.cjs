const path = require('node:path'),
  { readJson, saveJson, createLedger } = require('../core/session/ledger.cjs');
async function create({ root, settings: defaults, node, preview = false }) {
  const file = path.join(root, 'data/state/launcher-settings.json'),
    loaders = require('../engines/index.cjs').create(root),
    configurations = require('../profiles/index.cjs');
  const saved = await readJson(file, {});
  let choice = {
      loaderId: 'izmysh',
      variant: 'izlauncher',
      loaderSettings: {},
      installationSlots: {},
      ...saved,
    },
    settings,
    configuration,
    connections,
    input,
    devices,
    iz,
    upstream,
    delivery,
    configState,
    initializedInstalled,
    changing = false;
  const availableLoaders=new Set(loaders.IDS);
  if (!availableLoaders.has(choice.loaderId)) choice.loaderId='izmysh';
  choice.loaderSettings=Object.fromEntries(Object.entries(choice.loaderSettings||{}).filter(([id])=>availableLoaders.has(id)));
  choice.installationSlots=Object.fromEntries(Object.entries(choice.installationSlots||{}).filter(([id])=>availableLoaders.has(id)));
  if (
    choice.variant === 'izlauncher' &&
    !loaders.available(choice.loaderId, 'izlauncher')
  )
    choice.loaderId = 'izmysh';
  choice.schemaVersion = 2;
  const isIZ = () => choice.variant !== 'original',
    engine = () => iz || upstream;
  const selectedLoader = () =>
    loaders.select(
      choice.loaderId,
      choice.loaderSettings?.[choice.loaderId] || {},
      { installSlot: choice.installationSlots?.[choice.loaderId] },
    );
  const originalPlan = () =>
    selectedLoader().plan({
      host: settings.consoleHost,
      node,
      input: 'manual',
      port: settings.consolePort,
      runtime: 'original',
    });
  async function initialize() {
    const installationReady = selectedLoader().manifest.installed !== false;
    configState = await configurations.load(root);
    configuration = await configurations.resolve(configState.selected, {
      root,
      settings: defaults,
      profile: configState.profiles?.[configState.selected] || {},
    });
    settings = configuration.settings;
    if (!isIZ())
      settings.consolePort =
        selectedLoader().manifest.consolePort ?? settings.consolePort;
    configuration.env = {
      ...configuration.env,
      HB_PORT: String(settings.consolePort),
    };
    connections =
      await require('../core/session/connections.cjs').createConnections({
        root,
        settings,
        run: preview ? null : require('../core/session/devices.cjs').invoke,
      });
    input = await configurations.createInputLink({ root, configuration });
    devices = await configurations.createChecks({
      root,
      configuration,
      settings,
      node,
      arm: input,
      connections,
      ownsListener: () =>
        iz?.ownsListener() || upstream?.ownsListener() || false,
    });
    delivery = null;
    iz = null;
    if (isIZ() && installationReady) {
      if (!loaders.available(choice.loaderId, 'izlauncher'))
        throw Error('Selected loading method is unavailable for IZlauncher');
      delivery = require('./delivery.cjs').create({
        root,
        id: choice.loaderId,
        settings: selectedLoader().settings,
        configuration,
        input,
        installSlot: selectedLoader().sourcePlan().bootstrap?.sourceSlot,
      });
      iz = require('../core/session/session.cjs').createSessionManager({
        root,
        settings,
        node,
        arm: delivery.input,
        devices,
        connections,
        preview,
        launchEnvironment: {
          ...delivery.environment,
          IZ15_SHELL: choice.variant,
        },
        prepareLaunch: () =>
          selectedLoader().plan({
            host: settings.consoleHost,
            node,
            input: 'manual',
            port: settings.consolePort,
            runtime: 'izlauncher',
          }),
        sourceChecks: delivery.sourceChecks,
        readBootstrapProfile: delivery.profile,
        bootstrapProfileFile: delivery.profileFile,
        bootstrapName: async (recovery) =>
          delivery.installation(recovery).bootstrap.saveName,
        loaderId: choice.loaderId,
        recoveryAvailable: delivery.recoveryAvailable,
      });
      iz.preview = preview;
    }
    upstream = require('./upstream-session.cjs').create({
      root,
      settings,
      node,
      arm: input,
      devices,
      connections,
      preview,
      environment: configuration.env,
      selection: selectedLoader,
    });
    initializedInstalled = installationReady;
  }
  await initialize();
  await saveJson(file, choice);
  async function assertIdle() {
    const state = await engine().snapshot();
    if (changing || state.active || state.emergencyInputPending)
      throw Error('Stop the current session before changing launch settings');
  }
  async function reconcileInstallation() {
    if (changing || initializedInstalled === (selectedLoader().manifest.installed !== false)) return;
    const current = await engine().snapshot();
    if (changing || current.active || current.emergencyInputPending) return;
    changing = true;
    try { await initialize(); }
    finally { changing = false; }
  }
  return {
    preview,
    refresh: (...args) => engine().refresh(...args),
    begin: async (body) => {
      await reconcileInstallation();
      if(configuration.externalWorkflow)throw Error('Use the native companion app for this configuration');
      if (selectedLoader().manifest.installed === false)
        throw Error('Download or manually install the original engine first');
      if (!loaders.available(choice.loaderId, choice.variant))
        throw Error('Selected loader is unavailable for IZlauncher');
      return engine().begin(body);
    },
    stop: () => engine().stop(),
    hardStop: () => engine().hardStop(),
    ownsListener: () => engine().ownsListener(),
    async snapshot() {
      await reconcileInstallation();
      const state = await engine().snapshot(),
        moduleInventory = await require('../core/modules.cjs').list(root),
        extensions = require('../core/extensions.cjs').catalog(root);
      let base, current, baseSource;
      if (delivery) {
        const profile = await delivery.profile();
        base = delivery.installation(false);
        current = await delivery.transport(!!profile.recovery);
        current = {
          ...current,
          bootstrap: {
            ...current.bootstrap,
            saveName: await delivery.connectionBootstrapName(
              !!profile.recovery,
            ),
          },
        };
        baseSource = await delivery.sourceChecks.readPlan(root, false);
      } else {
        const plan = selectedLoader().sourcePlan();
        base = current = {
          bootstrap: plan.bootstrap || { saveName: null },
          preloaded: plan.startup?.preloaded === true,
        };
      }
      return {
        ...state,
        checks:require('../hardware/index.cjs').present(configuration,state.checks),
        moduleCatalog: moduleInventory.modules.map((m) => m.descriptor),
        moduleErrors: moduleInventory.errors,
        moduleStates: require('../core/host-modules.cjs').status(),
        version: 16,
        platform: {
          loaderId: choice.loaderId,
          variant: choice.variant,
          shells: extensions.shells.items,
          extensionErrors: [
            ...extensions.engines.errors,
            ...extensions.shells.errors,
            ...extensions.profiles.errors,
            ...require('../hardware/index.cjs').configurations(root).errors,
          ],
          loaders: await loaders.list(),
          loaderSettings: selectedLoader().settings,
          engineInstalled: selectedLoader().manifest.installed !== false,
          engineInstallation: selectedLoader().manifest.installationStatus,
          installation: base.bootstrap.file
            ? {
                slot: base.bootstrap.sourceSlot,
                name: base.bootstrap.saveName,
                ...require('../core/session/install-slot.cjs').commands(
                  base.bootstrap.saveName,
                  base.bootstrap.sourceSlot,
                ),
              }
            : null,
          izModules: isIZ(),
          baseSource,
          delivery: {
            application: isIZ() ? 'IZlauncher' : 'Original',
            method: choice.loaderId,
            bootstrapName: current.bootstrap.saveName,
            baseBootstrapName: base.bootstrap.saveName,
            recoveryBootstrapName: delivery
              ? delivery.installation(true).bootstrap.saveName
              : base.bootstrap.saveName,
            preloaded: current.preloaded === true,
          },
          configurationId: configuration.id,
          configuration: {
            id: configuration.id,
            name: configuration.name,
            setupRequired: configuration.setupRequired,
            requirements: configuration.requirements,
            executionHost: configuration.executionHost,
            inputAdapter: configuration.inputAdapter,
            inputDirectory:settings.deviceFolder,
            externalWorkflow:configuration.externalWorkflow,
            hardware:configuration.hardware,
            ui:configuration.ui,
          },
          configurations: await configurations.list(root),
          profiles: configState.profiles || {},
          locked: !!state.active || !!state.emergencyInputPending || changing,
        },
      };
    },
    async installEngine(id) {
      await assertIdle();
      if (preview) throw Error('Preview does not download engines');
      changing = true;
      try {
        const result = await require('../core/engine-install.cjs').download(
          root,
          id,
        );
        await initialize();
        return result;
      } finally {
        changing = false;
      }
    },
    async rescanEngine() {
      await assertIdle();
      changing = true;
      try {
        await initialize();
        const selected = selectedLoader().manifest;
        if (selected.installed === false)
          throw Error(selected.installationStatus?.error || 'The engine source is incomplete');
        return { ok: true, installed: true, id: selected.id };
      } finally { changing = false; }
    },
    async configureLaunch(body) {
      await assertIdle();
      const previous = JSON.parse(JSON.stringify(choice));
      changing = true;
      try {
        const next = {
          ...choice,
          loaderId: body.loaderId ?? choice.loaderId,
          variant: body.variant ?? choice.variant,
        };
        if (
          ![
            'original',
            ...require('../core/descriptors.cjs')
              .scan(root, 'shell')
              .items.map((s) => s.id),
          ].includes(next.variant)
        )
          throw Error('Choose IZlauncher or Original');
        loaders.select(
          next.loaderId,
          body.loaderSettings || choice.loaderSettings?.[next.loaderId] || {},
        );
        if (!loaders.available(next.loaderId, next.variant)) {
          if (body.variant === 'izlauncher' && body.loaderId === undefined)
            next.loaderId = 'izmysh';
          else
            throw Error(
              'Selected loading method is unavailable for IZlauncher',
            );
        }
        if (body.installSlot !== undefined) {
          require('../core/session/install-slot.cjs').validate(
            body.installSlot,
          );
          next.installationSlots = {
            ...choice.installationSlots,
            [next.loaderId]: body.installSlot,
          };
        }
        choice = next;
        if (body.loaderSettings !== undefined) {
          loaders.select(choice.loaderId, body.loaderSettings);
          choice.loaderSettings = {
            ...choice.loaderSettings,
            [choice.loaderId]: body.loaderSettings,
          };
        }
        if (body.configurationId !== undefined || body.profile !== undefined) {
          const id = body.configurationId || configState.selected;
          await configurations.resolve(id, {
            root,
            settings: defaults,
            profile: body.profile || configState.profiles?.[id] || {},
          });
          await configurations.save(root, {
            selected: id,
            profiles: {
              ...configState.profiles,
              ...(body.profile ? { [id]: body.profile } : {}),
            },
          });
        }
        await initialize();
        if(body.profile&&Object.hasOwn(body.profile,'armAddress'))
          await connections.update({id:'arm',mode:connections.mode('arm'),ip:body.profile.armAddress||'',automatic:!body.profile.armAddress});
        await saveJson(file, choice);
        return { ok: true };
      } catch (error) {
        choice = previous;
        throw error;
      } finally {
        changing = false;
      }
    },
    async openHardwareApp() {
      await assertIdle();
      if(preview)throw Error('Preview cannot open applications');
      if(!configuration.externalWorkflow)throw Error('This configuration has no native companion');
      const entry=require(path.join(configuration.folder,configuration.entry));
      if(typeof entry.open!=='function')throw Error('The hardware module does not provide a launcher');
      return entry.open({root,configuration});
    },
    async installInput(body) {
      if(preview)throw Error('Preview cannot install an input package');
      await assertIdle();
      if(configuration.inputAdapter!=='ssh-gadget')throw Error('This configuration has no SSH input installer');
      if(!body.confirm)throw Error('Confirm the ARM installation target first');
      changing=true;
      try {
        const profile={...configState.profiles?.[configuration.id],armAddress:body.address,armUser:body.user,sshIdentity:body.identity||''};
        const target=configurations.resolve(configuration.id,{root,settings:defaults,profile});
        if(!require('node:net').isIPv4(target.settings.armAddress))throw Error('Enter the ARM IPv4 address');
        if(!target.settings.armUser)throw Error('Enter the SSH user');
        await configurations.save(root,{selected:configuration.id,profiles:{...configState.profiles,[configuration.id]:profile}});
        await initialize();
        await connections.update({id:'arm',mode:connections.mode('arm'),ip:body.address,automatic:false});
        const result=await input.install();
        await engine().refresh(true);
        return {ok:true,...result};
      } finally { changing=false; }
    },
    configureConnection: (...args) => engine().configureConnection(...args),
    setupAction: (body) => engine().setupAction(body),
    retry: () => engine().retry(),
    setupReport: (...args) => engine().setupReport(...args),
    remove: async (id) => {
      const ledger = createLedger(root),
        row = await ledger.read(id);
      if (row?.upstream) return upstream.remove(id);
      if (iz) return iz.remove(id);
      return ledger.removeFailure(id);
    },
    historyLog: (...args) => engine().historyLog(...args),
    dismiss: () => engine().dismiss(),
    loadPackages: (ids) => {
      if (!isIZ()) throw Error('Select IZlauncher to load IZM modules');
      return iz.loadPackages(ids);
    },
    unloadPackages: (ids) => {
      if(preview)throw Error('Preview cannot remove console modules');
      if(!isIZ())throw Error('Select a console shell to remove modules');
      return iz.unloadPackages(ids);
    },
    async source(id) {
      await reconcileInstallation();
      if (loaders.select(id).manifest.installed === false)
        throw Error('Install the original engine first');
      if (isIZ()) {
        const method = await require('./delivery.cjs').selected({
          root,
          id,
          settings: choice.loaderSettings?.[id] || {},
          host: settings.consoleHost,
          port: settings.consolePort,
          recovery: id === 'izmysh' && !!(await delivery.profile()).recovery,
        });
        return { file: method.bootstrap.file, name: method.bootstrap.saveName };
      }
      const loader = loaders.select(id, choice.loaderSettings?.[id] || {}),
        plan = loader.sourcePlan();
      if (!plan.bootstrap)
        throw Error('This engine does not require a bootstrap');
      return {
        file: plan.bootstrap.file,
        name: plan.bootstrap.saveName || 'NS2',
      };
    },
  };
}
module.exports = { create };
