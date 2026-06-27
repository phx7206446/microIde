function unsupported(methodName) {
  return async function shimmedComputerUseInput() {
    throw new Error(
      `@ant/computer-use-input shim does not implement ${methodName}`,
    );
  };
}

async function zeroPoint() {
  return { x: 0, y: 0 };
}

function noFrontmostApp() {
  return null;
}

module.exports = {
  isSupported: false,
  moveMouse: unsupported("moveMouse"),
  key: unsupported("key"),
  keys: unsupported("keys"),
  click: unsupported("click"),
  doubleClick: unsupported("doubleClick"),
  rightClick: unsupported("rightClick"),
  middleClick: unsupported("middleClick"),
  scroll: unsupported("scroll"),
  drag: unsupported("drag"),
  mouseDown: unsupported("mouseDown"),
  mouseUp: unsupported("mouseUp"),
  mouseButton: unsupported("mouseButton"),
  mouseScroll: unsupported("mouseScroll"),
  typeText: unsupported("typeText"),
  mouseLocation: zeroPoint,
  getMousePosition: zeroPoint,
  getFrontmostApp: async () => null,
  getFrontmostAppInfo: noFrontmostApp,
};
