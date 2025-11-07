declare module 'qrcode-terminal' {
  interface Options {
    small?: boolean
  }
  export function generate(text: string, opts?: Options, cb?: (s: string) => void): void
  const _default: { generate: typeof generate }
  export default _default
}
