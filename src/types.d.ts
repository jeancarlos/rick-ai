declare module "qrcode-terminal" {
  const qrcode: {
    generate(
      text: string,
      options?: { small?: boolean },
      callback?: (qrcode: string) => void
    ): void;
  };
  export default qrcode;
}
