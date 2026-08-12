/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pkg from '../package.json' with { type: 'json' };
import product from '../product.json' with { type: 'json' };
import * as task from './lib/gulp/task.ts';
import { getMsixContextMenuConfiguration, type IMsixContextMenuConfiguration } from './lib/msixContextMenu.ts';
import * as util from './lib/util.ts';

const repoPath = path.dirname(import.meta.dirname);
const buildPath = (arch: string) => path.join(path.dirname(repoPath), `VSCode-win32-${arch}`);
const msixDir = (arch: string) => path.join(repoPath, '.build', `win32-${arch}`, 'msix');

type ProductWithExtras = typeof product & {
	quality?: string;
	win32NameVersion?: string;
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

function escapeCppString(value: string): string {
	return value
		.replaceAll('\\', '\\\\')
		.replaceAll('"', '\\"')
		.replaceAll('\r', '\\r')
		.replaceAll('\n', '\\n');
}

function findVisualStudioInstallation(arch: string): string {
	const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
	const vswherePath = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
	if (!fs.existsSync(vswherePath)) {
		throw new Error(`vswhere.exe not found at ${vswherePath}; cannot compile the MSIX context menu DLL.`);
	}

	const requiredComponent = arch === 'arm64'
		? 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
		: 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64';
	const result = cp.spawnSync(
		vswherePath,
		['-latest', '-products', '*', '-requires', requiredComponent, '-property', 'installationPath'],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0 || !result.stdout.trim()) {
		throw new Error(`A Visual Studio installation with ${requiredComponent} was not found.`);
	}

	return result.stdout.trim();
}

function guidToLittleEndianBytes(guid: string): Buffer {
	const parts = guid.split('-');
	return Buffer.from([
		...Buffer.from(parts[0], 'hex').reverse(),
		...Buffer.from(parts[1], 'hex').reverse(),
		...Buffer.from(parts[2], 'hex').reverse(),
		...Buffer.from(parts[3], 'hex'),
		...Buffer.from(parts[4], 'hex'),
	]);
}

function getPeMachine(dllPath: string): number {
	const dll = fs.readFileSync(dllPath);
	const peOffset = dll.readUInt32LE(0x3c);
	if (dll.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
		throw new Error(`MSIX context menu DLL is not a valid PE file: ${dllPath}`);
	}

	return dll.readUInt16LE(peOffset + 4);
}

function validateMsixContextMenuDll(
	dllPath: string,
	arch: string,
	configuration: IMsixContextMenuConfiguration,
	buildDirectory: string
): void {
	if (!fs.existsSync(dllPath)) {
		throw new Error(`MSIX context menu DLL was not produced at ${dllPath}.`);
	}

	const expectedMachine = arch === 'arm64' ? 0xaa64 : 0x8664;
	const actualMachine = getPeMachine(dllPath);
	if (actualMachine !== expectedMachine) {
		throw new Error(
			`MSIX context menu DLL has PE machine 0x${actualMachine.toString(16)}, expected 0x${expectedMachine.toString(16)} for ${arch}.`
		);
	}

	const dll = fs.readFileSync(dllPath);
	if (dll.indexOf(guidToLittleEndianBytes(configuration.clsid)) === -1) {
		throw new Error(`MSIX context menu DLL does not embed CLSID ${configuration.clsid}.`);
	}

	const exports = fs.readFileSync(path.join(buildDirectory, 'exports.txt'), 'utf8');
	for (const requiredExport of ['DllCanUnloadNow', 'DllGetActivationFactory', 'DllGetClassObject']) {
		if (!exports.includes(requiredExport)) {
			throw new Error(`MSIX context menu DLL is missing required export ${requiredExport}.`);
		}
	}

	const dependents = fs.readFileSync(path.join(buildDirectory, 'dependents.txt'), 'utf8');
	if (/\b(?:(?:msvcp|vcruntime)\d+[^ \r\n]*|ucrtbase|api-ms-win-crt-[^ \r\n]+)\.dll\b/i.test(dependents)) {
		throw new Error(`MSIX context menu DLL dynamically imports the MSVC runtime:\n${dependents}`);
	}

	const imports = fs.readFileSync(path.join(buildDirectory, 'imports.txt'), 'utf8');
	if (!imports.includes('GetCurrentPackagePath')) {
		throw new Error('MSIX context menu DLL does not import GetCurrentPackagePath.');
	}
}

function compileMsixContextMenuDll(
	layoutPath: string,
	arch: string,
	configuration: IMsixContextMenuConfiguration
): void {
	const sourceDirectory = path.join(repoPath, 'build', 'win32', 'msix', 'explorer-command');
	const sourcePath = path.join(sourceDirectory, 'explorerCommand.cpp');
	const moduleDefinitionPath = path.join(sourceDirectory, 'explorerCommand.def');
	if (!fs.existsSync(sourcePath) || !fs.existsSync(moduleDefinitionPath)) {
		throw new Error(`MSIX context menu source files were not found under ${sourceDirectory}.`);
	}

	const buildDirectory = path.join(msixDir(arch), 'explorer-command');
	fs.rmSync(buildDirectory, { recursive: true, force: true });
	fs.mkdirSync(buildDirectory, { recursive: true });

	const generatedHeaderPath = path.join(buildDirectory, 'generatedConfig.h');
	fs.writeFileSync(generatedHeaderPath, [
		'#pragma once',
		`#define MSIX_CONTEXT_MENU_CLSID "${escapeCppString(configuration.clsid)}"`,
		`#define MSIX_CONTEXT_MENU_TITLE L"${escapeCppString(configuration.title)}"`,
		`#define MSIX_EXECUTABLE_NAME L"${escapeCppString(configuration.executableName)}"`,
		'',
	].join('\r\n'));

	const visualStudioPath = findVisualStudioInstallation(arch);
	const vsDevCmdPath = path.join(visualStudioPath, 'Common7', 'Tools', 'VsDevCmd.bat');
	if (!fs.existsSync(vsDevCmdPath)) {
		throw new Error(`VsDevCmd.bat not found at ${vsDevCmdPath}.`);
	}

	const outputPath = path.join(layoutPath, configuration.dllName);
	const targetArch = arch === 'arm64' ? 'arm64' : 'x64';
	const hostArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : undefined;
	if (!hostArch) {
		throw new Error(`Unsupported MSIX context menu build host architecture: ${process.arch}`);
	}
	const machine = arch === 'arm64' ? 'ARM64' : 'X64';
	const commandPath = path.join(buildDirectory, 'build.cmd');
	const quote = (value: string): string => `"${value}"`;
	fs.writeFileSync(commandPath, [
		'@echo off',
		`cd /d ${quote(buildDirectory)}`,
		`set "PATH=${path.dirname(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'))};%PATH%"`,
		`call ${quote(vsDevCmdPath)} -no_logo -arch=${targetArch} -host_arch=${hostArch}`,
		'if errorlevel 1 exit /b %errorlevel%',
		[
			'cl.exe',
			'/nologo',
			'/LD',
			'/MT',
			'/O2',
			'/Oi',
			'/GL',
			'/Gy',
			'/guard:cf',
			'/EHsc',
			'/std:c++17',
			'/permissive-',
			'/utf-8',
			'/W4',
			'/WX',
			'/wd4324',
			'/DUNICODE',
			'/D_UNICODE',
			`/I${quote(buildDirectory)}`,
			`/Fo${quote(path.join(buildDirectory, 'explorerCommand.obj'))}`,
			quote(sourcePath),
			'/link',
			'/LTCG',
			'/OPT:REF',
			'/OPT:ICF',
			'/guard:cf',
			`/MACHINE:${machine}`,
			`/DEF:${quote(moduleDefinitionPath)}`,
			`/OUT:${quote(outputPath)}`,
			`/IMPLIB:${quote(path.join(buildDirectory, 'explorerCommand.lib'))}`,
			`/PDB:${quote(path.join(buildDirectory, 'explorerCommand.pdb'))}`,
			'shlwapi.lib',
			'shell32.lib',
			'ole32.lib',
			'runtimeobject.lib',
		].join(' '),
		'if errorlevel 1 exit /b %errorlevel%',
		`dumpbin.exe /exports ${quote(outputPath)} > ${quote(path.join(buildDirectory, 'exports.txt'))}`,
		'if errorlevel 1 exit /b %errorlevel%',
		`dumpbin.exe /dependents ${quote(outputPath)} > ${quote(path.join(buildDirectory, 'dependents.txt'))}`,
		'if errorlevel 1 exit /b %errorlevel%',
		`dumpbin.exe /imports ${quote(outputPath)} > ${quote(path.join(buildDirectory, 'imports.txt'))}`,
		'exit /b %errorlevel%',
	].join('\r\n'));

	const result = cp.spawnSync(process.env['ComSpec'] || 'cmd.exe', ['/d', '/c', commandPath], {
		cwd: buildDirectory,
		stdio: ['ignore', 'inherit', 'inherit'],
	});
	if (result.status !== 0) {
		throw new Error(`Failed to compile the MSIX context menu DLL (exit code ${result.status}).`);
	}

	validateMsixContextMenuDll(outputPath, arch, configuration, buildDirectory);
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
 * MSIX requires a 4-part version: Major.Minor.Build.Revision.
 *
 * Windows treats a package whose version is strictly greater than the installed
 * one as an in-place upgrade, which preserves taskbar pins, Start tiles and the
 * running registration. If two builds of the same VS Code version both produced
 * `x.y.z.0` they would collide, and `Add-AppxPackage` would refuse the update
 * ("same version, different content", 0x80073CFB), forcing an uninstall +
 * reinstall that drops the taskbar pin.
 *
 * To keep every local build strictly newer than the last while staying within
 * the MSIX per-part limit (0-65535), derive Build/Revision from the current UTC
 * build time: Build = whole days since 2000-01-01 (monotonic across days, fits
 * until year ~2179), Revision = two-second ticks since UTC midnight (0-43199, so
 * distinct builds more than ~2s apart never collide). Major.Minor come from the
 * product version so a real version bump still compares greater.
 */
function getMsixVersion(): string {
	const rawVersion = pkg.version.replace(/-\w+$/, '');
	const parts = rawVersion.split('.');
	const now = new Date();
	const epochUtc = Date.UTC(2000, 0, 1);
	const daysSinceEpoch = Math.floor((now.getTime() - epochUtc) / 86_400_000);
	const secondsSinceMidnight = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
	const revision = Math.floor(secondsSinceMidnight / 2);
	return `${parts[0]}.${parts[1]}.${daysSinceEpoch}.${revision}`;
}

/**
 * Resolves the AppxManifest.xml template and substitutes all placeholders
 * with values derived from product.json and build configuration.
 */
function prepareMsixManifest(arch: string): string {
	const templatePath = path.join(repoPath, 'resources', 'win32', 'msix', 'AppxManifest.xml');
	let manifest = fs.readFileSync(templatePath, 'utf8');

	const publisher = 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US';
	const processorArch = arch === 'arm64' ? 'arm64' : 'x64';
	const contextMenu = getMsixContextMenuConfiguration(product, arch);

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
		'@@FileExplorerContextMenuID@@': contextMenu?.id ?? '',
		'@@FileExplorerContextMenuCLSID@@': contextMenu?.clsid ?? '',
		'@@FileExplorerContextMenuDLL@@': contextMenu?.dllName ?? '',
		'@@FILE_TYPE_ASSOCIATIONS@@': buildFileTypeAssociations(),
	};

	for (const [placeholder, value] of Object.entries(replacements)) {
		manifest = manifest.replaceAll(placeholder, value);
	}

	// Strip context menu extensions if no CLSID is configured
	if (!contextMenu) {
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
	return ((cb: (err?: Error) => void) => {
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

		copyProcess.on('error', err => cb(err));
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

					// Compile the product-specific, statically linked MSIX context menu DLL
					const contextMenu = getMsixContextMenuConfiguration(product, arch);
					if (contextMenu) {
						compileMsixContextMenuDll(layoutPath, arch, contextMenu);
					}

					cb();
				} catch (err) {
					cb(err as Error);
				}
			} else {
				cb(new Error(`robocopy returned exit code: ${code}`));
			}
		});
	}) as task.CallbackTask;
}

/**
 * Runs makeappx pack to create the .msix package from the layout directory.
 */
function packageMsix(arch: string): task.CallbackTask {
	return ((cb: (err?: Error) => void) => {
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
			.on('error', err => cb(err))
			.on('exit', (code) => {
				if (code === 0) {
					console.log(`MSIX package created: ${msixFile}`);
					// Clean up the layout directory
					fs.rmSync(layoutPath, { recursive: true, force: true });
					cb();
				} else {
					cb(new Error(`makeappx returned exit code: ${code}`));
				}
			});
	}) as task.CallbackTask;
}

function defineWin32MsixTasks(arch: string) {
	const cleanTask = util.rimraf(msixDir(arch));

	task.task(task.define(
		`vscode-win32-${arch}-msix`,
		task.series(cleanTask, prepareMsixLayout(arch), packageMsix(arch))
	));
}

defineWin32MsixTasks('x64');
defineWin32MsixTasks('arm64');
