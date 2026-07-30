/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { IProductConfiguration } from './vs/base/common/product.js';

const require = createRequire(import.meta.url);
const isWindows = process.platform === 'win32';

// Avoid 64 KiB pooled backing stores crossing Mojo's shared-memory threshold.
if (process.platform === 'linux') {
	Buffer.poolSize = 8 * 1024;
}

// increase number of stack frames(from 10, https://github.com/v8/v8/wiki/Stack-Trace-API)
Error.stackTraceLimit = 100;

if (!process.env['VSCODE_HANDLES_SIGPIPE']) {
	// Workaround for Electron not installing a handler to ignore SIGPIPE
	// (https://github.com/electron/electron/issues/13254)
	let didLogAboutSIGPIPE = false;
	process.on('SIGPIPE', () => {
		// See https://github.com/microsoft/vscode-remote-release/issues/6543
		// In certain situations, the console itself can be in a broken pipe state
		// so logging SIGPIPE to the console will cause an infinite async loop
		if (!didLogAboutSIGPIPE) {
			didLogAboutSIGPIPE = true;
			console.error(new Error(`Unexpected SIGPIPE`));
		}
	});
}

// Setup current working directory in all our node & electron processes
// - Windows: call `process.chdir()` to always set application folder as cwd
// -  all OS: store the `process.cwd()` inside `VSCODE_CWD` for consistent lookups
function setupCurrentWorkingDirectory(): void {
	try {

		// Store the `process.cwd()` inside `VSCODE_CWD`
		// for consistent lookups, but make sure to only
		// do this once unless defined already from e.g.
		// a parent process.
		if (typeof process.env['VSCODE_CWD'] !== 'string') {
			process.env['VSCODE_CWD'] = process.cwd();
		}

		// Windows: always set application folder as current working dir
		if (process.platform === 'win32') {
			const appDir = path.dirname(process.execPath);

			// MSIX packages install under `C:\Program Files\WindowsApps`, a protected
			// location that denies `chdir` into it (EPERM) even though its files are
			// readable. The attempt always fails there and, for the console CLI, prints a
			// stack trace on every invocation, so skip it for packaged installs.
			// `VSCODE_CWD` (captured above) preserves the launch directory for path
			// resolution regardless of the process working directory.
			if (!appDir.toLowerCase().includes('\\windowsapps\\')) {
				process.chdir(appDir);
			}
		}
	} catch (err) {
		console.error(err);
	}
}

setupCurrentWorkingDirectory();

/**
 * Add ASAR support to Node's CommonJS module resolution.
 *
 * Production builds bundle our `node_modules` into a `node_modules.asar`
 * archive that sits next to the (now mostly empty) `node_modules` folder.
 * Node does not look into `.asar` archives on its own, so we splice the
 * archive into the lookup paths right before the real `node_modules` folder.
 *
 * The archive keeps the same top-level layout as `node_modules`
 * (`node_modules.asar/<module>`), so bare `require('<module>')` calls resolve
 * exactly like they did before ASAR was introduced. This keeps extensions and
 * tooling that reach into `${appRoot}/node_modules.asar/<module>` working.
 *
 * Note: only applies to the packaged app running on Electron (incl.
 * `ELECTRON_RUN_AS_NODE` forks), never when running out of sources.
 */
function enableASARSupport(): void {
	if (!process.env['ELECTRON_RUN_AS_NODE'] && !process.versions['electron']) {
		return; // only on Electron / Electron-as-node
	}

	if (process.env['VSCODE_DEV']) {
		return; // no ASAR when running out of sources
	}

	// Normalize the drive letter to lower-case for comparison. On Windows the
	// path derived from `import.meta.dirname` (a file URL) can use a different
	// drive-letter case than the paths Node computes for a `require` parent, so
	// an exact string comparison would miss the insertion point (breaking e.g.
	// `require('mkdirp')` from a module inside the archive).
	const normalizeDriveLetter = (p: string): string => {
		if (isWindows && p.length >= 2 && p.charCodeAt(1) === 58 /* : */) {
			const code = p.charCodeAt(0);
			if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
				return p[0].toLowerCase() + p.slice(1);
			}
		}
		return p;
	};

	const NODE_MODULES_PATH = normalizeDriveLetter(path.join(import.meta.dirname, '../node_modules'));

	const Module = require('node:module') as typeof import('node:module') & {
		_resolveLookupPaths: (request: string, parent: unknown) => string[] | null;
	};

	const originalResolveLookupPaths = Module._resolveLookupPaths;
	Module._resolveLookupPaths = function (request: string, parent: unknown): string[] | null {
		const paths = originalResolveLookupPaths(request, parent);
		if (Array.isArray(paths)) {
			for (let i = 0, len = paths.length; i < len; i++) {
				if (normalizeDriveLetter(paths[i]) === NODE_MODULES_PATH) {
					// Derive the archive path from the matched entry so drive-letter
					// case and path separators are preserved exactly.
					paths.splice(i, 0, `${paths[i]}.asar`);
					break;
				}
			}
		}

		return paths;
	};
}

enableASARSupport();

/**
 * MSIX/packaged app: native module loading from `C:\Program Files\WindowsApps`
 * is blocked for processes that do not carry the package identity. Chromium
 * spawns all child/utility processes with `DESKTOP_APP_BREAKAWAY`, so the
 * extension host, pty host, file watcher and shared process run WITHOUT package
 * identity and `process.dlopen()` of a bundled `.node` fails with
 * `Error: Access is denied` — even though the DACL grants the user read access
 * (only code execution/`LoadLibrary` from `WindowsApps` is denied).
 *
 * Reading the file IS permitted, so we redirect native module loads to a
 * per-user copy under the package's `LocalCache`. That location lives outside
 * `WindowsApps` (so `LoadLibrary` is allowed) and is removed automatically when
 * the package is uninstalled. The `.node` and its sibling files (some native
 * addons load adjacent DLLs) are copied on first load and then `dlopen`ed from
 * the copy.
 *
 * Only applies to the packaged app on Windows (i.e. installed under
 * `WindowsApps`), never when running out of sources or from a normal install.
 */
function enableMsixNativeModuleRedirect(): void {
	if (!isWindows) {
		return;
	}

	if (!process.env['ELECTRON_RUN_AS_NODE'] && !process.versions['electron']) {
		return; // only on Electron / Electron-as-node
	}

	if (process.env['VSCODE_DEV']) {
		return; // no redirect when running out of sources
	}

	// `appRoot` is the `resources/app` folder; for an MSIX install it is nested
	// under `...\WindowsApps\<packageFullName>\resources\app`.
	const appRoot = path.dirname(import.meta.dirname);
	const windowsAppsMarker = '\\windowsapps\\';
	const markerIndex = appRoot.toLowerCase().indexOf(windowsAppsMarker);
	if (markerIndex === -1) {
		return; // not installed under WindowsApps => not a packaged app
	}

	const localAppData = process.env['LOCALAPPDATA'];
	if (!localAppData) {
		return;
	}

	// Derive the package full name (first path segment after `WindowsApps`) and
	// the package family name (`<Name>_<PublisherId>`) from the install path,
	// since a process without package identity cannot query them via Win32.
	const packageRootEnd = markerIndex + windowsAppsMarker.length;
	const packageFullName = appRoot.slice(packageRootEnd).split(/[\\/]/)[0];
	const nameParts = packageFullName.split('_');
	if (nameParts.length < 2) {
		return;
	}
	const packageFamilyName = `${nameParts[0]}_${nameParts[nameParts.length - 1]}`;
	const packageVersion = nameParts[1] || '0';

	const packageRoot = appRoot.slice(0, packageRootEnd) + packageFullName;
	const packageRootPrefix = (packageRoot + path.sep).toLowerCase();
	// Keep the cache path SHORT: LoadLibrary/`process.dlopen` fails with
	// "The filename or extension is too long." beyond MAX_PATH, and the package
	// data path is already long. Mirror each native module's directory under a
	// short hash of its in-package location (siblings stay together so adjacent
	// dependency DLLs are copied alongside the `.node`).
	const cacheRoot = path.join(localAppData, 'Packages', packageFamilyName, 'LocalCache', 'vscode-nm', packageVersion);

	const stripNamespacePrefix = (p: string): string => p.startsWith('\\\\?\\') ? p.slice(4) : p;

	// Small stable string hash (djb2) to keep the cache directory name short.
	const shortHash = (value: string): string => {
		let hash = 5381;
		for (let i = 0; i < value.length; i++) {
			hash = (((hash << 5) + hash) + value.charCodeAt(i)) >>> 0;
		}
		return hash.toString(16);
	};

	const ensureDirectoryCopied = (sourceDir: string, targetDir: string): void => {
		if (fs.existsSync(targetDir)) {
			return; // already materialized (this or another process copied it)
		}
		fs.mkdirSync(path.dirname(targetDir), { recursive: true });
		const tempDir = `${targetDir}.tmp-${process.pid}-${Date.now()}`;
		fs.cpSync(sourceDir, tempDir, { recursive: true });
		try {
			fs.renameSync(tempDir, targetDir); // atomic publish
		} catch (err) {
			// A concurrent process may have published it first; clean up our temp copy.
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
			if (!fs.existsSync(targetDir)) {
				throw err;
			}
		}
	};

	const originalDlopen = process.dlopen.bind(process);
	process.dlopen = function (module: { exports: unknown }, filename: string, ...rest: unknown[]): void {
		try {
			const realPath = stripNamespacePrefix(filename);
			if (realPath.toLowerCase().startsWith(packageRootPrefix)) {
				const sourceDir = path.dirname(realPath);
				const targetDir = path.join(cacheRoot, shortHash(sourceDir.slice(packageRootPrefix.length).toLowerCase()));
				ensureDirectoryCopied(sourceDir, targetDir);
				const targetPath = path.join(targetDir, path.basename(realPath));
				return (originalDlopen as (module: { exports: unknown }, filename: string, ...rest: unknown[]) => void)(module, targetPath, ...rest);
			}
		} catch (err) {
			console.error(`[vscode] MSIX native module redirect failed for '${filename}', falling back to in-package load:`, err);
		}
		return (originalDlopen as (module: { exports: unknown }, filename: string, ...rest: unknown[]) => void)(module, filename, ...rest);
	} as typeof process.dlopen;
}

enableMsixNativeModuleRedirect();

/**
 * Add support for redirecting the loading of node modules
 *
 * Note: only applies when running out of sources.
 */
export function devInjectNodeModuleLookupPath(injectPath: string): void {
	if (!process.env['VSCODE_DEV']) {
		return; // only applies running out of sources
	}

	if (!injectPath) {
		throw new Error('Missing injectPath');
	}

	// register a loader hook
	const Module = require('node:module');
	Module.register('./bootstrap-import.js', { parentURL: import.meta.url, data: injectPath });
}

export function removeGlobalNodeJsModuleLookupPaths(): void {
	if (typeof process?.versions?.electron === 'string') {
		return; // Electron disables global search paths in https://github.com/electron/electron/blob/3186c2f0efa92d275dc3d57b5a14a60ed3846b0e/shell/common/node_bindings.cc#L653
	}

	const Module = require('module');
	const globalPaths = Module.globalPaths;

	const originalResolveLookupPaths = Module._resolveLookupPaths;

	Module._resolveLookupPaths = function (moduleName: string, parent: unknown): string[] {
		const paths = originalResolveLookupPaths(moduleName, parent);
		if (Array.isArray(paths)) {
			let commonSuffixLength = 0;
			while (commonSuffixLength < paths.length && paths[paths.length - 1 - commonSuffixLength] === globalPaths[globalPaths.length - 1 - commonSuffixLength]) {
				commonSuffixLength++;
			}

			return paths.slice(0, paths.length - commonSuffixLength);
		}

		return paths;
	};

	const originalNodeModulePaths = Module._nodeModulePaths;
	Module._nodeModulePaths = function (from: string): string[] {
		let paths: string[] = originalNodeModulePaths(from);
		if (!isWindows) {
			return paths;
		}

		// On Windows, remove drive(s) and users' home directory from search paths,
		// UNLESS 'from' is explicitly set to one of those.
		const isDrive = (p: string) => p.length >= 3 && p.endsWith(':\\');

		if (!isDrive(from)) {
			paths = paths.filter(p => !isDrive(path.dirname(p)));
		}

		if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
			const userDir = path.dirname(path.join(process.env.HOMEDRIVE, process.env.HOMEPATH));

			const isUsersDir = (p: string) => path.relative(p, userDir).length === 0;

			// Check if 'from' is the same as 'userDir'
			if (!isUsersDir(from)) {
				paths = paths.filter(p => !isUsersDir(path.dirname(p)));
			}
		}

		return paths;
	};
}

/**
 * Helper to enable portable mode.
 */
export function configurePortable(product: Partial<IProductConfiguration>): { portableDataPath: string; isPortable: boolean } {
	const appRoot = path.dirname(import.meta.dirname);

	function getApplicationPath(): string {
		if (process.env['VSCODE_DEV']) {
			return appRoot;
		}

		if (process.platform === 'darwin') {
			return path.dirname(path.dirname(path.dirname(appRoot)));
		}

		// appRoot = ..\Microsoft VS Code Insiders\<version>\resources\app
		if (process.platform === 'win32' && product.win32VersionedUpdate) {
			return path.dirname(path.dirname(path.dirname(appRoot)));
		}

		return path.dirname(path.dirname(appRoot));
	}

	function getPortableDataPath(): string {
		if (process.env['VSCODE_PORTABLE']) {
			return process.env['VSCODE_PORTABLE'];
		}

		if (process.platform === 'win32' || process.platform === 'linux') {
			return path.join(getApplicationPath(), 'data');
		}

		const portableDataName = product.portable || `${product.applicationName}-portable-data`;
		return path.join(path.dirname(getApplicationPath()), portableDataName);
	}

	const portableDataPath = getPortableDataPath();
	const isPortable = !('target' in product) && fs.existsSync(portableDataPath);
	const portableTempPath = path.join(portableDataPath, 'tmp');
	const isTempPortable = isPortable && fs.existsSync(portableTempPath);

	if (isPortable) {
		process.env['VSCODE_PORTABLE'] = portableDataPath;
	} else {
		delete process.env['VSCODE_PORTABLE'];
	}

	if (isTempPortable) {
		if (process.platform === 'win32') {
			process.env['TMP'] = portableTempPath;
			process.env['TEMP'] = portableTempPath;
		} else {
			process.env['TMPDIR'] = portableTempPath;
		}
	}

	return {
		portableDataPath,
		isPortable
	};
}
