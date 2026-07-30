/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Console launcher stub for the MSIX package's command-line alias.
//
// An MSIX app execution alias must point at a package executable and launches it with the user's
// arguments verbatim - it cannot inject environment variables or fixed leading arguments. Pointing
// the alias directly at the GUI `Code.exe` therefore breaks the command-line contract: GUI-subsystem
// processes have no console stdout and no CLI argument handling, so `code --version`,
// `--list-extensions`, `--wait`, stdin and exit codes do not work.
//
// This stub is a console-subsystem executable that reproduces what the desktop `bin\<app>.cmd`
// launcher does: it runs `Code.exe resources\app\out\cli.js <args>` with `ELECTRON_RUN_AS_NODE=1`,
// inheriting the parent console so stdout/stderr/stdin flow through, blocking until the CLI exits and
// propagating its exit code. The MSIX alias points here instead of at the GUI executable.

using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;

internal static class CodeCli
{
	private static int Main(string[] args)
	{
		// This stub ships at the package root, next to `Code.exe`.
		string root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
		string codeExe = Path.Combine(root, "Code.exe");
		string cliJs = Path.Combine(root, "resources", "app", "out", "cli.js");

		if (!File.Exists(codeExe) || !File.Exists(cliJs))
		{
			Console.Error.WriteLine("Unable to locate the Visual Studio Code command-line entry point.");
			return 1;
		}

		var startInfo = new ProcessStartInfo
		{
			FileName = codeExe,
			// UseShellExecute must be false so the child inherits our console handles
			// (for stdout/stderr/stdin) and honors the environment variable below.
			UseShellExecute = false,
			Arguments = BuildArguments(cliJs, args),
		};
		startInfo.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";

		try
		{
			using (Process process = Process.Start(startInfo))
			{
				process.WaitForExit();
				return process.ExitCode;
			}
		}
		catch (Exception ex)
		{
			Console.Error.WriteLine("Failed to start Visual Studio Code: " + ex.Message);
			return 1;
		}
	}

	// Serializes the cli.js path plus the forwarded arguments into a single command line using the
	// quoting rules that CommandLineToArgvW (and the CRT) expect, so paths with spaces or quotes and
	// trailing backslashes round-trip correctly.
	private static string BuildArguments(string cliJs, string[] args)
	{
		var builder = new StringBuilder();
		AppendArgument(builder, cliJs);
		foreach (string arg in args)
		{
			builder.Append(' ');
			AppendArgument(builder, arg);
		}
		return builder.ToString();
	}

	private static void AppendArgument(StringBuilder builder, string argument)
	{
		if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
		{
			builder.Append(argument);
			return;
		}

		builder.Append('"');
		for (int i = 0; ; i++)
		{
			int backslashes = 0;
			while (i < argument.Length && argument[i] == '\\')
			{
				i++;
				backslashes++;
			}

			if (i == argument.Length)
			{
				// Escape all backslashes, but let the terminating double quote be interpreted
				// as a metacharacter (do not double them).
				builder.Append('\\', backslashes * 2);
				break;
			}

			if (argument[i] == '"')
			{
				// Escape all backslashes and the following double quote.
				builder.Append('\\', backslashes * 2 + 1);
				builder.Append('"');
			}
			else
			{
				// Backslashes are not special here.
				builder.Append('\\', backslashes);
				builder.Append(argument[i]);
			}
		}
		builder.Append('"');
	}
}
