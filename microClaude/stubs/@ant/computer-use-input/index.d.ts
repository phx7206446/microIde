export interface Point {
  x: number;
  y: number;
}

export interface FrontmostAppInfo {
  bundleId?: string;
  appName?: string;
  displayName?: string;
  localizedName?: string;
  pid?: number;
}

export type MouseButton = "left" | "right" | "middle";
export type MouseButtonAction = "press" | "release" | "click";
export type ScrollAxis = "vertical" | "horizontal";

export interface ComputerUseInputAPI {
  moveMouse(x: number, y: number, animated?: boolean): Promise<void>;
  key(key: string, action?: "press" | "release" | "tap"): Promise<void>;
  keys(keys: string[]): Promise<void>;
  click(button?: string): Promise<void>;
  doubleClick(button?: string): Promise<void>;
  rightClick(): Promise<void>;
  middleClick(): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number): Promise<void>;
  mouseDown(button?: string): Promise<void>;
  mouseUp(button?: string): Promise<void>;
  mouseButton(
    button: MouseButton,
    action: MouseButtonAction,
    count?: 1 | 2 | 3,
  ): Promise<void>;
  mouseScroll(amount: number, axis: ScrollAxis): Promise<void>;
  typeText(text: string): Promise<void>;
  mouseLocation(): Promise<Point>;
  getMousePosition(): Promise<Point>;
  getFrontmostApp(): Promise<FrontmostAppInfo | null>;
  getFrontmostAppInfo(): FrontmostAppInfo | null;
}

export type ComputerUseInput =
  | ({ isSupported: false })
  | ({ isSupported: true } & ComputerUseInputAPI);

declare const computerUseInput: ComputerUseInput;

export default computerUseInput;
