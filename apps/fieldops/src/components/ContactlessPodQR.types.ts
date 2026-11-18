export type ContactlessPodQRProps = {
  /** Absolute URL for completing the signature. */
  signingUrl: string;
  /** Edge length of the QR code in dp. Defaults to 200. */
  size?: number;
  testID?: string;
  onCopyLink?: (url: string) => void;
};
