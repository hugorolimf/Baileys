declare module 'qrcode' {
  export function toDataURL(
    text: string,
    opts?: object
  ): Promise<string>;
}
