/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

#define WIN32_LEAN_AND_MEAN

#include "generatedConfig.h"

#include <windows.h>
#include <appmodel.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <shobjidl_core.h>
#include <wrl/client.h>
#include <wrl/implements.h>
#include <wrl/module.h>

#include <string>
#include <vector>

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::InhibitRoOriginateError;
using Microsoft::WRL::Module;
using Microsoft::WRL::ModuleType;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

std::wstring quoteForCommandLineArgument(const std::wstring& argument) {
	if (argument.find_first_of(L" \\\"") == std::wstring::npos) {
		return argument;
	}

	std::wstring result;
	result.push_back(L'"');
	for (size_t index = 0; index < argument.size(); ++index) {
		if (argument[index] == L'\\') {
			const size_t start = index;
			size_t end = start + 1;
			while (end < argument.size() && argument[end] == L'\\') {
				++end;
			}

			size_t backslashCount = end - start;
			if (end == argument.size() || argument[end] == L'"') {
				backslashCount *= 2;
			}
			result.append(backslashCount, L'\\');
			index = end - 1;
		} else if (argument[index] == L'"') {
			result.append(L"\\\"");
		} else {
			result.push_back(argument[index]);
		}
	}
	result.push_back(L'"');

	return result;
}

HRESULT getPackagedExecutablePath(std::wstring& executablePath) {
	UINT32 packagePathLength = 0;
	LONG result = GetCurrentPackagePath(&packagePathLength, nullptr);
	if (result != ERROR_INSUFFICIENT_BUFFER) {
		return HRESULT_FROM_WIN32(result);
	}

	std::vector<wchar_t> packagePath(packagePathLength);
	result = GetCurrentPackagePath(&packagePathLength, packagePath.data());
	if (result != ERROR_SUCCESS) {
		return HRESULT_FROM_WIN32(result);
	}

	executablePath.assign(packagePath.data());
	if (!executablePath.empty() && executablePath.back() != L'\\') {
		executablePath.push_back(L'\\');
	}
	executablePath.append(MSIX_EXECUTABLE_NAME);

	const DWORD attributes = GetFileAttributesW(executablePath.c_str());
	if (attributes == INVALID_FILE_ATTRIBUTES || (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0) {
		return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
	}

	return S_OK;
}

} // namespace

class __declspec(uuid(MSIX_CONTEXT_MENU_CLSID)) ExplorerCommandHandler final
	: public RuntimeClass<RuntimeClassFlags<ClassicCom | InhibitRoOriginateError>, IExplorerCommand> {
public:
	IFACEMETHODIMP GetTitle(IShellItemArray*, PWSTR* name) override {
		if (!name) {
			return E_POINTER;
		}

		return SHStrDupW(MSIX_CONTEXT_MENU_TITLE, name);
	}

	IFACEMETHODIMP GetIcon(IShellItemArray*, PWSTR* icon) override {
		if (!icon) {
			return E_POINTER;
		}

		std::wstring executablePath;
		const HRESULT result = getPackagedExecutablePath(executablePath);
		if (FAILED(result)) {
			*icon = nullptr;
			return result;
		}

		return SHStrDupW(executablePath.c_str(), icon);
	}

	IFACEMETHODIMP GetToolTip(IShellItemArray*, PWSTR* infoTip) override {
		if (!infoTip) {
			return E_POINTER;
		}

		*infoTip = nullptr;
		return E_NOTIMPL;
	}

	IFACEMETHODIMP GetCanonicalName(GUID* commandName) override {
		if (!commandName) {
			return E_POINTER;
		}

		*commandName = GUID_NULL;
		return S_OK;
	}

	IFACEMETHODIMP GetState(IShellItemArray*, BOOL, EXPCMDSTATE* commandState) override {
		if (!commandState) {
			return E_POINTER;
		}

		*commandState = ECS_ENABLED;
		return S_OK;
	}

	IFACEMETHODIMP GetFlags(EXPCMDFLAGS* flags) override {
		if (!flags) {
			return E_POINTER;
		}

		*flags = ECF_DEFAULT;
		return S_OK;
	}

	IFACEMETHODIMP EnumSubCommands(IEnumExplorerCommand** commands) override {
		if (!commands) {
			return E_POINTER;
		}

		*commands = nullptr;
		return E_NOTIMPL;
	}

	IFACEMETHODIMP Invoke(IShellItemArray* items, IBindCtx*) override {
		if (!items) {
			return S_OK;
		}

		std::wstring executablePath;
		HRESULT result = getPackagedExecutablePath(executablePath);
		if (FAILED(result)) {
			return result;
		}

		DWORD count = 0;
		result = items->GetCount(&count);
		if (FAILED(result)) {
			return result;
		}

		for (DWORD index = 0; index < count; ++index) {
			ComPtr<IShellItem> item;
			result = items->GetItemAt(index, &item);
			if (FAILED(result)) {
				continue;
			}

			PWSTR itemPath = nullptr;
			result = item->GetDisplayName(SIGDN_FILESYSPATH, &itemPath);
			if (FAILED(result)) {
				continue;
			}

			const std::wstring arguments = quoteForCommandLineArgument(itemPath);
			CoTaskMemFree(itemPath);

			const HINSTANCE executeResult = ShellExecuteW(
				nullptr,
				L"open",
				executablePath.c_str(),
				arguments.c_str(),
				nullptr,
				SW_SHOW
			);
			if (reinterpret_cast<INT_PTR>(executeResult) <= 32) {
				return E_FAIL;
			}
		}

		return S_OK;
	}
};

CoCreatableClass(ExplorerCommandHandler)
CoCreatableClassWrlCreatorMapInclude(ExplorerCommandHandler)

STDAPI DllGetClassObject(REFCLSID classId, REFIID interfaceId, LPVOID* object) {
	if (!object) {
		return E_POINTER;
	}

	*object = nullptr;
	return Module<ModuleType::InProc>::GetModule().GetClassObject(classId, interfaceId, object);
}

STDAPI DllCanUnloadNow() {
	return Module<ModuleType::InProc>::GetModule().GetObjectCount() == 0 ? S_OK : S_FALSE;
}

STDAPI DllGetActivationFactory(HSTRING activatableClassId, IActivationFactory** factory) {
	return Module<ModuleType::InProc>::GetModule().GetActivationFactory(activatableClassId, factory);
}
