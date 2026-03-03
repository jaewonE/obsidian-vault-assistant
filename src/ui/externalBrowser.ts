type ElectronShell = {
	openExternal: (url: string) => Promise<void> | void;
};

type ElectronModule = {
	shell?: ElectronShell;
};

type ElectronRequireWindow = Window & {
	require?: (moduleName: string) => unknown;
};

export function openInDefaultBrowser(url: string): void {
	try {
		const maybeRequire = (window as ElectronRequireWindow).require;
		if (typeof maybeRequire === "function") {
			const electron = maybeRequire("electron") as ElectronModule;
			if (electron?.shell && typeof electron.shell.openExternal === "function") {
				void electron.shell.openExternal(url);
				return;
			}
		}
	} catch {
		// Fall back to browser open API.
	}

	window.open(url, "_blank", "noopener,noreferrer");
}
