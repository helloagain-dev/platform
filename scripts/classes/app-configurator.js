/* eslint-disable global-require, no-console */
// global-require needs to be enabled because files to be required are
// determined dynamically

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const glob = require('glob');
const _ = require('lodash');
const rimraf = require('rimraf');
const process = require('process');
const request = require('request');
const {
  prependProjectPath,
  reactNativeLink,
  sanitizeDiff,
} = require('../helpers');
require('colors');

const AppBinaryConfigurator = require('./app-binary-configurator');
const getLocalExtensions = require('./../helpers/get-local-extensions');
const ExtensionsInstaller = require('./extensions-installer.js');
const buildApiEndpoint = require('./../helpers/build-api-endpoint');
const getExtensionsFromConfiguration = require('./../helpers/get-extensions-from-configuration');
const applyReactNativeFixes = require('./../fixes/react-native-fixes');

const NODE_MODULES_DIR = prependProjectPath('node_modules');
const ROOT_PACKAGE_JSON_PATH = prependProjectPath('package.json');

function isExtensionLinkable(extension) {
  const pkgPath = `${NODE_MODULES_DIR}/${extension.id}/package.json`;
  const packageJson = fs.readJsonSync(pkgPath, { throws: false });

  if (packageJson === null) {
    throw new Error(`${pkgPath} is invalid or empty!`);
  }

  const globPattern = `${NODE_MODULES_DIR}/${extension.id}/+(android|fonts|ios)`;
  const containsAndroidOrIosFolders = glob.sync(globPattern);

  // if an extension has native dependencies defined in its package.json
  // or it contains an 'ios' or 'android' directory, it is linkable
  return (
    !!packageJson.nativeDependencies || !!containsAndroidOrIosFolders.length
  );
}

/**
 * AppConfigurator configure application for running other steps (app bundling, run or build)
 * It installs extensions and adds native dependencies and static assets to main project
 * @param  {Object} config
 *  {
 *      @key Number appId
 *      @key String serverApiEndpoint
 *      @key boolean debug builds debug build
 *      @key String configurationFilePath path to where app configuration should be saved
 *      @key String extensionsDir local extensions directory
 *      @key String extensionsJsPath path to extension.js
 *  }
 */
class AppConfigurator {
  constructor(buildConfig) {
    this.buildConfig = _.assign({}, buildConfig);
  }

  cleanTempFolder() {
    rimraf.sync(path.join('.', 'temp', '*'));
  }

  getConfigurationUrl() {
    const { serverApiEndpoint, appId, production } = this.buildConfig;
    const apiPath = 'configurations/current';

    return buildApiEndpoint(serverApiEndpoint, appId, apiPath, production);
  }

  downloadConfiguration() {
    console.time('Download configuration'.bold.green);

    const { buildConfig } = this;
    const { production: isProduction } = buildConfig;

    const requestParams = {
      url: this.getConfigurationUrl(),
      headers: {
        Accept: 'application/vnd.api+json',
        Authorization: `Bearer ${this.buildConfig.authorization}`,
      },
    };

    return new Promise((resolve, reject) => {
      request
        .get(requestParams, (err, response, body) => {
          const statusCode = _.get(response, 'statusCode');
          if (!statusCode || statusCode !== 200) {
            if (statusCode === 404 && isProduction) {
              return reject(
                // eslint-disable-next-line max-len
                "This application doesn't have a production configuration.\nOnly published apps have production configuration."
                  .yellow,
              );
            }
            return reject(
              `Configuration download failed. Error: \n${JSON.stringify(err)}`
                .bold.red,
            );
          }

          const configuration = JSON.parse(body);
          console.timeEnd('Download configuration'.bold.green);

          this.configuration = configuration;

          return resolve(configuration);
        })
        .on('error', err => {
          reject(err);
        });
    });
  }

  prepareConfiguration() {
    if (this.buildConfig.offlineMode) {
      const configuration = require(path.resolve(
        this.buildConfig.configurationFilePath,
      ));
      this.configuration = configuration;

      // Nothing to do, resolve to proceed with next build step
      return Promise.resolve(configuration);
    }

    return this.downloadConfiguration();
  }

  saveConfigurationFiles() {
    const { skipPreBuildActions } = this.buildConfig;
    const logMessage = 'Save configuration files locally'.bold.green;
    console.time(logMessage);

    fs.ensureDirSync('config');

    return fs
      .writeJson('config/buildConfig.json', this.buildConfig)
      .then(() => fs.writeJson('config/appConfig.json', this.configuration))
      .then(() => {
        if (skipPreBuildActions) {
          return Promise.all([
            fs.writeJson(
              'extensions/shoutem.application/app/configuration.json',
              {},
            ),
            fs.writeJson(
              'extensions/shoutem.application/app/buildConfig.json',
              this.buildConfig,
            ),
          ]);
        }
      })
      .then(() => console.timeEnd(logMessage))
      .catch(err => {
        throw new Error(err);
      });
  }

  buildExtensions() {
    const { buildConfig } = this;
    const {
      extensionsJsPath,
      skipNativeDependencies,
      production: isProduction,
      skipLinking,
      skipPreBuildActions,
    } = buildConfig;

    const extensions = getExtensionsFromConfiguration(this.configuration);
    const linkedExtensions = getLocalExtensions(buildConfig.linkedExtensions);

    // npm link all extensions available locally and installed in app configuration
    const localExtensions = _.filter(linkedExtensions, localExt =>
      _.find(extensions, { id: localExt.id }),
    );

    // install as .tars all extensions that are not available locally
    const extensionsToInstall = _.filter(
      extensions,
      ext => !_.some(localExtensions, { id: ext.id }),
    );

    const installer = new ExtensionsInstaller(
      localExtensions,
      extensionsToInstall,
      extensionsJsPath,
    );

    return installer
      .installExtensions(isProduction)
      .then(installedExtensions => {
        const appBinaryConfigurator = new AppBinaryConfigurator(buildConfig);
        const extensionsJs = installer.createExtensionsJs(installedExtensions);
        const lifeCycleHook = skipPreBuildActions ? 'previewBuild' : 'preBuild';
        const preBuild = this.executeBuildLifecycleHook(
          installedExtensions,
          lifeCycleHook,
        );

        let configureProject;

        if (!skipNativeDependencies) {
          const linkableExtensions = skipLinking
            ? []
            : _.filter(installedExtensions, isExtensionLinkable);

          configureProject = appBinaryConfigurator
            .customizeProject()
            .then(() => this.reactNativeLinkExtensions(linkableExtensions))
            .then(() =>
              installer.installNativeDependencies(installedExtensions),
            )
            .then(() => appBinaryConfigurator.configureApp());
        } else if (isProduction) {
          // rename the root view for republish build
          configureProject = appBinaryConfigurator.customizeProject();
        }

        return Promise.all([extensionsJs, preBuild, configureProject]);
      });
  }

  runPostConfigurationStep() {
    const { buildConfig } = this;
    const { skipNativeDependencies, skipPreBuildActions } = buildConfig;

    if (skipPreBuildActions || skipNativeDependencies) {
      return null;
    }

    const extensions = getExtensionsFromConfiguration(this.configuration);
    const linkedExtensions = getLocalExtensions(buildConfig.linkedExtensions);
    const localExtensions = _.filter(linkedExtensions, localExt =>
      _.find(extensions, { id: localExt.id }),
    );
    const extensionsToInstall = _.filter(
      extensions,
      ext => !_.some(localExtensions, { id: ext.id }),
    );
    const installedExtensions = [...localExtensions, ...extensionsToInstall];

    const lifeCycleHook = skipPreBuildActions
      ? 'previewBuild'
      : 'postConfigure';

    return this.executeBuildLifecycleHook(installedExtensions, lifeCycleHook);
  }

  executeBuildLifecycleHook(extensions, lifeCycleStep) {
    const buildStepWrapperPath = prependProjectPath(
      'scripts/helpers/build-step-wrapper.js',
    );

    return new Promise(resolve => {
      console.log(`[${lifeCycleStep.bold}] - all`);
      console.time(`[${lifeCycleStep.bold}]`);

      _.forEach(extensions, extension => {
        if (extension && extension.id) {
          try {
            const buildPath = path.join(extension.id, 'build');
            const build = require(buildPath);
            const buildLifeCycle = _.get(build, lifeCycleStep);

            if (!buildLifeCycle) {
              return resolve();
            }

            if (!_.isFunction(buildLifeCycle)) {
              const errorMessage = 'Invalid export, expected a function.';
              throw new Error(
                `[running ${lifeCycleStep}] - ${extension.id} - ${errorMessage}`,
              );
            }

            const logString = `[${lifeCycleStep}] - ${extension.id}`;
            const execArgs = [
              buildStepWrapperPath,
              '--lifeCycleStep',
              `${lifeCycleStep}`,
            ];
            const options = {
              // extension build hooks expect to be run in their own folder
              cwd: `${NODE_MODULES_DIR}/${extension.id}`,
              stdio: 'inherit',
            };

            console.log(logString);
            console.time(logString);

            // When trying to execute js scripts, the first exec argument must
            // be 'node' for Windows compatibility. Calling exec directly on a
            // file path will result in an 'UNKNOWN' error on Windows.
            execFileSync('node', execArgs, options);

            console.timeEnd(logString);
          } catch (e) {
            // we only ignore invalid `require`
            // build might not exist
            if (e.code !== 'MODULE_NOT_FOUND') {
              throw new Error(e);
            }
          }
        }
      });

      console.timeEnd(`[${lifeCycleStep.bold}]`);
      resolve();
    });
  }

  insertNativeDependencies(extName) {
    const extPackageJson = fs.readJsonSync(
      `${NODE_MODULES_DIR}/${extName}/package.json`,
    );

    if (!extPackageJson.nativeDependencies) {
      return;
    }

    const rootPackageJson = fs.readJsonSync(ROOT_PACKAGE_JSON_PATH);

    const extNativeDependencies = extPackageJson.nativeDependencies;
    const extDependencies = extPackageJson.dependencies;
    const nativeDeps = extNativeDependencies.reduce(
      (o, dep) => ({ ...o, [dep]: extDependencies[dep] }),
      {},
    );

    const newPackageJson = {
      ...rootPackageJson,
      dependencies: {
        ...rootPackageJson.dependencies,
        ...nativeDeps,
      },
    };

    fs.writeJsonSync(ROOT_PACKAGE_JSON_PATH, newPackageJson, { spaces: 2 });
    console.log(
      `[${extName}] - native dependencies added to root package.json`,
    );
  }

  reactNativeLinkExtensions(extensions) {
    if (!extensions.length) {
      return Promise.resolve(extensions);
    }

    return Promise.all(
      extensions.map(ext => {
        this.insertNativeDependencies(ext.id);
        return reactNativeLink(ext.id);
      }),
    );
  }

  run() {
    const { sanitizeGitDiff } = this.buildConfig;

    console.time('Build time'.bold.green);
    console.log(
      'Starting build for app',
      `${this.buildConfig.appId}`.bold.cyan,
    );

    // clear any previous build's temp files
    this.cleanTempFolder();

    return this.prepareConfiguration()
      .then(() => this.saveConfigurationFiles())
      .then(() => this.buildExtensions())
      .then(() => applyReactNativeFixes())
      .then(() => this.runPostConfigurationStep())
      .then(() => {
        if (sanitizeGitDiff) {
          sanitizeDiff();
        }
        console.timeEnd('Build time'.bold.green);
      })
      .catch(e => {
        console.log(e);
        process.exit(1);
      });
  }
}

module.exports = AppConfigurator;
