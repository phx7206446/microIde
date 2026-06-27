export type RGBColor = {
  r: number
  g: number
  b: number
}

export type SpinnerMode =
  | 'requesting'
  | 'tool-use'
  | 'tool-input'
  | 'responding'
  | 'thinking'
