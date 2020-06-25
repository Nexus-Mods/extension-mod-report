import { clipboard } from 'electron';
import * as path from 'path';
import turbowalk, { IEntry } from 'turbowalk';
import { fs, log, selectors, types, util } from 'vortex-api';
import binUpload from './binupload';
import format, { FormatterMarkdown, FormatterReadable } from './format';
import { IFileEntry, IPluginEntry, IReport } from './IReport';

const WARN_CHECKSUM_FILES = 100;

const PROGRESS_NOTIFICATION: types.INotification = {
  id: 'mod-report-creation',
  type: 'activity',
  title: 'Creating report...',
  message: '',
  progress: 0,
};

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
  try {
    await turbowalk(modPath, entries => {
      result = result.concat(entries);
    });
  } catch (err) {
    if (['ENOTFOUND', 'ENOENT'].indexOf(err.code) === -1) {
      log('error', 'Failed to list files',
        { path: modPath, error: err.message });
    }
  }

  return result;
}

async function fileReport(api: types.IExtensionApi,
                          gameId: string,
                          mod: types.IMod,
                          fileList: IEntry[],
                          manifest: types.IDeploymentManifest,
                          generateMD5: boolean)
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

  const fileListFiles = fileList.filter(entry => !entry.isDirectory);

  let completed: number = 0;
  let lastPerc: number = 0;
  const modName = util.renderModName(mod);
  const onCompleted = () => {
    ++completed;
    const newPerc = Math.floor((completed * 100) / fileListFiles.length);
    if (newPerc !== lastPerc) {
      api.sendNotification({
        ...PROGRESS_NOTIFICATION,
        id: `mod-report-creation-${mod.id}`,
        message: modName,
        progress: newPerc,
      });
      lastPerc = newPerc;
    }
  };

  const conlim = new util.ConcurrencyLimiter(50,
    (err: Error) => ['EMFILE', 'EBADF'].includes(err['code']));
  return Promise.all(fileListFiles
    .map(async (entry: IEntry): Promise<IFileEntry> => {
      const relPath = path.relative(modPath, entry.filePath);
      const manifestEntry = manifestLookup[relPath.toUpperCase()];
      let md5sum: string;
      let errCode: string;
      try {
        if (generateMD5) {
          md5sum = await conlim.do(async () =>
            fileMD5(path.join(deployTarget, manifestEntry.relPath)));
        } else {
          md5sum = 'Not calculated';
        }
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
      onCompleted();
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

async function createReportImpl(api: types.IExtensionApi,
                                gameId: string,
                                modId: string): Promise<IReport> {
  const state = api.getState();
  const mod = state.persistent.mods[gameId]?.[modId];
  if (mod === undefined) {
    throw new util.ProcessCanceled('invalid mod id');
  }

  const download = state.persistent.downloads.files[mod.archiveId];

  const manifest: types.IDeploymentManifest = await util.getManifest(api, mod.type, gameId);

  const result: Partial<IReport> = {
    info: {
      creation: Date.now(),
    },
    mod: {
      name: util.renderModName(mod),
      version: mod.attributes?.version || 'N/A',
      md5sum: mod.attributes?.fileMD5 || 'N/A',
      archiveName: download?.localPath || 'N/A',
      managedGame: gameId,
      intendedGame: (download?.game || ['N/A']).join(', '),
      deploymentMethod: manifest.deploymentMethod || 'N/A',
      deploymentTime: (manifest as any).deploymentTime || 0,
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

  const stagingPath = selectors.installPathForGame(state, gameId);
  const fileList = await listFiles(path.join(stagingPath, mod.installationPath));

  let generateMD5: boolean = true;
  if (fileList.length > WARN_CHECKSUM_FILES) {
    const dialogResult: types.IDialogResult = await api.showDialog('question', 'Large number of files', {
      text: 'This mod contains a large number of files, calculating checksums for each '
          + 'may take a while, but without them the report is slightly less useful.',
      checkboxes: [
        { id: 'checksums', value: true, text: 'Generate checksums' },
      ],
    }, [
      { label: 'Continue' },
    ]);

    if (!dialogResult.input['checksums']) {
      generateMD5 = false;
    }
  }

  result.files = await fileReport(api, gameId, mod, fileList, manifest, generateMD5);

  if (isBethesdaGame(gameId)) {
    result.plugins = await pluginReport(api, gameId, mod, fileList);
    const loadOrder = (state as any).loadOrder;
    result.loadOrder = Object.keys(loadOrder || {})
      .filter(entry => loadOrder[entry].enabled)
      .sort((lhs, rhs) => loadOrder[lhs].loadOrder - loadOrder[rhs].loadOrder)
      .map(entry => ({ name: entry, enabled: true }));
  } else {
    const profile: types.IProfile = selectors.activeProfile(state);
    const loadOrder = util.getSafe(state, ['persistent', 'loadOrder', profile.id], undefined);
    if (!!loadOrder) {
      result.loadOrder = Object.keys(loadOrder || {})
        .sort((lhs, rhs) => loadOrder[lhs].pos - loadOrder[rhs].pos)
        .map(entry => ({
          name: entry,
          // KCD and Spyro (probably others too) do not include the
          //  enabled property; in their case, merely their presence in the LO
          //  suggests that the mod is enabled.
          enabled: loadOrder[entry]?.enabled || true,
          locked: loadOrder[entry]?.locked,
          external: loadOrder[entry]?.external,
        }));
    }
  }

  return result as IReport;
}

function formatTime(input: Date): string {
  return [
    input.getFullYear(),
    util.pad(input.getMonth(), '0', 2),
    util.pad(input.getDay(), '0', 2),
    util.pad(input.getHours(), '0', 2),
    util.pad(input.getMinutes(), '0', 2),
  ].join('-');
}

async function createReport(api: types.IExtensionApi, modId: string) {
  try {
    const state = api.getState();
    const gameMode = selectors.activeGameId(state);
    const mod = state.persistent.mods[gameMode][modId];
    const modName = util.renderModName(mod).substr(0, 64);
    api.sendNotification({
      ...PROGRESS_NOTIFICATION,
      id: `mod-report-creation-${modId}`,
      message: modName,
      progress: 0,
    });
    const report = await createReportImpl(api, gameMode, modId);
    const timestamp = new Date();
    api.sendNotification({
      id: `mod-report-creation-${modId}`,
      type: 'success',
      title: 'Report created',
      message: modName,
      actions: [
        {
          title: 'Save to file', action: async () => {
            const modReportsPath = path.join(util.getVortexPath('temp'), 'mod reports');
            await fs.ensureDirWritableAsync(modReportsPath, () => Promise.resolve());
            const tmpPath = path.join(modReportsPath, `${modName}__${formatTime(timestamp)}.txt`);
            const formatted = format(new FormatterReadable(), report);
            await fs.writeFileAsync(tmpPath, formatted);
            util.opn(modReportsPath).catch(() => null);
          },
        },
        {
          title: 'Share', action: async () => {
            try {
              const { id, url } = await binUpload(report);
              api.showDialog('success', 'Report uploaded', {
                bbcode: 'Report has been uploaded. '
                    + 'You can share this link with people trying to help you.<br/>'
                    + '[color=red]If you lose this link you will have to recreate the report.[/color]<br/><br/>',
                message: url,
              }, [
                { label: 'Open Report', action: () => util.opn(url).catch(() => null) },
                { label: 'Copy Link', action: () => clipboard.writeText(url) },
              ]);
            } catch (err) {
              api.showErrorNotification('Failed to upload report', err);
            }
          },
        },
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
    }, (instanceIds: string[]) => {
      const state = context.api.getState();
      const gameMode = selectors.activeGameId(state);
      return state.persistent.mods[gameMode]?.[instanceIds[0]] !== undefined;
    });
}

export default init;
