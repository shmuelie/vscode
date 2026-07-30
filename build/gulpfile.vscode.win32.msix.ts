/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import gulp from 'gulp';
import * as path from 'path';
import pkg from '../package.json' with { type: 'json' };
import product from '../product.json' with { type: 'json' };
import { getVersion } from './lib/getVersion.ts';
import * as task from './lib/gulp/task.ts';
import * as util from './lib/util.ts';

const repoPath = path.dirname(import.meta.dirname);
const commit = getVersion(repoPath);
const buildPath = (arch: string) => path.join(path.dirname(repoPath), `VSCode-win32-${arch}`);
const msixDir = (arch: string) => path.join(repoPath, '.build', `win32-${arch}`, 'msix');

type ProductWithExtras = typeof product & {
	quality?: string;
	win32NameVersion?: string;
	win32ContextMenu?: Record<string, { clsid: string }>;
};

/**
 * File type associations grouped by the icon they should display in File Explorer.
 * This mirrors the per-extension `DefaultIcon` assignments in the Inno Setup installer
 * (`build/win32/code.iss`), so MSIX-installed builds show the same language-specific
 * icons instead of a single generic icon for every associated file.
 *
 * Each `logo` file already ships inside the package at
 * `resources\app\resources\win32\<logo>`.
 *
 * Note: `.c++` and `.h++` are intentionally excluded because `makeappx` rejects the `+`
 * character in `<uap:FileType>` values.
 */
interface IFileTypeAssociationGroup {
	/** Association alias; must be lowercase and unique within the package. */
	readonly name: string;
	/** User-visible file type name shown in Explorer. */
	readonly displayName: string;
	/** Icon file under `resources\app\resources\win32\`. */
	readonly logo: string;
	readonly extensions: readonly string[];
}

const fileTypeAssociationGroups: readonly IFileTypeAssociationGroup[] = [
	{ name: 'bower', displayName: 'Bower Configuration File', logo: 'bower.ico', extensions: ['.bowerrc'] },
	{ name: 'c', displayName: 'C Source File', logo: 'c.ico', extensions: ['.c', '.h'] },
	{ name: 'workspace', displayName: 'VS Code Workspace', logo: 'code.ico', extensions: ['.code-workspace'] },
	{ name: 'config', displayName: 'Configuration File', logo: 'config.ico', extensions: ['.cfg', '.config', '.editorconfig', '.gitattributes', '.gitconfig', '.gitignore', '.ini'] },
	{ name: 'cpp', displayName: 'C++ Source File', logo: 'cpp.ico', extensions: ['.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'] },
	{ name: 'csharp', displayName: 'C# Source File', logo: 'csharp.ico', extensions: ['.cs', '.csx'] },
	{ name: 'css', displayName: 'CSS File', logo: 'css.ico', extensions: ['.css'] },
	{ name: 'go', displayName: 'Go Source File', logo: 'go.ico', extensions: ['.go'] },
	{ name: 'html', displayName: 'HTML File', logo: 'html.ico', extensions: ['.asp', '.aspx', '.cshtml', '.htm', '.html', '.jshtm', '.jsp', '.phtml', '.shtml', '.xhtml'] },
	{ name: 'jade', displayName: 'Jade File', logo: 'jade.ico', extensions: ['.jade'] },
	{ name: 'java', displayName: 'Java Source File', logo: 'java.ico', extensions: ['.jav', '.java'] },
	{ name: 'javascript', displayName: 'JavaScript File', logo: 'javascript.ico', extensions: ['.cjs', '.js', '.jscsrc', '.jshintrc', '.mjs'] },
	{ name: 'json', displayName: 'JSON File', logo: 'json.ico', extensions: ['.json'] },
	{ name: 'less', displayName: 'Less File', logo: 'less.ico', extensions: ['.less'] },
	{ name: 'markdown', displayName: 'Markdown Document', logo: 'markdown.ico', extensions: ['.markdown', '.md', '.mdoc', '.mdown', '.mdtext', '.mdtxt', '.mdwn', '.mkd', '.mkdn'] },
	{ name: 'php', displayName: 'PHP Source File', logo: 'php.ico', extensions: ['.php'] },
	{ name: 'powershell', displayName: 'PowerShell Script', logo: 'powershell.ico', extensions: ['.ps1', '.psd1', '.psm1'] },
	{ name: 'python', displayName: 'Python Source File', logo: 'python.ico', extensions: ['.ipynb', '.py', '.pyi'] },
	{ name: 'react', displayName: 'React Source File', logo: 'react.ico', extensions: ['.jsx', '.tsx'] },
	{ name: 'ruby', displayName: 'Ruby Source File', logo: 'ruby.ico', extensions: ['.erb', '.gemspec', '.rb'] },
	{ name: 'sass', displayName: 'Sass File', logo: 'sass.ico', extensions: ['.sass', '.scss'] },
	{ name: 'shell', displayName: 'Shell Script', logo: 'shell.ico', extensions: ['.bash', '.bash_login', '.bash_logout', '.bash_profile', '.bashrc', '.profile', '.rhistory', '.rprofile', '.sh', '.zsh'] },
	{ name: 'sql', displayName: 'SQL File', logo: 'sql.ico', extensions: ['.sql'] },
	{ name: 'typescript', displayName: 'TypeScript File', logo: 'typescript.ico', extensions: ['.ts'] },
	{ name: 'vue', displayName: 'Vue File', logo: 'vue.ico', extensions: ['.vue'] },
	{ name: 'xml', displayName: 'XML File', logo: 'xml.ico', extensions: ['.ascx', '.csproj', '.dtd', '.xaml', '.xml'] },
	{ name: 'yaml', displayName: 'YAML File', logo: 'yaml.ico', extensions: ['.eyaml', '.eyml', '.yaml', '.yml'] },
	{ name: 'sourcecode', displayName: 'Source Code File', logo: 'default.ico', extensions: ['.bib', '.clj', '.cljs', '.cljx', '.clojure', '.cls', '.cmake', '.coffee', '.containerfile', '.csv', '.ctp', '.dart', '.diff', '.dockerfile', '.dot', '.edn', '.fs', '.fsi', '.fsscript', '.fsx', '.gradle', '.groovy', '.handlebars', '.hbs', '.log', '.lua', '.m', '.makefile', '.mk', '.ml', '.mli', '.npmignore', '.pl', '.pl6', '.plist', '.pm', '.pm6', '.pod', '.pp', '.properties', '.psgi', '.r', '.rs', '.rst', '.rt', '.svg', '.t', '.tex', '.toml', '.txt', '.vb', '.wxi', '.wxl', '.wxs'] },
];

/**
 * Generates the `windows.fileTypeAssociation` extension XML for every icon group,
 * ready to be substituted into the `@@FILE_TYPE_ASSOCIATIONS@@` manifest placeholder.
 *
 * The `<uap:Logo>` references a `.png` (MSIX requires png/jpg/jpeg for file type
 * association logos — `.ico` is rejected by the manifest schema). The PNG is extracted
 * from the corresponding `.ico` at build time by `extractIconLogos()`.
 */
function buildFileTypeAssociations(): string {
	return fileTypeAssociationGroups.map(group => {
		const fileTypes = group.extensions
			.map(ext => `              <uap:FileType>${ext}</uap:FileType>`)
			.join('\n');
		return [
			'        <uap:Extension Category="windows.fileTypeAssociation">',
			`          <uap:FileTypeAssociation Name="${group.name}">`,
			`            <uap:DisplayName>${group.displayName}</uap:DisplayName>`,
			`            <uap:Logo>resources\\app\\resources\\win32\\${logoPngName(group.logo)}</uap:Logo>`,
			'            <uap:SupportedFileTypes>',
			fileTypes,
			'            </uap:SupportedFileTypes>',
			'          </uap:FileTypeAssociation>',
			'        </uap:Extension>',
		].join('\n');
	}).join('\n');
}

/** Maps a group's `.ico` logo name to the `.png` name used in the manifest. */
function logoPngName(icoName: string): string {
	return icoName.replace(/\.ico$/, '.png');
}

/**
 * Compiles the console launcher stub (`codecli.exe`) into the package layout.
 *
 * An MSIX app execution alias must target a package executable and launches it with the user's
 * arguments verbatim; it cannot inject `ELECTRON_RUN_AS_NODE` or the `cli.js` path. Pointing the
 * alias at the GUI `Code.exe` therefore breaks the command-line contract (no console stdout, no CLI
 * argument handling, no `--wait`). This tiny console-subsystem stub reproduces the desktop
 * `bin\<app>.cmd` launcher: it runs `Code.exe out/cli.js <args>` in Node mode with the console
 * inherited. The MSIX alias targets this stub instead of the GUI executable.
 *
 * The stub is compiled with the .NET Framework C# compiler (`csc.exe`), which ships with Windows,
 * so the MSIX build needs no additional native toolchain. The produced managed console app depends
 * only on the .NET Framework runtime present on all supported Windows versions.
 */
function compileCliStub(layoutPath: string): void {
	const source = path.join(repoPath, 'resources', 'win32', 'msix', 'codecli.cs');
	if (!fs.existsSync(source)) {
		throw new Error(`CLI launcher stub source not found: ${source}`);
	}

	const cscPath = path.join(
		process.env['WINDIR'] || 'C:\\Windows',
		'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'
	);
	if (!fs.existsSync(cscPath)) {
		throw new Error(`csc.exe not found at ${cscPath}; cannot compile the MSIX CLI launcher stub.`);
	}

	const outputExe = path.join(layoutPath, 'codecli.exe');
	const result = cp.spawnSync(
		cscPath,
		['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${outputExe}`, source],
		{ stdio: ['ignore', 'inherit', 'inherit'] }
	);
	if (result.status !== 0) {
		throw new Error(`csc.exe failed to compile the CLI launcher stub (exit code ${result.status}).`);
	}
	if (!fs.existsSync(outputExe)) {
		throw new Error(`CLI launcher stub was not produced at ${outputExe}.`);
	}
}

/**
 * Extracts the largest embedded PNG frame from an ICO buffer.
 * All VS Code language icons ship a 256x256 PNG-compressed frame, so this needs no
 * image-processing dependency. Returns `undefined` if the ICO has no PNG frame.
 */
function extractIcoPngFrame(ico: Buffer): Buffer | undefined {
	const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const count = ico.readUInt16LE(4);
	let best: Buffer | undefined;
	let bestArea = -1;
	for (let i = 0; i < count; i++) {
		const entry = 6 + i * 16;
		const width = ico[entry] === 0 ? 256 : ico[entry];
		const height = ico[entry + 1] === 0 ? 256 : ico[entry + 1];
		const size = ico.readUInt32LE(entry + 8);
		const offset = ico.readUInt32LE(entry + 12);
		if (ico.subarray(offset, offset + 8).equals(pngSignature)) {
			const area = width * height;
			if (area > bestArea) {
				bestArea = area;
				best = ico.subarray(offset, offset + size);
			}
		}
	}
	return best;
}

/**
 * Writes a `.png` sibling for every file-type-association icon into the layout, extracted
 * from the corresponding `.ico`. The `.png` is what the MSIX manifest references as the
 * association logo (the schema forbids `.ico` logos).
 */
function extractIconLogos(layoutPath: string): void {
	const win32ResourcesDir = path.join(layoutPath, 'resources', 'app', 'resources', 'win32');
	const seen = new Set<string>();
	for (const group of fileTypeAssociationGroups) {
		if (seen.has(group.logo)) {
			continue;
		}
		seen.add(group.logo);
		const icoPath = path.join(win32ResourcesDir, group.logo);
		if (!fs.existsSync(icoPath)) {
			throw new Error(`File type association icon not found in layout: ${icoPath}`);
		}
		const png = extractIcoPngFrame(fs.readFileSync(icoPath));
		if (!png) {
			throw new Error(`No PNG frame found in ${group.logo}; cannot generate MSIX file type association logo.`);
		}
		fs.writeFileSync(path.join(win32ResourcesDir, logoPngName(group.logo)), png);
	}
}

/**
 * Computes the MSIX-compatible version string from the package version.
 * MSIX requires 4-part version: Major.Minor.Build.Revision
 * We map npm version x.y.z to x.y.z.0
 */
function getMsixVersion(): string {
	const rawVersion = pkg.version.replace(/-\w+$/, '');
	const parts = rawVersion.split('.');
	return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
}

/**
 * Resolves the AppxManifest.xml template and substitutes all placeholders
 * with values derived from product.json and build configuration.
 */
function prepareMsixManifest(arch: string): string {
	const quality = (product as ProductWithExtras).quality || 'dev';
	const templatePath = path.join(repoPath, 'resources', 'win32', 'msix', 'AppxManifest.xml');
	let manifest = fs.readFileSync(templatePath, 'utf8');

	const publisher = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
	const processorArch = arch === 'arm64' ? 'arm64' : 'x64';
	const contextMenuId = quality === 'stable' ? 'OpenWithCode' : 'OpenWithCodeInsiders';
	const contextMenuClsid = (product as ProductWithExtras).win32ContextMenu?.[arch]?.clsid ?? '';
	const contextMenuDll = `${quality === 'stable' ? 'code' : 'code_insider'}_explorer_command_${arch}.dll`;

	const replacements: Record<string, string> = {
		'@@MsixPackageName@@': product.win32AppUserModelId,
		'@@MsixPublisher@@': publisher,
		'@@MsixPackageVersion@@': getMsixVersion(),
		'@@MsixProcessorArchitecture@@': processorArch,
		'@@MsixDisplayName@@': product.nameLong,
		'@@MsixDescription@@': (product as ProductWithExtras).win32NameVersion || product.nameLong,
		'@@MsixApplicationId@@': product.win32RegValueName,
		'@@MsixExecutable@@': `${product.nameShort}.exe`,
		'@@MsixUrlProtocol@@': product.urlProtocol,
		'@@MsixCliAlias@@': product.applicationName,
		'@@FileExplorerContextMenuID@@': contextMenuId,
		'@@FileExplorerContextMenuCLSID@@': contextMenuClsid,
		'@@FileExplorerContextMenuDLL@@': contextMenuDll,
		'@@FILE_TYPE_ASSOCIATIONS@@': buildFileTypeAssociations(),
	};

	for (const [placeholder, value] of Object.entries(replacements)) {
		manifest = manifest.replaceAll(placeholder, value);
	}

	// Strip context menu extensions if no CLSID is configured
	if (!contextMenuClsid) {
		manifest = manifest.replace(
			/\s*<!-- @@CONTEXT_MENU_START@@ -->[\s\S]*?<!-- @@CONTEXT_MENU_END@@ -->/,
			''
		);
	} else {
		// Remove the sentinel comments
		manifest = manifest.replace('<!-- @@CONTEXT_MENU_START@@ -->\n', '');
		manifest = manifest.replace('        <!-- @@CONTEXT_MENU_END@@ -->', '');
	}

	return manifest;
}

/**
 * Prepares the MSIX package layout directory by copying the build output
 * and generating the processed AppxManifest.xml.
 */
function prepareMsixLayout(arch: string): task.CallbackTask {
	return (cb) => {
		const sourcePath = buildPath(arch);
		const layoutPath = path.join(msixDir(arch), 'layout');

		if (!fs.existsSync(sourcePath)) {
			return cb(new Error(`Build output not found at ${sourcePath}. Run the build first.`));
		}

		fs.mkdirSync(layoutPath, { recursive: true });

		// Copy the entire build output into the layout directory
		const copyProcess = cp.spawn(
			'robocopy',
			[
				sourcePath,
				layoutPath,
				'/MIR',  // Mirror directory tree
				'/NFL',  // No file list
				'/NDL',  // No directory list
				'/NJH',  // No job header
				'/NJS',  // No job summary
				'/XD', 'appx', 'tools',  // Exclude old appx and tools directories
			],
			{ stdio: ['ignore', 'inherit', 'inherit'] }
		);

		copyProcess.on('error', cb);
		copyProcess.on('exit', (code) => {
			// Robocopy returns 0-7 for success conditions
			if (code !== null && code <= 7) {
				try {
					// Write the processed manifest
					const manifest = prepareMsixManifest(arch);
					fs.writeFileSync(path.join(layoutPath, 'AppxManifest.xml'), manifest);

					// Generate PNG logos for the file type associations (MSIX rejects .ico logos)
					extractIconLogos(layoutPath);

					// Compile the console launcher stub that the CLI app execution alias targets
					compileCliStub(layoutPath);

					// Copy the context menu DLL if available
					const quality = (product as ProductWithExtras).quality || 'dev';
					const dllName = `${quality === 'stable' ? 'code' : 'code_insider'}_explorer_command_${arch}.dll`;
					const dllSource = path.join(repoPath, '.build', 'win32', 'appx', dllName);
					if (fs.existsSync(dllSource)) {
						fs.copyFileSync(dllSource, path.join(layoutPath, dllName));
					}

					cb(null);
				} catch (err) {
					cb(err as Error);
				}
			} else {
				cb(new Error(`robocopy returned exit code: ${code}`));
			}
		});
	};
}

/**
 * Runs makeappx pack to create the .msix package from the layout directory.
 */
function packageMsix(arch: string): task.CallbackTask {
	return (cb) => {
		const layoutPath = path.join(msixDir(arch), 'layout');
		const outputPath = msixDir(arch);
		const quality = (product as ProductWithExtras).quality || 'dev';
		const msixName = quality === 'stable' ? 'code' : quality === 'insider' ? 'code_insider' : `code_${quality}`;
		const msixFile = path.join(outputPath, `${msixName}_${arch}.msix`);

		// Prefer Windows SDK makeappx, fall back to PATH
		const sdkPath = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64';
		const makeappxPath = fs.existsSync(path.join(sdkPath, 'makeappx.exe'))
			? path.join(sdkPath, 'makeappx.exe')
			: 'makeappx';

		const args = ['pack', '/d', layoutPath, '/p', msixFile, '/nv', '/o'];
		console.log(`Running: ${makeappxPath} ${args.join(' ')}`);

		cp.spawn(makeappxPath, args, { stdio: ['ignore', 'inherit', 'inherit'] })
			.on('error', cb)
			.on('exit', (code) => {
				if (code === 0) {
					console.log(`MSIX package created: ${msixFile}`);
					// Clean up the layout directory
					fs.rmSync(layoutPath, { recursive: true, force: true });
					cb(null);
				} else {
					cb(new Error(`makeappx returned exit code: ${code}`));
				}
			});
	};
}

function defineWin32MsixTasks(arch: string) {
	const cleanTask = util.rimraf(msixDir(arch));

	gulp.task(task.define(
		`vscode-win32-${arch}-msix`,
		task.series(cleanTask, prepareMsixLayout(arch), packageMsix(arch))
	));
}

defineWin32MsixTasks('x64');
defineWin32MsixTasks('arm64');
