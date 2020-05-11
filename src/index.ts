import { clipboard } from 'electron';
import * as path from 'path';
import turbowalk, { IEntry } from 'turbowalk';
import { fs, log, selectors, types, util } from 'vortex-api';
import { IFileEntry, IPluginEntry, IReport } from './IReport';

async function fileMD5(filePath: string): Promise<string> {
  const stackErr = new Error();
  const updateErr = (err: Error) => {
    err.stack = [].concat(
      err.stack.split('\n').slice(0, 1),
      stackErr.stack.split('\n').slice(1),
    ).join('\n');
    return err;
  };

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
        reject(updateErr(err));
      });
    } catch (err) {
      err.stack = stackErr.stack;
      reject(updateErr(err));
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

  const conlim = new util.ConcurrencyLimiter(100,
    (err: Error) => err['code'] === 'EMFILE');
  return Promise.all(fileList
    .filter(entry => !entry.isDirectory)
    .map(async (entry: IEntry): Promise<IFileEntry> => {
      const relPath = path.relative(modPath, entry.filePath);
      const manifestEntry = manifestLookup[relPath.toUpperCase()];
      let md5sum: string;
      let errCode: string;
      try {
        md5sum = await conlim.do(async () =>
          fileMD5(path.join(deployTarget, manifestEntry.relPath)));
      } catch (err) {
        md5sum = null;
        errCode = err.code;
      }
      const res: IFileEntry = {
        path: path.relative(modPath, entry.filePath),
        deployed: manifestEntry !== undefined,
        overwrittenBy: manifestEntry?.source === mod.id ? null : manifestEntry?.source,
        md5sum,
      };
      if (errCode !== undefined) {
        res.error = errCode;
      }
      return res;
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
      creation: Date.now(),
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
  const deployedFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum !== null) && (file.overwrittenBy === null);
  const overwrittenFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum !== null) && file.overwrittenBy !== null;
  const missingFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum === null) && (file.error === 'ENOENT');
  const errorFilter = (file: IFileEntry) =>
    file.deployed && (file.md5sum === null) && (file.error !== 'ENOENT');
  const undeployedFilter = (file: IFileEntry) => !file.deployed;

  const fileList = (filter: (file: IFileEntry) => boolean, print: (file: IFileEntry) => string) => {
    const filtered = input.files.filter(filter);
    if (filtered.length > 0) {
      return filtered.map(print);
    } else {
      return ['<None>'];
    }
  };

  let res = [
    divider,
    `* Mod installation report (created on ${new Date(input.info.creation).toUTCString()})`,
    `* Mod name: ${input.mod.name}`,
    `* Version: ${input.mod.version}`,
    `* Archive: ${input.mod.archiveName}`,
    `* MD5 checksum: ${input.mod.md5sum}`,
    `* Download source: ${input.mod.source} (mod ${input.mod.modId}, file ${input.mod.fileId})`,
    `* Last deployment: ${input.mod.deploymentTime === 0 ? 'Unknown' : new Date(input.mod.deploymentTime).toUTCString()}`,
    `* Deployment method: ${input.mod.deploymentMethod}`,
    `* Mod type: ${input.mod.modType}`,
    divider,
    '',
    divider,
    `* Deployed files:`,
    divider,
    ...fileList(deployedFilter, file => `${file.path} (${file.md5sum})`),
    '',
    divider,
    `* Files overwritten by other mod:`,
    divider,
    ...fileList(overwrittenFilter, file => `${file.path} (${file.md5sum}) - ${file.overwrittenBy}`),
    '',
    divider,
    `* Files not deployed:`,
    divider,
    ...fileList(undeployedFilter, file => `${file.path}`),
    '',
    divider,
    `* Files that are supposed to be deployed but weren't found:`,
    divider,
    ...fileList(missingFilter, file => `${file.path}`),
    '',
    divider,
    `* Files that are present but couldn't be read:`,
    divider,
    ...fileList(errorFilter, file => `${file.path} (${file.error})`),
  ];

  if (input.loadOrder !== undefined) {
    const ownedPlugins = new Set(input.plugins.map(plugin => plugin.name.toLowerCase()));
    res = res.concat([
      '',
      divider,
      `* Plugins`,
      divider,
      ...(input.plugins.length === 0
        ? ['<None>']
        : input.plugins.map(plugin =>
            `${plugin.name} (${plugin.enabled ? 'Enabled' : 'Disabled'})`)),
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
  context.registerAction('mods-action-icons', 250, 'report', {}, 'Create Report',
    (instanceIds: string[]) => {
      createReport(context.api, instanceIds[0]);
    });
}

export default init;
