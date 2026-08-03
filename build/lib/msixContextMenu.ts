/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';

export interface IMsixContextMenuConfiguration {
	readonly clsid: string;
	readonly dllName: string;
	readonly executableName: string;
	readonly id: string;
	readonly title: string;
}

interface IMsixContextMenuProduct {
	readonly nameLong: string;
	readonly nameShort: string;
	readonly win32AppUserModelId?: string;
}

// RFC 4122 URL namespace. The package identity and architecture form the name,
// yielding a stable, product-specific CLSID without private product metadata.
const urlNamespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function createUuidV5(name: string): string {
	const bytes = createHash('sha1')
		.update(urlNamespace)
		.update(name, 'utf8')
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = bytes.toString('hex').toUpperCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getMsixContextMenuConfiguration(
	product: IMsixContextMenuProduct,
	arch: string
): IMsixContextMenuConfiguration | undefined {
	if (!product.win32AppUserModelId) {
		return undefined;
	}

	return {
		clsid: createUuidV5(`vscode-msix-explorer-command:${product.win32AppUserModelId}:${arch}`),
		dllName: `code_msix_explorer_command_${arch}.dll`,
		executableName: `${product.nameShort}.exe`,
		id: 'OpenWithCodeMsix',
		title: `Open with ${product.nameLong}`,
	};
}
