/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * MSIX/packaged app: `C:\Program Files\WindowsApps` denies both `LoadLibrary` of native modules
 * AND `CreateProcess` of executables for any process that does not carry the package identity.
 * Chromium spawns the extension host, agent host, search host, pty host, shared process and file
 * watcher with `DESKTOP_APP_BREAKAWAY`, so they run WITHOUT package identity and cannot execute a
 * bundled `.exe` (e.g. ripgrep for search, or the agent sandbox binaries) from `WindowsApps` - the
 * spawn fails with `EPERM` / access denied - even though the DACL grants the user read access.
 *
 * Reading the files IS permitted, so these helpers redirect such executables (or whole directories
 * of them) to a per-user copy under the package's `LocalCache`. That location lives outside
 * `WindowsApps` (so `CreateProcess` is allowed) and is removed automatically when the package is
 * uninstalled. The files are copied on first use and then run from the copy.
 *
 * The mirror of native module (`.node`) loading is handled separately, very early, by
 * `enableMsixNativeModuleRedirect()` in `bootstrap-node.ts`, which cannot import from `vs/*`
 * because it runs before module resolution is set up. These helpers apply the same technique for
 * executables spawned from `vs/*` code.
 *
 * On non-Windows, non-packaged installs, or any failure, the original path is returned unchanged.
 */

/**
 * Returns a runnable path to `executablePath`. If it lives under `WindowsApps`, its containing
 * directory (with all siblings) is copied to the package `LocalCache` and the path to the copied
 * executable is returned; otherwise the input is returned unchanged.
 */
export function redirectExecutableOutOfWindowsApps(executablePath: string): string {
	const real = stripNamespacePrefix(executablePath);
	const targetDir = redirectDirectory(path.dirname(real));
	return targetDir ? path.join(targetDir, path.basename(real)) : executablePath;
}

/**
 * Returns a runnable path to `directoryPath`. If it lives under `WindowsApps`, the directory (with
 * all contents) is copied to the package `LocalCache` and the path to the copy is returned;
 * otherwise the input is returned unchanged. Use for directories of executables that other code
 * resolves and spawns (e.g. the agent sandbox `MXC_BIN_DIR/<arch>/wxc-exec.exe`).
 */
export function redirectDirectoryOutOfWindowsApps(directoryPath: string): string {
	const real = stripNamespacePrefix(directoryPath);
	return redirectDirectory(real) ?? directoryPath;
}

/**
 * Copies `sourceDir` (which must be inside a WindowsApps package) to a short, per-user path under
 * the package `LocalCache` and returns the copy's path. Returns `undefined` when not applicable
 * (non-Windows, not under WindowsApps, no LOCALAPPDATA) or on any failure.
 */
function redirectDirectory(sourceDir: string): string | undefined {
	if (process.platform !== 'win32') {
		return undefined;
	}

	try {
		const lowerPath = sourceDir.toLowerCase();

		// MSIX packages install under `...\WindowsApps\<packageFullName>\...`.
		const windowsAppsMarker = '\\windowsapps\\';
		const markerIndex = lowerPath.indexOf(windowsAppsMarker);
		if (markerIndex === -1) {
			return undefined; // not installed under WindowsApps => not a packaged app
		}

		const localAppData = process.env['LOCALAPPDATA'];
		if (!localAppData) {
			return undefined;
		}

		// Derive the package full name (first path segment after `WindowsApps`) and the package
		// family name (`<Name>_<PublisherId>`) from the install path, since a process without
		// package identity cannot query them via Win32.
		const packageRootEnd = markerIndex + windowsAppsMarker.length;
		const packageFullName = sourceDir.slice(packageRootEnd).split(/[\\/]/)[0];
		const nameParts = packageFullName.split('_');
		if (nameParts.length < 2) {
			return undefined;
		}
		const packageFamilyName = `${nameParts[0]}_${nameParts[nameParts.length - 1]}`;
		const packageVersion = nameParts[1] || '0';

		const packageRoot = sourceDir.slice(0, packageRootEnd) + packageFullName;
		const packageRootPrefix = (packageRoot + path.sep).toLowerCase();

		// Keep the cache path SHORT: paths beyond MAX_PATH break `CreateProcess`, and the package
		// data path is already long. Mirror each directory under a short hash of its in-package
		// location (contents stay together so adjacent dependency files are copied alongside).
		const cacheRoot = path.join(localAppData, 'Packages', packageFamilyName, 'LocalCache', 'vscode-exe', packageVersion);
		const targetDir = path.join(cacheRoot, shortHash(sourceDir.slice(packageRootPrefix.length).toLowerCase()));
		ensureDirectoryCopied(sourceDir, targetDir);
		return targetDir;
	} catch {
		return undefined; // fall back to the in-package path on any failure
	}
}

function stripNamespacePrefix(p: string): string {
	return p.startsWith('\\\\?\\') ? p.slice(4) : p;
}

/** Small stable string hash (djb2) to keep the cache directory name short. */
function shortHash(value: string): string {
	let hash = 5381;
	for (let i = 0; i < value.length; i++) {
		hash = (((hash << 5) + hash) + value.charCodeAt(i)) >>> 0;
	}
	return hash.toString(16);
}

function ensureDirectoryCopied(sourceDir: string, targetDir: string): void {
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
}
