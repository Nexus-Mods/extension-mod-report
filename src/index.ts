import { clipboard } from 'electron';
import * as path from 'path';
import turbowalk, { IEntry } from 'turbowalk';
import { fs, log, selectors, types, util } from 'vortex-api';
import { IFileEntry, IPluginEntry, IReport } from './IReport';

async function fileMD5(filePath: string): Promise<string> {
  const stackErr = new Error();
  return new Promise<string>((resolve, reject) => {
    try {
      const { createHash } = require('crypto');
      const hash = createHash('md5');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (data) => {
        hash.update(data);
      });
      stream.on('end', () => {
        stream.close();
        stream.destroy();
        return resolve(hash.digest('hex'));
      });
      stream.on('error', (err) => {
        err.stack = stackErr.stack;
        reject(err);
      });
    } catch (err) {
      err.stack = stackErr.stack;
      reject(err);
    }
  });
}

async function listFiles(modPath: string): Promise<IEntry[]> {
  let result: IEntry[] = [];
  await turbowalk(modPath, entries => {
    result = result.concat(entries);
  });
  return result;
}

async function fileReport(api: types.IExtensionApi,
                          gameId: string,
                          mod: types.IMod,
                          fileList: IEntry[],
                          manifest: types.IDeploymentManifest)
                          : Promise<IFileEntry[]> {
  const state = api.getState();
  const stagingPath = selectors.installPathForGame(state, gameId);
  const modPath = path.join(stagingPath, mod.installationPath);
  const deployTarget = selectors.modPathsForGame(state, gameId)[mod.type];
  if (deployTarget === undefined) {
    throw new Error(`invalid mod type ${mod.type}`);
  }

  const manifestLookup: { [relPath: string]: types.IDeployedFile } =
    manifest.files.reduce((prev, iter) => {
      prev[iter.relPath.toUpperCase()] = iter;
      return prev;
    }, {});

  return Promise.all(fileList
    .filter(entry => !entry.isDirectory)
    .map(async (entry: IEntry): Promise<IFileEntry> => {
      const relPath = path.relative(modPath, entry.filePath);
      const manifestEntry = manifestLookup[relPath.toUpperCase()];
      let md5sum: string;
      try {
        md5sum = await fileMD5(path.join(deployTarget, manifestEntry.relPath));
      } catch (err) {
        md5sum = null;
      }
      return {
        path: path.relative(modPath, entry.filePath),
        deployed: manifestEntry !== undefined,
        overwrittenBy: manifestEntry?.source === mod.id ? null : manifestEntry?.source,
        md5sum,
      };
    }));
}

async function pluginReport(api: types.IExtensionApi,
                            gameId: string,
                            mod: types.IMod,
                            fileList: IEntry[])
                            : Promise<IPluginEntry[]> {
  const state = api.getState();
  const stagingPath = selectors.installPathForGame(state, gameId);
  const modPath = path.join(stagingPath, mod.installationPath);
  const { loadOrder } = state as any;

  const plugins = fileList.filter(entry =>
    ['.esp', '.esm', '.esl'].includes(path.extname(entry.filePath).toLowerCase())
    && (path.dirname(entry.filePath) === modPath));

  return Promise.all(plugins.map((plugin: IEntry): IPluginEntry => {
    const name: string = path.basename(plugin.filePath);
    return {
      name,
      loadOrder: loadOrder[name.toLowerCase()]?.loadOrder || -1,
      enabled: loadOrder[name.toLowerCase()]?.enabled || false,
    };
  }));
}

function isBethesdaGame(gameId: string): boolean {
  return [
    'fallout3', 'falloutnv', 'fallout4', 'fallout4vr',
    'oblivion', 'skyrim', 'skyrimse', 'skyrimvr',
    'fallout76',
  ].includes(gameId);
}

async function createReportImpl(api: types.IExtensionApi, modId: string) {
  const state = api.getState();
  const gameMode = selectors.activeGameId(state);
  const mod = state.persistent.mods[gameMode]?.[modId];
  if (mod === undefined) {
    throw new util.ProcessCanceled('invalid mod id');
  }

  const download = state.persistent.downloads.files[mod.archiveId];

  const manifest: types.IDeploymentManifest = await util.getManifest(api, mod.type, gameMode);

  const result: Partial<IReport> = {
    info: {
      creation: Date.now() / 1000,
    },
    mod: {
      md5sum: mod.attributes?.fileMD5 || 'N/A',
      archiveName: download?.localPath || 'N/A',
      name: mod.attributes?.name || 'N/A',
      deploymentMethod: manifest.deploymentMethod || 'N/A',
      deploymentTime: (manifest as any).deploymentTime || 0,
      version: mod.attributes?.version || 'N/A',
      modType: mod.type || 'default',
      source: mod.attributes?.source || 'N/A',
      modId: mod.attributes?.modId || 'N/A',
      fileId: mod.attributes?.fileId || 'N/A',
    },
  };

  // this information will only be available after the collections feature is released
  if (mod.attributes?.installerChoices !== undefined) {
    result.installerChoices = mod.attributes?.installerChoices;
  }

  const stagingPath = selectors.installPathForGame(state, gameMode);
  const fileList = await listFiles(path.join(stagingPath, mod.installationPath));

  result.files = await fileReport(api, gameMode, mod, fileList, manifest);

  if (isBethesdaGame(gameMode)) {
    result.plugins = await pluginReport(api, gameMode, mod, fileList);
    const loadOrder = (state as any).loadOrder;
    result.loadOrder = Object.keys(loadOrder)
      .filter(entry => loadOrder[entry].enabled)
      .sort((lhs, rhs) => loadOrder[lhs].loadOrder - loadOrder[rhs].loadOrder);
  }

  return result;
}

function formatReport(input: Partial<IReport>): string {
  const divider = '*'.repeat(50);
  const shortDivider = '*'.repeat(20);
  const deployedFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum !== null) && (file.overwrittenBy === null);
  const overwrittenFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum !== null) && file.overwrittenBy !== null;
  const missingFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum === null);
  const undeployedFilter = (file: IFileEntry) => !file.deployed;
  let res = [
    divider,
    `* Mod installation report (created on ${new Date(input.info.creation * 1000).toUTCString()})`,
    `* Mod name: ${input.mod.name}`,
    `* Version: ${input.mod.version}`,
    `* Archive: ${input.mod.archiveName}`,
    `* MD5 checksum: ${input.mod.md5sum}`,
    `* Download source: ${input.mod.source} (mod ${input.mod.modId}, file ${input.mod.fileId})`,
    `* Last deployment: ${input.mod.deploymentTime === 0 ? 'Unkown' : new Date(input.mod.deploymentTime * 1000).toUTCString()}`,
    `* Deployment method: ${input.mod.deploymentMethod}`,
    `* Mod type: ${input.mod.modType}`,
    divider,
    '',
    divider,
    `* Deployed files:`,
    divider,
    ...input.files.filter(deployedFilter).map(file => `${file.path} (${file.md5sum})`),
    '',
    divider,
    `* Files overwritten by other mod:`,
    divider,
    ...input.files.filter(overwrittenFilter).map(file => `${file.path} (${file.md5sum}) - ${file.overwrittenBy}`),
    '',
    divider,
    `* Files not deployed:`,
    divider,
    ...input.files.filter(undeployedFilter).map(file => `${file.path}`),
    '',
    divider,
    `* Files that are supposed to be deployed but weren't found:`,
    divider,
    ...input.files.filter(missingFilter).map(file => `${file.path}`),
  ];

  if (input.loadOrder !== undefined) {
    const ownedPlugins = new Set(input.plugins.map(plugin => plugin.name.toLowerCase()));
    res = res.concat([
      '',
      divider,
      `* Plugins`,
      divider,
      ...input.plugins.map(plugin => `${plugin.name} - ${plugin.enabled ? 'Enabled' : 'Disabled'}`),
      '',
      divider,
      `* Load order`,
      divider,
      ...input.loadOrder.map(plugin => ownedPlugins.has(plugin) ? `+ ${plugin}` : `  ${plugin}`),
    ]);
  }

  return res.join('\n');
}

async function createReport(api: types.IExtensionApi, modId: string) {
  try {
    api.sendNotification({
      id: 'mod-report-creation',
      type: 'activity',
      message: 'Creating report...',
    });
    const report = await createReportImpl(api, modId);
    clipboard.writeText(formatReport(report));
    api.sendNotification({
      id: 'mod-report-creation',
      type: 'success',
      message: 'Report created',
      actions: [
        { title: 'Copy readable', action: () => {
          clipboard.writeText(formatReport(report)); } },
        { title: 'Copy json', action: () => {
          clipboard.writeText(JSON.stringify(report, undefined, 2)); } },
      ],
    });
  } catch (err) {
    api.dismissNotification('mod-report-creation');
    if (err instanceof util.ProcessCanceled) {
      log('info', 'failed to create report', err.message);
    } else {
      api.showErrorNotification('Failed to create mod report', err);
    }
  }
}

function init(context: types.IExtensionContext) {
  context.registerAction('mods-action-icons', 150, 'smart', {}, 'Create Report',
    (instanceIds: string[]) => {
      createReport(context.api, instanceIds[0]);
    });
}

export default init;
