/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Lazy } from '../common/lazy.js';
import { redirectExecutableOutOfWindowsApps } from './msixExecutableRedirect.js';

const _rgDiskPath = new Lazy(async () => {
	const m = await import('@vscode/ripgrep-universal');
	const rgPath = m.rgPath.replace(/\bnode_modules\.asar\b/, 'node_modules.asar.unpacked');

	// For MSIX/packaged installs, the ripgrep executable lives under `C:\Program Files\WindowsApps`,
	// which denies `CreateProcess` to the identity-less search host (spawn fails with EPERM).
	// Redirect it to a runnable copy under the package's LocalCache. No-op for non-packaged installs.
	return redirectExecutableOutOfWindowsApps(rgPath);
});

export function rgDiskPath(): Promise<string> {
	return _rgDiskPath.value;
}
