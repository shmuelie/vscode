/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import fs from 'fs';

/**
 * Returns the sha1 commit version of a repository or undefined in case of failure.
 */
export function getVersion(repo: string): string | undefined {
	let git = path.join(repo, '.git');

	// Worktrees (and submodules) use a `.git` *file* that points at the real git
	// directory via `gitdir: <path>` instead of a `.git` directory. Resolve it so
	// that reading HEAD works from a worktree checkout too, otherwise the commit
	// cannot be determined and the packaged build ends up without a `commit`.
	try {
		if (fs.statSync(git).isFile()) {
			const gitDirMatch = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
			if (!gitDirMatch) {
				return undefined;
			}
			git = path.resolve(repo, gitDirMatch[1].trim());
		}
	} catch (e) {
		return undefined;
	}

	const headPath = path.join(git, 'HEAD');
	let head: string;

	try {
		head = fs.readFileSync(headPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	if (/^[0-9a-f]{40}$/i.test(head)) {
		return head;
	}

	const refMatch = /^ref: (.*)$/.exec(head);

	if (!refMatch) {
		return undefined;
	}

	const ref = refMatch[1];

	// In a worktree, per-worktree files (e.g. HEAD) live in the worktree git dir,
	// but refs are stored in the shared common git dir referenced by `commondir`.
	let commonDir = git;

	try {
		const commonDirRaw = fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim();
		commonDir = path.resolve(git, commonDirRaw);
	} catch (e) {
		// noop: not a worktree, the git dir is the common dir
	}

	// Loose ref: try the (worktree) git dir first, then the common dir.
	for (const base of commonDir === git ? [git] : [git, commonDir]) {
		try {
			return fs.readFileSync(path.join(base, ref), 'utf8').trim();
		} catch (e) {
			// noop: try the next location
		}
	}

	const packedRefsPath = path.join(commonDir, 'packed-refs');
	let refsRaw: string;

	try {
		refsRaw = fs.readFileSync(packedRefsPath, 'utf8').trim();
	} catch (e) {
		return undefined;
	}

	const refsRegex = /^([0-9a-f]{40})\s+(.+)$/gm;
	let refsMatch: RegExpExecArray | null;
	const refs: { [ref: string]: string } = {};

	while (refsMatch = refsRegex.exec(refsRaw)) {
		refs[refsMatch[2]] = refsMatch[1];
	}

	return refs[ref];
}
