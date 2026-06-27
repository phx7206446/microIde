function unsupported(methodName) {
  return async function shimmedComputerUseSwift() {
    throw new Error(
      `@ant/computer-use-swift shim does not implement ${methodName}`,
    );
  };
}

const DEFAULT_DISPLAY = Object.freeze({
  id: 0,
  width: 1440,
  height: 900,
  scaleFactor: 1,
  originX: 0,
  originY: 0,
});

const display = {
  getSize(displayId) {
    return {
      ...DEFAULT_DISPLAY,
      id: typeof displayId === "number" ? displayId : DEFAULT_DISPLAY.id,
    };
  },
  listAll() {
    return [{ ...DEFAULT_DISPLAY }];
  },
};

const apps = {
  listInstalled: async () => [],
  listRunning: async () => [],
  prepareDisplay: async () => ({ hidden: [], activated: undefined }),
  previewHideSet: async () => [],
  findWindowDisplays: async () => [],
  appUnderPoint: async () => null,
  iconDataUrl: () => undefined,
  open: unsupported("apps.open"),
  hide: async () => {},
  unhide: async () => {},
};

const screenshot = {
  captureExcluding: unsupported("screenshot.captureExcluding"),
  captureRegion: unsupported("screenshot.captureRegion"),
};

const api = {
  _drainMainRunLoop() {},
  hotkey: {
    registerEscape: () => false,
    unregister() {},
    notifyExpectedEscape() {},
  },
  tcc: {
    checkAccessibility: () => false,
    checkScreenRecording: () => false,
  },
  display,
  screenshot,
  apps,
  async resolvePrepareCapture(allowedBundleIds, _hostBundleId, _quality, _width, _height, displayId) {
    return {
      displayId: typeof displayId === "number" ? displayId : DEFAULT_DISPLAY.id,
      allowedBundleIds: Array.isArray(allowedBundleIds) ? [...allowedBundleIds] : [],
      hiddenBundleIds: [],
    };
  },
  captureExcluding: screenshot.captureExcluding,
  captureRegion: screenshot.captureRegion,
  prepareDisplay: apps.prepareDisplay,
  hideApps: apps.hide,
  unhideApps: apps.unhide,
  activateApp: apps.open,
};

module.exports = api;
